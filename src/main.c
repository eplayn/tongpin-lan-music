#include "app.h"
#include <shellapi.h>
#include <mmsystem.h>
#include <stdio.h>
#include <stdarg.h>
#include <stdlib.h>
#include <math.h>

ls_app g;
static FILE *log_file;
static CRITICAL_SECTION log_lock;
static HWND status_control,url_control,buffer_control;
static WCHAR settings_path[1200];
#define LS_SET_BUFFER (WM_APP+1)
#define LS_STOP (WM_APP+2)
static int parse_buffer(const WCHAR *s,unsigned *value) {
    char text[32];if(!WideCharToMultiByte(CP_ACP,0,s,-1,text,sizeof(text),NULL,NULL))return 0;
    return ls_buffer_parse(text,value);
}
static int apply_buffer(unsigned value) {
    if(value<LS_BUFFER_MIN||value>LS_BUFFER_MAX)return 0;
    WCHAR text[24];swprintf(text,24,L"%u",value);
    if(!WritePrivateProfileStringW(L"Audio",L"BufferMs",text,settings_path))return 0;
    EnterCriticalSection(&g.lock);
    if(g.timeline.buffer_ms!=value){ls_timeline_set(&g.timeline,value);g.first_seq=g.next_seq;++g.epoch;}
    LeaveCriticalSection(&g.lock);
    if(buffer_control)SetWindowTextW(buffer_control,text);
    ls_log("Manual fixed buffer: %u ms; epoch=%u (rebuffer, original speed)",value,g.epoch);
    return 1;
}
double ls_now(void) {
    LARGE_INTEGER f,t;QueryPerformanceFrequency(&f);QueryPerformanceCounter(&t);
    return t.QuadPart*1000.0/f.QuadPart;
}
void ls_log(const char *format,...) {
    EnterCriticalSection(&log_lock);
    va_list ap;va_start(ap,format);if(log_file){vfprintf(log_file,format,ap);fputc('\n',log_file);fflush(log_file);}va_end(ap);
    LeaveCriticalSection(&log_lock);
}
void ls_error(const WCHAR *where,HRESULT hr) {
    WCHAR msg[512];swprintf(msg,512,L"%ls：0x%08lX",where,(unsigned long)hr);
    EnterCriticalSection(&g.lock);lstrcpynW(g.error,msg,512);LeaveCriticalSection(&g.lock);
    char utf[1600];WideCharToMultiByte(CP_UTF8,0,msg,-1,utf,sizeof(utf),NULL,NULL);ls_log("ERROR %s",utf);
}
void ls_publish(const int16_t *pcm,unsigned frames,double stamp) {
    if(!frames||frames>LS_FRAMES)return;
    EnterCriticalSection(&g.lock);uint64_t seq=g.next_seq++;
    ls_packet *p=&g.ring[seq%LS_RING];p->seq=seq;p->captured=stamp;p->frames=frames;
    p->epoch=g.epoch;p->play=ls_play(&g.timeline,stamp);p->duration=frames/48.0;
    memcpy(p->pcm,pcm,frames*4);g.last_audio_data=ls_now();LeaveCriticalSection(&g.lock);
}
int ls_packet_read(uint64_t seq,ls_packet *p) {
    int found=0;EnterCriticalSection(&g.lock);
    if(seq>=g.first_seq&&seq<g.next_seq&&g.next_seq-seq<=LS_RING&&g.ring[seq%LS_RING].seq==seq){*p=g.ring[seq%LS_RING];found=1;}
    LeaveCriticalSection(&g.lock);return found;
}
static void clipboard(const WCHAR *s) {
    size_t size=(wcslen(s)+1)*sizeof(WCHAR);HGLOBAL h=GlobalAlloc(GMEM_MOVEABLE,size);if(!h)return;
    WCHAR *p=GlobalLock(h);if(!p){GlobalFree(h);return;}memcpy(p,s,size);GlobalUnlock(h);
    if(OpenClipboard(g.window)){EmptyClipboard();if(!SetClipboardData(CF_UNICODETEXT,h))GlobalFree(h);CloseClipboard();}
    else GlobalFree(h);
}
static LRESULT CALLBACK window_proc(HWND w,UINT m,WPARAM wp,LPARAM lp) {
    switch(m) {
    case WM_CREATE:{
        HFONT font=(HFONT)GetStockObject(DEFAULT_GUI_FONT);
        HWND title=CreateWindowW(L"STATIC",L"同频 C  /  局域网音频共享",WS_CHILD|WS_VISIBLE,24,24,670,28,w,NULL,NULL,NULL);
        status_control=CreateWindowW(L"STATIC",L"正在初始化…",WS_CHILD|WS_VISIBLE,24,65,670,140,w,NULL,NULL,NULL);
        url_control=CreateWindowExW(WS_EX_CLIENTEDGE,L"EDIT",L"",WS_CHILD|WS_VISIBLE|ES_MULTILINE|ES_READONLY|ES_AUTOVSCROLL|WS_VSCROLL,24,220,670,118,w,NULL,NULL,NULL);
        const WCHAR *labels[]={L"复制局域网地址",L"打开本机监测",L"安装 VB-CABLE",L"允许局域网"};
        const int commands[]={100,101,102,104};
        for(int i=0;i<4;++i){HWND b=CreateWindowW(L"BUTTON",labels[i],WS_CHILD|WS_VISIBLE|BS_PUSHBUTTON,24+i*173,358,155,34,w,(HMENU)(INT_PTR)commands[i],NULL,NULL);SendMessageW(b,WM_SETFONT,(WPARAM)font,TRUE);}
        HWND buffer_label=CreateWindowW(L"STATIC",L"固定缓冲（50–5000 ms）：",WS_CHILD|WS_VISIBLE,24,408,205,24,w,NULL,NULL,NULL);
        WCHAR initial[24];swprintf(initial,24,L"%u",g.timeline.buffer_ms);
        buffer_control=CreateWindowExW(WS_EX_CLIENTEDGE,L"EDIT",initial,WS_CHILD|WS_VISIBLE|WS_TABSTOP|ES_NUMBER|ES_AUTOHSCROLL,230,404,90,28,w,(HMENU)(INT_PTR)105,NULL,NULL);
        SendMessageW(buffer_control,EM_SETLIMITTEXT,5,0);
        HWND apply=CreateWindowW(L"BUTTON",L"应用并保存",WS_CHILD|WS_VISIBLE|WS_TABSTOP|BS_PUSHBUTTON,334,403,125,30,w,(HMENU)(INT_PTR)106,NULL,NULL);
        SendMessageW(buffer_label,WM_SETFONT,(WPARAM)font,TRUE);SendMessageW(buffer_control,WM_SETFONT,(WPARAM)font,TRUE);SendMessageW(apply,WM_SETFONT,(WPARAM)font,TRUE);
        HWND note=CreateWindowW(L"STATIC",L"修改缓冲后所有设备重新缓冲，始终原速播放；跟不上时停顿或跳过迟到声音。\r\n数值不会自动调整，设得太低可能卡顿。局域网听众首次须点“开始收听”。\r\n本机网页仅监测。应用固定绑定旧声卡时，请切回系统默认输出。",WS_CHILD|WS_VISIBLE,24,450,680,75,w,NULL,NULL,NULL);
        SendMessageW(title,WM_SETFONT,(WPARAM)font,TRUE);SendMessageW(note,WM_SETFONT,(WPARAM)font,TRUE);
        SendMessageW(status_control,WM_SETFONT,(WPARAM)font,TRUE);SendMessageW(url_control,WM_SETFONT,(WPARAM)font,TRUE);
        SetTimer(w,1,500,NULL);return 0;}
    case WM_TIMER:{
        WCHAR text[1800],urls[2048];unsigned peers=0;double latency;
        EnterCriticalSection(&g.lock);for(unsigned i=0;i<LS_MAX_CLIENTS;++i)peers+=g.peers[i].active?1:0;
        latency=ls_delay(&g.timeline,ls_now());
        swprintf(text,1800,L"%ls\r\n\r\n采集：%ls\r\n本机播放：%ls\r\n固定缓冲：%.0f ms（原速）     连接听众：%u\r\n%ls",
            g.test_tone?L"测试音模式（并非系统音频共享）":g.capturing&&g.rendering?L"正在同步共享":L"等待音频设备就绪",
            g.test_tone?L"内置 440 Hz 测试音":g.source_name[0]?g.source_name:L"VB-CABLE 未就绪",
            g.output_name,latency,peers,g.error);
        LeaveCriticalSection(&g.lock);
        SetWindowTextW(status_control,text);MultiByteToWideChar(CP_UTF8,0,g.urls,-1,urls,2048);
        SetWindowTextW(url_control,urls);return 0;}
    case LS_SET_BUFFER:return apply_buffer((unsigned)wp);
    case LS_STOP:PostMessageW(w,WM_CLOSE,0,0);return 1;
    case WM_COMMAND:
        if(LOWORD(wp)==100){
            const char *begin=strstr(g.urls,"\r\n");begin=begin&&begin[2]?begin+2:g.urls;
            const char *end=strstr(begin,"\r\n");size_t n=end?(size_t)(end-begin):strlen(begin);
            if(n>0&&n<512){char link[512];WCHAR url[512];memcpy(link,begin,n);link[n]=0;
                MultiByteToWideChar(CP_UTF8,0,link,-1,url,512);clipboard(url);}
        }
        if(LOWORD(wp)==101){char *end=strstr(g.urls,"\r\n");char first[256];size_t n=end?(size_t)(end-g.urls):strlen(g.urls);if(n<sizeof(first)){memcpy(first,g.urls,n);first[n]=0;ShellExecuteA(w,"open",first,NULL,NULL,SW_SHOWNORMAL);}}
        if(LOWORD(wp)==102){WCHAR exe[1024];GetModuleFileNameW(NULL,exe,1024);ShellExecuteW(w,L"open",exe,L"--install-vbcable",NULL,SW_SHOWNORMAL);}
        if(LOWORD(wp)==106){WCHAR input[32];unsigned value=0;GetWindowTextW(buffer_control,input,32);
            if(!parse_buffer(input,&value))MessageBoxW(w,L"请输入 50 到 5000 之间的整数，单位为毫秒。",LS_TITLE,MB_ICONINFORMATION);
            else if(!apply_buffer(value))MessageBoxW(w,L"无法保存设置。请把程序放在可写文件夹后重试。",LS_TITLE,MB_ICONERROR);}
        if(LOWORD(wp)==104){WCHAR exe[1024];GetModuleFileNameW(NULL,exe,1024);ShellExecuteW(w,L"open",exe,L"--allow-lan",NULL,SW_SHOWNORMAL);}return 0;
    case WM_CLOSE:SetEvent(g.stop);DestroyWindow(w);return 0;
    case WM_DESTROY:PostQuitMessage(0);return 0;
    }return DefWindowProcW(w,m,wp,lp);
}
static BOOL WINAPI console_handler(DWORD event) {
    if(event==CTRL_C_EVENT||event==CTRL_BREAK_EVENT||event==CTRL_CLOSE_EVENT){SetEvent(g.stop);return TRUE;}return FALSE;
}
int WINAPI wWinMain(HINSTANCE instance,HINSTANCE previous,LPWSTR command,int show) {
    (void)previous;(void)command;
    int argc=0;WCHAR **argv=CommandLineToArgvW(GetCommandLineW(),&argc);
    if(argc>=5&&!wcscmp(argv[1],L"--guard"))return ls_guard(wcstoul(argv[2],NULL,10),argv[3],argv[4]);
    InitializeCriticalSection(&g.lock);InitializeCriticalSection(&log_lock);
    g.port=17890;g.source_index=g.output_index=-1;g.listener=INVALID_SOCKET;
    GetModuleFileNameW(NULL,settings_path,1200);WCHAR *settings_slash=wcsrchr(settings_path,L'\\');
    if(settings_slash)lstrcpyW(settings_slash+1,L"lansync.ini");
    ls_timeline_init(&g.timeline,ls_now());g.epoch=1;
    WCHAR saved_buffer[32];unsigned initial_buffer=LS_BUFFER_DEFAULT;
    GetPrivateProfileStringW(L"Audio",L"BufferMs",L"600",saved_buffer,32,settings_path);
    if(parse_buffer(saved_buffer,&initial_buffer))ls_timeline_set(&g.timeline,initial_buffer);
    if(argc==3&&!wcscmp(argv[1],L"--set-buffer-ms")){
        unsigned value=0;DWORD_PTR result=0;HWND target=FindWindowW(L"LanSyncCWindow",NULL);
        int ok=parse_buffer(argv[2],&value)&&target&&SendMessageTimeoutW(target,LS_SET_BUFFER,value,0,SMTO_ABORTIFHUNG,3000,&result)&&result;
        LocalFree(argv);return ok?0:2;
    }
    if(argc==2&&!wcscmp(argv[1],L"--stop")){
        DWORD_PTR result=0;HWND target=FindWindowW(L"LanSyncCWindow",NULL);
        int ok=target&&SendMessageTimeoutW(target,LS_STOP,0,0,SMTO_ABORTIFHUNG,3000,&result)&&result;
        LocalFree(argv);return ok?0:2;
    }
    for(int i=1;i<argc;++i) {
        if(!wcscmp(argv[i],L"--headless"))g.headless=1;
        else if(!wcscmp(argv[i],L"--test-tone"))g.test_tone=1;
        else if(!wcscmp(argv[i],L"--no-route"))g.no_route=1;
        else if(!wcscmp(argv[i],L"--duration")&&i+1<argc)g.duration=_wtoi(argv[++i]);
        else if(!wcscmp(argv[i],L"--port")&&i+1<argc)g.port=(unsigned)_wtoi(argv[++i]);
        else if(!wcscmp(argv[i],L"--source")&&i+1<argc)g.source_index=_wtoi(argv[++i]);
        else if(!wcscmp(argv[i],L"--output")&&i+1<argc)g.output_index=_wtoi(argv[++i]);
        else if(!wcscmp(argv[i],L"--buffer-ms")){
            unsigned value=0;if(i+1>=argc||!parse_buffer(argv[++i],&value)){LocalFree(argv);return 2;}
            ls_timeline_set(&g.timeline,value);
        }
    }
    CoInitializeEx(NULL,COINIT_MULTITHREADED);
    if(argc>1&&!wcscmp(argv[1],L"--devices")){ls_audio_devices();CoUninitialize();LocalFree(argv);return 0;}
    if(argc>1&&(!wcscmp(argv[1],L"--install-vbcable")||!wcscmp(argv[1],L"--install-driver"))){int r=ls_cable_install();CoUninitialize();LocalFree(argv);return r;}
    if(argc>1&&!wcscmp(argv[1],L"--driver-status")){int r=ls_cable_status();CoUninitialize();LocalFree(argv);return r;}
    if(argc>1&&!wcscmp(argv[1],L"--allow-lan")){int r=ls_allow_lan();CoUninitialize();LocalFree(argv);return r;}
    if(!g.port||g.port>65535){CoUninitialize();LocalFree(argv);return 2;}
    WCHAR mutex_name[128];if(g.test_tone)swprintf(mutex_name,128,L"Local\\LanSyncC-Test-%u",g.port);
    else lstrcpyW(mutex_name,L"Local\\LanSyncC-AudioRoute");
    HANDLE mutex=CreateMutexW(NULL,TRUE,mutex_name);
    if(!mutex||GetLastError()==ERROR_ALREADY_EXISTS){if(!g.headless)MessageBoxW(NULL,L"同频 C 已在运行，请使用已打开的窗口。",LS_TITLE,MB_ICONINFORMATION);return 2;}
    WCHAR log_path[1200];GetModuleFileNameW(NULL,log_path,1200);WCHAR *slash=wcsrchr(log_path,L'\\');if(slash)lstrcpyW(slash+1,L"lansync.log");
    log_file=_wfopen(log_path,L"wb");
    ls_log("LanSync C 1.1.3 (VB-CABLE); mode=%s; fixed buffer=%u ms; original speed",g.test_tone?"synthetic":"system",g.timeline.buffer_ms);
    g.stop=CreateEventW(NULL,TRUE,FALSE,NULL);SetConsoleCtrlHandler(console_handler,TRUE);timeBeginPeriod(1);
    if(!g.test_tone)ls_route_restore();
    int audio_ready=ls_audio_select();
    /* Start both audio paths before routing arbitrary system audio into the sink. */
    HANDLE capture=NULL,render=NULL,server=NULL;
    if(audio_ready){capture=CreateThread(NULL,0,ls_capture_thread,NULL,0,NULL);render=CreateThread(NULL,0,ls_render_thread,NULL,0,NULL);
        double until=ls_now()+5000;while(ls_now()<until&&(!g.capturing||!g.rendering))Sleep(20);
        if(!capture||!render||!g.capturing||!g.rendering){audio_ready=0;lstrcpynW(g.error,L"采集或本机播放未成功初始化，未切换系统默认声音输出。",512);}
        if(!audio_ready)SetEvent(g.stop);
    }
    if(audio_ready){
        server=CreateThread(NULL,0,ls_server_thread,NULL,0,NULL);
        double until=ls_now()+5000;
        while(server&&!g.serving&&ls_now()<until&&WaitForSingleObject(server,0)==WAIT_TIMEOUT)Sleep(10);
        if(!server||!g.serving){audio_ready=0;if(!g.error[0])ls_error(L"网络服务未启动",E_FAIL);}
        else if(!ls_route_begin())audio_ready=0;
        if(!audio_ready)SetEvent(g.stop);
    }
    double began=ls_now();
    if(g.headless){if(!audio_ready)ls_error(g.error,E_FAIL);while(audio_ready&&WaitForSingleObject(g.stop,100)!=WAIT_OBJECT_0){if(g.duration>0&&ls_now()-began>=g.duration*1000.0)break;}}
    else {
        WNDCLASSW wc={0};wc.lpfnWndProc=window_proc;wc.hInstance=instance;wc.lpszClassName=L"LanSyncCWindow";wc.hCursor=LoadCursorW(NULL,IDC_ARROW);wc.hbrBackground=(HBRUSH)(COLOR_WINDOW+1);
        RegisterClassW(&wc);g.window=CreateWindowExW(0,wc.lpszClassName,LS_TITLE,WS_OVERLAPPED|WS_CAPTION|WS_SYSMENU|WS_MINIMIZEBOX,CW_USEDEFAULT,CW_USEDEFAULT,760,575,NULL,NULL,instance,NULL);
        if(g.window){ShowWindow(g.window,show);MSG msg;while(GetMessageW(&msg,NULL,0,0)>0){
            if(msg.hwnd==buffer_control&&msg.message==WM_KEYDOWN&&msg.wParam==VK_RETURN){
                if(!(msg.lParam&(1L<<30)))SendMessageW(g.window,WM_COMMAND,MAKEWPARAM(106,BN_CLICKED),0);
                continue;
            }
            TranslateMessage(&msg);DispatchMessageW(&msg);
        }}
    }
    SetEvent(g.stop);HANDLE threads[]={capture,render,server};for(unsigned i=0;i<3;++i)if(threads[i]){WaitForSingleObject(threads[i],INFINITE);CloseHandle(threads[i]);}
    if(!g.test_tone)ls_route_restore();
    ls_log("Stopped; captured packets=%llu, capture gaps=%u, host gaps=%u",(unsigned long long)g.next_seq,g.capture_gaps,g.host_gaps);
    if(log_file)fclose(log_file);CloseHandle(g.stop);ReleaseMutex(mutex);CloseHandle(mutex);timeEndPeriod(1);
    CoUninitialize();LocalFree(argv);DeleteCriticalSection(&g.lock);DeleteCriticalSection(&log_lock);return audio_ready?0:1;
}
