#include "app.h"
#include <bcrypt.h>
#include <wincrypt.h>
#include <iphlpapi.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include "web_assets.h"
typedef struct { SOCKET socket; } connection;
static int send_all(SOCKET s,const void *data,size_t size) {
    const char *p=data;
    while(size && WaitForSingleObject(g.stop,0)!=WAIT_OBJECT_0) {
        int n=send(s,p,(int)size,0);if(n<=0)return 0;p+=n;size-=(size_t)n;
    }
    return size==0;
}
static int ws_send(SOCKET s,unsigned opcode,const void *data,unsigned len) {
    unsigned char h[4]={ (unsigned char)(0x80|opcode),0,0,0 };unsigned n=2;
    if(len<126)h[1]=(unsigned char)len;
    else {h[1]=126;h[2]=(unsigned char)(len>>8);h[3]=(unsigned char)len;n=4;}
    return send_all(s,h,n)&&send_all(s,data,len);
}
static int header(const char *request,const char *key,char *out,size_t cap) {
    const char *p=strstr(request,"\r\n");size_t k=strlen(key);
    while(p && p[2] && p[2]!='\r') {
        p+=2;const char *end=strstr(p,"\r\n");if(!end)return 0;
        if((size_t)(end-p)>k && !_strnicmp(p,key,k) && p[k]==':') {
            p+=k+1;while(*p==' '||*p=='\t')++p;
            size_t n=(size_t)(end-p);if(n>=cap)return 0;memcpy(out,p,n);out[n]=0;return 1;
        }
        p=end;
    }
    return 0;
}
static int local_client(SOCKET s) {
    struct sockaddr_in peer={0},local={0};int a=sizeof(peer),b=sizeof(local);
    if(getpeername(s,(struct sockaddr*)&peer,&a)||getsockname(s,(struct sockaddr*)&local,&b))return 0;
    return peer.sin_family==AF_INET&&((ntohl(peer.sin_addr.s_addr)>>24)==127||
           peer.sin_addr.s_addr==local.sin_addr.s_addr);
}
static void http_reply(SOCKET s,int status,const char *type,const unsigned char *body,size_t size) {
    char h[1024];
    int n=snprintf(h,sizeof(h),"HTTP/1.1 %d %s\r\nContent-Type: %s\r\nContent-Length: %zu\r\n"
        "Connection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n"
        "Referrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'self'; connect-src 'self' ws:; "
        "style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; frame-ancestors 'none'\r\n\r\n",
        status,status==200?"OK":"Not Found",type,size);
    send_all(s,h,(size_t)n);send_all(s,body,size);
}
static int handshake(SOCKET s,const char *request) {
    char key[128],upgrade[64],version[32],host[256],origin[320];
    if(!header(request,"Sec-WebSocket-Key",key,sizeof(key))||strlen(key)!=24||
       !header(request,"Upgrade",upgrade,sizeof(upgrade))||_stricmp(upgrade,"websocket")||
       !header(request,"Sec-WebSocket-Version",version,sizeof(version))||strcmp(version,"13"))return 0;
    if(header(request,"Origin",origin,sizeof(origin))) {
        char expected[320];if(!header(request,"Host",host,sizeof(host)))return 0;
        snprintf(expected,sizeof(expected),"http://%s",host);if(_stricmp(expected,origin))return 0;
    }
    char joined[256];snprintf(joined,sizeof(joined),"%s258EAFA5-E914-47DA-95CA-C5AB0DC85B11",key);
    BCRYPT_ALG_HANDLE alg=NULL;unsigned char digest[20];
    NTSTATUS hr=BCryptOpenAlgorithmProvider(&alg,BCRYPT_SHA1_ALGORITHM,NULL,0);
    if(hr<0)return 0;
    hr=BCryptHash(alg,NULL,0,(PUCHAR)joined,(ULONG)strlen(joined),digest,20);
    BCryptCloseAlgorithmProvider(alg,0);if(hr<0)return 0;
    char accept[64];DWORD size=sizeof(accept);
    if(!CryptBinaryToStringA(digest,20,CRYPT_STRING_BASE64|CRYPT_STRING_NOCRLF,accept,&size))return 0;
    char h[320];int n=snprintf(h,sizeof(h),"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
        "Connection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n",accept);
    return send_all(s,h,(size_t)n);
}
static double number(const char *json,const char *name,double fallback) {
    char pattern[64];snprintf(pattern,sizeof(pattern),"\"%s\":",name);
    const char *p=strstr(json,pattern);if(!p)return fallback;
    char *end=NULL;double x=strtod(p+strlen(pattern),&end);
    return end!=p+strlen(pattern) && isfinite(x)?x:fallback;
}
static double bound(double v,double a,double b){return v<a?a:v>b?b:v;}
static int ws_message(SOCKET s,unsigned opcode,char *data,unsigned len,unsigned peer) {
    if(opcode==8){ws_send(s,8,data,len);return 0;}
    if(opcode==9)return ws_send(s,10,data,len);
    if(opcode==10)return 1;
    if(opcode!=1)return 0;
    data[len]=0;
    if(strstr(data,"\"sync\"")) {
        double received=ls_now(),t0=number(data,"t0",-1);
        if(t0<0)return 0;
        char response[256];int n=snprintf(response,sizeof(response),
            "{\"type\":\"sync\",\"t0\":%.6f,\"t1\":%.6f,\"t2\":%.6f}",t0,received,ls_now());
        return ws_send(s,1,response,(unsigned)n);
    }
    if(strstr(data,"\"report\"")) {
        double now=ls_now();int ready=number(data,"ready",0)>0;
        EnterCriticalSection(&g.lock);ls_peer *p=&g.peers[peer];
        if(!ready || !p->ready)p->since=now;
        p->ready=ready;p->updated=now;
        p->required=bound(number(data,"required",600),0,3000);
        p->rtt=bound(number(data,"rtt",0),0,3000);p->jitter=bound(number(data,"jitter",0),0,1000);
        p->output=bound(number(data,"output",0),0,2000);
        p->late=(unsigned)bound(number(data,"late",0),0,10000000);
        LeaveCriticalSection(&g.lock);
    }
    return 1;
}
/* Bounded incremental parser: handles split/coalesced TCP frames, requires masks. */
static int ws_parse(SOCKET s,unsigned char *buf,unsigned *used,unsigned peer) {
    unsigned consumed=0;
    while(*used-consumed>=2) {
        unsigned char *p=buf+consumed;unsigned opcode=p[0]&15;
        if(!(p[0]&128)||(p[0]&112)||!(p[1]&128))return 0;
        unsigned n=p[1]&127,h=2;
        if(n==127)return 0;
        if(n==126){if(*used-consumed<4)break;n=((unsigned)p[2]<<8)|p[3];h=4;}
        if(n>2048 || ((opcode&8)&&n>125))return 0;
        if(*used-consumed<h+4+n)break;
        char data[2049];for(unsigned i=0;i<n;++i)data[i]=(char)(p[h+4+i]^p[h+(i&3)]);
        if(!ws_message(s,opcode,data,n,peer))return 0;
        consumed+=h+4+n;
    }
    if(consumed){memmove(buf,buf+consumed,*used-consumed);*used-=consumed;}
    return 1;
}
static void websocket(SOCKET s,const char *request,const unsigned char *extra,unsigned extra_len) {
    unsigned peer=LS_MAX_CLIENTS;uint64_t seq;
    EnterCriticalSection(&g.lock);
    for(unsigned i=0;i<LS_MAX_CLIENTS;++i)if(!g.peers[i].active){peer=i;break;}
    if(peer<LS_MAX_CLIENTS){memset(&g.peers[peer],0,sizeof(ls_peer));g.peers[peer].active=1;
        g.peers[peer].since=g.peers[peer].updated=ls_now();}
    seq=g.next_seq;LeaveCriticalSection(&g.lock);
    if(peer==LS_MAX_CLIENTS)return;
    if(!handshake(s,request))goto done;
    char hello[160];int hn=snprintf(hello,sizeof(hello),
        "{\"type\":\"hello\",\"rate\":48000,\"channels\":2,\"version\":1,\"test\":%s}",g.test_tone?"true":"false");
    if(!ws_send(s,1,hello,(unsigned)hn))goto done;
    unsigned char receive[4096];unsigned used=0;
    if(extra_len){if(extra_len>sizeof(receive))goto done;memcpy(receive,extra,extra_len);used=extra_len;}
    double last_status=0,last_receive=ls_now();unsigned epoch=0;
    while(WaitForSingleObject(g.stop,2)!=WAIT_OBJECT_0) {
        if(!ws_parse(s,receive,&used,peer))break;
        fd_set readset;FD_ZERO(&readset);FD_SET(s,&readset);struct timeval tv={0,0};
        int ready=select(0,&readset,NULL,NULL,&tv);if(ready==SOCKET_ERROR)break;
        if(ready) {
            int n=recv(s,(char*)receive+used,(int)(sizeof(receive)-used),0);
            if(n<=0)break;used+=(unsigned)n;last_receive=ls_now();
            if(!ws_parse(s,receive,&used,peer))break;
        }
        double now=ls_now();if(now-last_receive>15000)break;
        EnterCriticalSection(&g.lock);unsigned current_epoch=g.epoch;
        uint64_t first=g.first_seq;unsigned buffer_ms=g.timeline.buffer_ms;LeaveCriticalSection(&g.lock);
        if(epoch!=current_epoch){
            if(epoch||seq<first)seq=first;
            char reset[160];int n=snprintf(reset,sizeof(reset),"{\"type\":\"reset\",\"epoch\":%u,\"latency\":%u,\"speed\":1}",current_epoch,buffer_ms);
            if(!ws_send(s,1,reset,(unsigned)n))goto done;
            epoch=current_epoch;
        }
        for(unsigned i=0;i<24;++i) {
            ls_packet p;if(!ls_packet_read(seq,&p)) {
                EnterCriticalSection(&g.lock);uint64_t latest=g.next_seq;LeaveCriticalSection(&g.lock);
                if(latest>seq+LS_RING)goto done;break;
            }
            if(p.epoch!=epoch)break;
            /* A stalled socket cannot hold live playback hostage. Reconnect at current time. */
            if(now-p.captured>2000)goto done;
            unsigned char wire[40+LS_FRAMES*4];unsigned n=ls_pack(&p,wire,sizeof(wire));
            if(!n||!ws_send(s,2,wire,n))goto done;++seq;
        }
        if(now-last_status>1000) {
            char status[512];EnterCriticalSection(&g.lock);
            double latency=ls_delay(&g.timeline,now);unsigned clients=0;
            for(unsigned i=0;i<LS_MAX_CLIENTS;++i)clients+=g.peers[i].active?1:0;
            int n=snprintf(status,sizeof(status),"{\"type\":\"status\",\"latency\":%.2f,\"listeners\":%u,"
                "\"capturing\":%ld,\"rendering\":%ld,\"peak\":%.5f,\"captureGaps\":%u,\"bufferMode\":\"manual-fixed\",\"speed\":1}",
                latency,clients,g.capturing,g.rendering,g.capture_peak,g.capture_gaps);
            LeaveCriticalSection(&g.lock);
            if(!ws_send(s,1,status,(unsigned)n))break;last_status=now;
        }
    }
done:
    EnterCriticalSection(&g.lock);memset(&g.peers[peer],0,sizeof(ls_peer));LeaveCriticalSection(&g.lock);
}
static DWORD WINAPI serve(void *arg) {
    connection *c=arg;SOCKET s=c->socket;free(c);
    DWORD timeout=2500;setsockopt(s,SOL_SOCKET,SO_RCVTIMEO,(char*)&timeout,sizeof(timeout));
    timeout=200;setsockopt(s,SOL_SOCKET,SO_SNDTIMEO,(char*)&timeout,sizeof(timeout));
    BOOL yes=TRUE;setsockopt(s,IPPROTO_TCP,TCP_NODELAY,(char*)&yes,sizeof(yes));
    char request[12288];unsigned used=0;char *end=NULL;
    while(used<sizeof(request)-1) {
        int n=recv(s,request+used,(int)(sizeof(request)-1-used),0);if(n<=0)goto done;
        used+=(unsigned)n;request[used]=0;end=strstr(request,"\r\n\r\n");if(end)break;
    }
    if(!end)goto done;
    char method[16],path[2048],protocol[32];
    if(sscanf(request,"%15s %2047s %31s",method,path,protocol)!=3 || strcmp(method,"GET") || strcmp(protocol,"HTTP/1.1"))goto done;
    char *q=strchr(path,'?');if(q)*q=0;
    if(!strcmp(path,"/audio")) {
        unsigned h=(unsigned)(end-request)+4;websocket(s,request,(unsigned char*)request+h,used-h);
    } else if(!strcmp(path,"/"))http_reply(s,200,"text/html; charset=utf-8",web_index_html,web_index_html_len);
    else if(!strcmp(path,"/client.js"))http_reply(s,200,"text/javascript; charset=utf-8",web_client_js,web_client_js_len);
    else if(!strcmp(path,"/status")) {
        char b[768];EnterCriticalSection(&g.lock);
        unsigned listeners=0;for(unsigned i=0;i<LS_MAX_CLIENTS;++i)listeners+=g.peers[i].active?1:0;
        int n=snprintf(b,sizeof(b),"{\"capturing\":%ld,\"rendering\":%ld,\"latency\":%.2f,\"packets\":%llu,"
            "\"captureGaps\":%u,\"hostGaps\":%u,\"peak\":%.5f,\"test\":%s,\"localHost\":%s,\"sourceIsCable\":%s,"
            "\"listeners\":%u,\"hostCalibrationMs\":%.3f,\"hostCalibrated\":%s,\"calibrationConfidence\":%.3f,"
            "\"bufferMode\":\"manual-fixed\",\"speed\":1,\"epoch\":%u}",g.capturing,g.rendering,
            ls_delay(&g.timeline,ls_now()),(unsigned long long)g.next_seq,g.capture_gaps,g.host_gaps,g.capture_peak,g.test_tone?"true":"false",
            local_client(s)?"true":"false",wcsstr(g.source_name,L"CABLE Input")?"true":"false",listeners,
            g.host_calibration,g.host_calibrated?"true":"false",g.host_calibration_confidence,g.epoch);
        LeaveCriticalSection(&g.lock);http_reply(s,200,"application/json",(unsigned char*)b,(size_t)n);
    } else {const unsigned char b[]="Not found";http_reply(s,404,"text/plain",b,sizeof(b)-1);}
done:
    shutdown(s,SD_BOTH);closesocket(s);InterlockedDecrement(&g.workers);return 0;
}
static void addresses(void) {
    snprintf(g.urls,sizeof(g.urls),"http://127.0.0.1:%u/\r\n",g.port);
    ULONG size=16000;IP_ADAPTER_ADDRESSES *a=malloc(size);
    if(!a)return;
    ULONG r=GetAdaptersAddresses(AF_INET,GAA_FLAG_SKIP_ANYCAST|GAA_FLAG_SKIP_MULTICAST|GAA_FLAG_SKIP_DNS_SERVER,NULL,a,&size);
    if(r==ERROR_BUFFER_OVERFLOW){free(a);a=malloc(size);if(!a)return;
        r=GetAdaptersAddresses(AF_INET,GAA_FLAG_SKIP_ANYCAST|GAA_FLAG_SKIP_MULTICAST|GAA_FLAG_SKIP_DNS_SERVER,NULL,a,&size);}
    if(r==NO_ERROR)for(IP_ADAPTER_ADDRESSES *p=a;p;p=p->Next) {
        if(p->OperStatus!=IfOperStatusUp||p->IfType==IF_TYPE_SOFTWARE_LOOPBACK)continue;
        for(IP_ADAPTER_UNICAST_ADDRESS *u=p->FirstUnicastAddress;u;u=u->Next) {
            if(u->Address.lpSockaddr->sa_family!=AF_INET)continue;
            char ip[64];struct sockaddr_in *in=(struct sockaddr_in*)u->Address.lpSockaddr;
            if(!InetNtopA(AF_INET,&in->sin_addr,ip,sizeof(ip)))continue;
            size_t n=strlen(g.urls);snprintf(g.urls+n,sizeof(g.urls)-n,"http://%s:%u/\r\n",ip,g.port);
        }
    }
    free(a);ls_log("Listening links:\n%s",g.urls);
}
DWORD WINAPI ls_server_thread(void *unused) {
    (void)unused;WSADATA w;if(WSAStartup(MAKEWORD(2,2),&w))return 1;
    SOCKET s=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);g.listener=s;
    if(s==INVALID_SOCKET){ls_error(L"创建网络套接字",HRESULT_FROM_WIN32(WSAGetLastError()));return 1;}
    BOOL yes=TRUE;setsockopt(s,SOL_SOCKET,SO_EXCLUSIVEADDRUSE,(char*)&yes,sizeof(yes));
    struct sockaddr_in addr={0};addr.sin_family=AF_INET;addr.sin_addr.s_addr=htonl(INADDR_ANY);addr.sin_port=htons((u_short)g.port);
    if(bind(s,(struct sockaddr*)&addr,sizeof(addr))||listen(s,48)) {
        ls_error(L"监听局域网端口",HRESULT_FROM_WIN32(WSAGetLastError()));closesocket(s);g.listener=INVALID_SOCKET;return 1;
    }
    addresses();InterlockedExchange(&g.serving,1);
    while(WaitForSingleObject(g.stop,0)!=WAIT_OBJECT_0) {
        fd_set set;FD_ZERO(&set);FD_SET(s,&set);struct timeval tv={0,100000};
        int result=select(0,&set,NULL,NULL,&tv);if(result==SOCKET_ERROR)break;
        if(result>0) {
            SOCKET client=accept(s,NULL,NULL);
            if(client!=INVALID_SOCKET) {
                if(InterlockedIncrement(&g.workers)>48){InterlockedDecrement(&g.workers);closesocket(client);continue;}
                connection *c=malloc(sizeof(*c));if(!c){InterlockedDecrement(&g.workers);closesocket(client);continue;}
                c->socket=client;HANDLE t=CreateThread(NULL,0,serve,c,0,NULL);
                if(t)CloseHandle(t);else{free(c);closesocket(client);InterlockedDecrement(&g.workers);}
            }
        }
    }
    closesocket(s);g.listener=INVALID_SOCKET;InterlockedExchange(&g.serving,0);
    while(InterlockedCompareExchange(&g.workers,0,0))Sleep(10);
    WSACleanup();return 0;
}
