#define INITGUID
#include "app.h"
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <functiondiscoverykeys_devpkey.h>
#include <avrt.h>
#include <math.h>
#include <stdio.h>
#include <string.h>
#include "calibrate.h"
#define RELEASE(type,p) do { if(p) { type##_Release(p); p = NULL; } } while(0)
static HRESULT enumerator(IMMDeviceEnumerator **e) {
    return CoCreateInstance(&CLSID_MMDeviceEnumerator, NULL, CLSCTX_ALL,
                            &IID_IMMDeviceEnumerator, (void **)e);
}
static void device_info(IMMDevice *d, WCHAR *id, WCHAR *name) {
    LPWSTR s = NULL;
    IPropertyStore *props = NULL;
    PROPVARIANT v;
    PropVariantInit(&v);
    if (SUCCEEDED(IMMDevice_GetId(d, &s))) {
        lstrcpynW(id, s, 512); CoTaskMemFree(s);
    }
    if (SUCCEEDED(IMMDevice_OpenPropertyStore(d, STGM_READ, &props))) {
        if (SUCCEEDED(IPropertyStore_GetValue(props, &PKEY_Device_FriendlyName, &v)) &&
            v.vt == VT_LPWSTR) lstrcpynW(name, v.pwszVal, 256);
        PropVariantClear(&v); IPropertyStore_Release(props);
    }
}
void ls_audio_devices(void) {
    IMMDeviceEnumerator *e = NULL;
    IMMDeviceCollection *list = NULL;
    if (FAILED(enumerator(&e))) return;
    if (SUCCEEDED(IMMDeviceEnumerator_EnumAudioEndpoints(e,eRender,DEVICE_STATE_ACTIVE,&list))) {
        UINT count = 0; IMMDeviceCollection_GetCount(list, &count);
        for (UINT i = 0; i < count; ++i) {
            IMMDevice *d = NULL; WCHAR id[512] = L"", name[256] = L"";
            if (SUCCEEDED(IMMDeviceCollection_Item(list, i, &d))) {
                device_info(d, id, name);
                char utf[1024]; WideCharToMultiByte(CP_UTF8,0,name,-1,utf,sizeof(utf),NULL,NULL);
                printf("%u: %s\n",i,utf); IMMDevice_Release(d);
            }
        }
    }
    RELEASE(IMMDeviceCollection,list); RELEASE(IMMDeviceEnumerator,e);
}
int ls_audio_select(void) {
    IMMDeviceEnumerator *e = NULL; IMMDeviceCollection *list = NULL;
    IMMDevice *d = NULL; HRESULT hr = enumerator(&e);
    if (FAILED(hr)) goto fail;
    hr = IMMDeviceEnumerator_EnumAudioEndpoints(e,eRender,DEVICE_STATE_ACTIVE,&list);
    if (FAILED(hr)) goto fail;
    UINT count = 0; IMMDeviceCollection_GetCount(list,&count);
    for (UINT i=0;i<count;++i) {
        WCHAR id[512] = L"", name[256] = L"";
        if (FAILED(IMMDeviceCollection_Item(list,i,&d))) continue;
        device_info(d,id,name); IMMDevice_Release(d); d=NULL;
        if ((g.source_index >= 0 && i == (UINT)g.source_index) ||
            (g.source_index < 0 && (!wcscmp(name,LS_ENDPOINT_NAME) ||
             (wcsstr(name,L"CABLE Input")&&wcsstr(name,L"VB-Audio Virtual Cable")&&!wcsstr(name,L"16ch"))))) {
            lstrcpynW(g.source_id,id,512); lstrcpynW(g.source_name,name,256);
        }
        if (g.output_index >= 0 && i == (UINT)g.output_index) {
            lstrcpynW(g.output_id,id,512); lstrcpynW(g.output_name,name,256);
        }
    }
    if (!g.output_id[0] && SUCCEEDED(IMMDeviceEnumerator_GetDefaultAudioEndpoint(e,eRender,eConsole,&d))) {
        device_info(d,g.output_id,g.output_name); IMMDevice_Release(d); d=NULL;
        /* If last run crashed while routed, consult route recovery before selection. */
        if (!wcscmp(g.output_id,g.source_id) || wcsstr(g.output_name,L"VB-Audio") ||
            wcsstr(g.output_name,L"Virtual")) g.output_id[0]=0;
    }
    if (!g.output_id[0]) {
        for (UINT i=0;i<count;++i) {
            WCHAR id[512]=L"",name[256]=L"";
            if(FAILED(IMMDeviceCollection_Item(list,i,&d)))continue;
            device_info(d,id,name);IMMDevice_Release(d);d=NULL;
            if (!wcscmp(id,g.source_id) || wcsstr(name,L"VB-Audio") || wcsstr(name,L"Virtual")) continue;
            lstrcpynW(g.output_id,id,512);lstrcpynW(g.output_name,name,256);break;
        }
    }
    RELEASE(IMMDeviceCollection,list); RELEASE(IMMDeviceEnumerator,e);
    if (!g.test_tone && !g.source_id[0]) {
        lstrcpynW(g.error,L"未检测到 VB-CABLE 的 CABLE Input。请点“安装 VB-CABLE”前往官网下载并安装，重启 Windows 后再打开本程序。",512);
        return 0;
    }
    if (!g.output_id[0] || (!g.test_tone && !wcscmp(g.output_id,g.source_id))) {
        lstrcpynW(g.error,L"无法选择独立的本机扬声器输出。请检查 Windows 音频设备。",512); return 0;
    }
    return 1;
fail:
    ls_error(L"枚举音频设备",hr);
    RELEASE(IMMDevice,d);RELEASE(IMMDeviceCollection,list);RELEASE(IMMDeviceEnumerator,e);
    return 0;
}
static HRESULT open_client(const WCHAR *id, IAudioClient **client) {
    IMMDeviceEnumerator *e=NULL; IMMDevice *d=NULL;
    HRESULT hr=enumerator(&e);
    if(SUCCEEDED(hr))hr=IMMDeviceEnumerator_GetDevice(e,id,&d);
    if(SUCCEEDED(hr))hr=IMMDevice_Activate(d,&IID_IAudioClient,CLSCTX_ALL,NULL,(void**)client);
    RELEASE(IMMDevice,d);RELEASE(IMMDeviceEnumerator,e);return hr;
}
static WAVEFORMATEX pcm_format(void) {
    WAVEFORMATEX f={0};f.wFormatTag=WAVE_FORMAT_IEEE_FLOAT;
    f.nChannels=LS_CHANNELS;f.nSamplesPerSec=LS_RATE;
    f.wBitsPerSample=32;f.nBlockAlign=8;f.nAvgBytesPerSec=LS_RATE*8;return f;
}
DWORD WINAPI ls_capture_thread(void *unused) {
    (void)unused;
    CoInitializeEx(NULL,COINIT_MULTITHREADED);
    DWORD task=0;HANDLE mm=AvSetMmThreadCharacteristicsW(L"Pro Audio",&task);
    while(WaitForSingleObject(g.stop,0)!=WAIT_OBJECT_0) {
        if(g.test_tone) {
            double t=ls_now(); uint64_t frame=0;
            while(WaitForSingleObject(g.stop,1)!=WAIT_OBJECT_0) {
                double now=ls_now(); if(now<t+10)continue;
                /* Drop a stalled producer's backlog rather than inventing old live audio. */
                if(now-t>100)t=now-10;
                int16_t pcm[LS_FRAMES*2];
                for(unsigned i=0;i<LS_FRAMES;++i,++frame) {
                    double a=sin((double)frame*6.283185307179586*440/LS_RATE)*.025;
                    pcm[i*2]=pcm[i*2+1]=(int16_t)(a*32767);
                }
                EnterCriticalSection(&g.lock);g.capture_peak=.025;LeaveCriticalSection(&g.lock);
                ls_publish(pcm,LS_FRAMES,t);t+=10;InterlockedExchange(&g.capturing,1);
            }
            break;
        }
        IAudioClient *client=NULL;IAudioCaptureClient *capture=NULL;
        WAVEFORMATEX f=pcm_format();HRESULT hr=open_client(g.source_id,&client);
        if(SUCCEEDED(hr))hr=IAudioClient_Initialize(client,AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK|AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM|
            AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,1000000,0,&f,NULL);
        if(SUCCEEDED(hr))hr=IAudioClient_GetService(client,&IID_IAudioCaptureClient,(void**)&capture);
        if(SUCCEEDED(hr))hr=IAudioClient_Start(client);
        if(SUCCEEDED(hr)) {
            InterlockedExchange(&g.capturing,1);
            while(WaitForSingleObject(g.stop,2)!=WAIT_OBJECT_0) {
                UINT32 count=0;hr=IAudioCaptureClient_GetNextPacketSize(capture,&count);
                if(FAILED(hr))break;
                while(count) {
                    BYTE *data=NULL;UINT32 frames=0;DWORD flags=0;UINT64 pos=0,qpc=0;
                    hr=IAudioCaptureClient_GetBuffer(capture,&data,&frames,&flags,&pos,&qpc);
                    if(FAILED(hr))break;
                    double stamp=(flags&AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR)?
                        ls_now()-(double)frames/48:qpc/10000.0;
                    if(flags&AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) {
                        EnterCriticalSection(&g.lock);++g.capture_gaps;LeaveCriticalSection(&g.lock);
                    }
                    for(unsigned off=0;off<frames;off+=LS_FRAMES) {
                        unsigned n=frames-off;if(n>LS_FRAMES)n=LS_FRAMES;
                        int16_t pcm[LS_FRAMES*2];double peak=0;
                        for(unsigned i=0;i<n*2;++i) {
                            float v=(flags&AUDCLNT_BUFFERFLAGS_SILENT)?0:((float*)data)[off*2+i];
                            if(!isfinite(v))v=0;if(v>1)v=1;if(v< -1)v=-1;
                            if(fabs(v)>peak)peak=fabs(v);pcm[i]=(int16_t)(v*32767);
                        }
                        EnterCriticalSection(&g.lock);g.capture_peak=peak;LeaveCriticalSection(&g.lock);
                        ls_publish(pcm,n,stamp+off/48.0);
                    }
                    IAudioCaptureClient_ReleaseBuffer(capture,frames);
                    hr=IAudioCaptureClient_GetNextPacketSize(capture,&count);if(FAILED(hr))break;
                }
                if(FAILED(hr))break;
            }
        }
        InterlockedExchange(&g.capturing,0);
        if(client)IAudioClient_Stop(client);
        RELEASE(IAudioCaptureClient,capture);RELEASE(IAudioClient,client);
        if(FAILED(hr))ls_error(L"音频采集（将自动重试）",hr);
        WaitForSingleObject(g.stop,1000);
    }
    if(mm)AvRevertMmThreadCharacteristics(mm);CoUninitialize();return 0;
}
DWORD WINAPI ls_render_thread(void *unused) {
    (void)unused;CoInitializeEx(NULL,COINIT_MULTITHREADED);
    DWORD task=0;HANDLE mm=AvSetMmThreadCharacteristicsW(L"Pro Audio",&task);
    while(WaitForSingleObject(g.stop,0)!=WAIT_OBJECT_0) {
        IAudioClient *client=NULL;IAudioRenderClient *render=NULL;IAudioClock *clock=NULL;
        IAudioClient *tap_client=NULL;IAudioCaptureClient *tap=NULL;ls_calibrator *calibration=NULL;
        WAVEFORMATEX f=pcm_format();UINT32 size=0;UINT64 frequency=0,written=0;
        HRESULT hr=open_client(g.output_id,&client);
        if(SUCCEEDED(hr))hr=IAudioClient_Initialize(client,AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM|AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY|
            AUDCLNT_STREAMFLAGS_NOPERSIST,400000,0,&f,NULL);
        if(SUCCEEDED(hr))hr=IAudioClient_GetBufferSize(client,&size);
        if(SUCCEEDED(hr))hr=IAudioClient_GetService(client,&IID_IAudioRenderClient,(void**)&render);
        if(SUCCEEDED(hr))hr=IAudioClient_GetService(client,&IID_IAudioClock,(void**)&clock);
        if(SUCCEEDED(hr))hr=IAudioClock_GetFrequency(clock,&frequency);
        if(SUCCEEDED(hr)){
            HRESULT tap_hr=open_client(g.output_id,&tap_client);
            if(SUCCEEDED(tap_hr))tap_hr=IAudioClient_Initialize(tap_client,AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK|AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM|
                AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,1000000,0,&f,NULL);
            if(SUCCEEDED(tap_hr))tap_hr=IAudioClient_GetService(tap_client,&IID_IAudioCaptureClient,(void**)&tap);
            if(SUCCEEDED(tap_hr))tap_hr=IAudioClient_Start(tap_client);
            if(SUCCEEDED(tap_hr))calibration=ls_cal_create(tap);
            if(FAILED(tap_hr))ls_log("Output loopback calibration unavailable: 0x%08lX",(unsigned long)tap_hr);
        }
        /* Prime the initial buffer before Start, as required for reliable render
           startup. Include this initial silence in the stream frame count. */
        if(SUCCEEDED(hr)){
            BYTE *initial=NULL;hr=IAudioRenderClient_GetBuffer(render,size,&initial);
            if(SUCCEEDED(hr))hr=IAudioRenderClient_ReleaseBuffer(render,size,AUDCLNT_BUFFERFLAGS_SILENT);
            if(SUCCEEDED(hr))written=size;
        }
        if(SUCCEEDED(hr)){
            REFERENCE_TIME latency=0,period=0,minimum=0;
            IAudioClient_GetStreamLatency(client,&latency);IAudioClient_GetDevicePeriod(client,&period,&minimum);
            ls_log("Native output: buffer=%u frames, stream latency=%.3f ms, engine period=%.3f ms, clock=%llu",
                size,latency/10000.0,period/10000.0,(unsigned long long)frequency);
        }
        if(SUCCEEDED(hr))hr=IAudioClient_Start(client);
        uint64_t seq;EnterCriticalSection(&g.lock);seq=g.next_seq;LeaveCriticalSection(&g.lock);
        ls_packet p={0};int have=0,aligned=0;unsigned sample=0,epoch=0;
        double last_end=0,last_compensation=0,last_clock_end=0;
        if(SUCCEEDED(hr)) {
            InterlockedExchange(&g.rendering,1);
            while(WaitForSingleObject(g.stop,3)!=WAIT_OBJECT_0) {
                ls_cal_poll(calibration,ls_now());
                UINT32 padding=0;hr=IAudioClient_GetCurrentPadding(client,&padding);if(FAILED(hr))break;
                /* 20 ms ahead; hardware position correlates audio time to QPC. */
                unsigned need=960>padding?960-padding:0;
                if(need>size-padding)need=size-padding;if(!need)continue;
                UINT64 pos=0,qpc=0;hr=IAudioClock_GetPosition(clock,&pos,&qpc);if(FAILED(hr))break;
                double now=ls_now();double when=now+padding/48.0;
                if(frequency && qpc && pos) {
                    double projected=qpc/10000.0+(written/(double)LS_RATE-pos/(double)frequency)*1000;
                    if(fabs(projected-when)<100)when=projected;
                }
                /* Recover an actual audio-engine underrun without moving shared time. */
                if(when<now-20)when=now;
                double clock_when=when;
                double compensation=ls_cal_apply(calibration,need);when+=compensation;
                if(fabs(compensation-last_compensation)>=2 ||
                   (last_clock_end&&fabs(clock_when-last_clock_end)>2))aligned=0;
                last_compensation=compensation;last_clock_end=clock_when+need/48.0;
                EnterCriticalSection(&g.lock);
                if(epoch!=g.epoch){epoch=g.epoch;seq=g.first_seq;have=aligned=0;sample=0;last_end=0;}
                LeaveCriticalSection(&g.lock);
                BYTE *bytes=NULL;hr=IAudioRenderClient_GetBuffer(render,need,&bytes);if(FAILED(hr))break;
                float *dst=(float*)bytes;unsigned missing=0;
                for(unsigned i=0;i<need;++i) {
                    double t=when+i/48.0;
                    for(unsigned tries=0;tries<LS_RING;++tries) {
                        if(!have) {
                            if(!ls_packet_read(seq,&p)) {
                                EnterCriticalSection(&g.lock);uint64_t latest=g.next_seq;LeaveCriticalSection(&g.lock);
                                if(latest>seq+LS_RING){seq=latest-LS_RING+1;continue;}
                                break;
                            }
                            if(p.epoch!=epoch)break;
                            have=1;sample=0;aligned=0;
                            if(last_end&&fabs(p.play-last_end)<2&&fabs(t-p.play)<2)aligned=1;
                        }
                        if(!aligned&&t>=p.play+p.duration){last_end=p.play+p.duration;++seq;have=0;continue;}
                        break;
                    }
                    float l=0,r=0;
                    if(have&&!aligned){
                        double expected=p.play+sample/48.0;
                        if(t>=expected){
                            if(t-expected>2){unsigned skip=(unsigned)((t-expected)*48);sample+=skip;}
                            aligned=1;
                        }
                    }
                    if(have&&aligned&&sample<p.frames){
                        /* Exactly one original PCM frame per output frame. Clock
                           corrections insert silence or discard frames, never resample. */
                        l=p.pcm[sample*2]/32768.0f;r=p.pcm[sample*2+1]/32768.0f;++sample;
                        if(sample>=p.frames){last_end=p.play+p.duration;++seq;have=aligned=0;sample=0;}
                    } else if(have&&sample>=p.frames){
                        last_end=p.play+p.duration;++seq;have=aligned=0;sample=0;
                    } else if(last_end && t>last_end+20)missing=1;
                    dst[i*2]=l;dst[i*2+1]=r;
                }
                ls_cal_reference(calibration,dst,need,clock_when);
                hr=IAudioRenderClient_ReleaseBuffer(render,need,0);if(FAILED(hr))break;written+=need;
                EnterCriticalSection(&g.lock);
                g.host_required=fmax(35,(when-now)+35);g.host_error=when-now-padding/48.0;
                g.host_calibration=compensation;g.host_calibration_confidence=ls_cal_confidence(calibration);
                g.host_calibrated=ls_cal_ready(calibration);
                if(missing&&now-g.last_audio_data<100)++g.host_gaps;LeaveCriticalSection(&g.lock);
            }
        }
        InterlockedExchange(&g.rendering,0);if(client)IAudioClient_Stop(client);
        if(tap_client)IAudioClient_Stop(tap_client);ls_cal_destroy(calibration);
        RELEASE(IAudioCaptureClient,tap);RELEASE(IAudioClient,tap_client);
        RELEASE(IAudioClock,clock);RELEASE(IAudioRenderClient,render);RELEASE(IAudioClient,client);
        if(FAILED(hr))ls_error(L"本机播放（将自动重试）",hr);
        WaitForSingleObject(g.stop,1000);
    }
    if(mm)AvRevertMmThreadCharacteristics(mm);CoUninitialize();return 0;
}
