/* Independent WASAPI loopback probe for the REAL output; no virtual device. */
#define COBJMACROS
#define INITGUID
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
int main(int argc,char **argv) {
    if(argc!=2){fprintf(stderr,"usage: measure_output DEVICE_INDEX\n");return 2;}
    CoInitializeEx(NULL,COINIT_MULTITHREADED);
    IMMDeviceEnumerator *e=NULL;IMMDeviceCollection *devices=NULL;IMMDevice *device=NULL;
    IAudioClient *audio=NULL;IAudioCaptureClient *capture=NULL;
    HRESULT hr=CoCreateInstance(&CLSID_MMDeviceEnumerator,NULL,CLSCTX_ALL,&IID_IMMDeviceEnumerator,(void**)&e);
    if(SUCCEEDED(hr))hr=IMMDeviceEnumerator_EnumAudioEndpoints(e,eRender,DEVICE_STATE_ACTIVE,&devices);
    if(SUCCEEDED(hr))hr=IMMDeviceCollection_Item(devices,(UINT)atoi(argv[1]),&device);
    if(SUCCEEDED(hr))hr=IMMDevice_Activate(device,&IID_IAudioClient,CLSCTX_ALL,NULL,(void**)&audio);
    WAVEFORMATEX f={.wFormatTag=WAVE_FORMAT_IEEE_FLOAT,.nChannels=2,.nSamplesPerSec=48000,
        .nAvgBytesPerSec=384000,.nBlockAlign=8,.wBitsPerSample=32};
    if(SUCCEEDED(hr))hr=IAudioClient_Initialize(audio,AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK|AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM|
        AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,1000000,0,&f,NULL);
    if(SUCCEEDED(hr))hr=IAudioClient_GetService(audio,&IID_IAudioCaptureClient,(void**)&capture);
    if(SUCCEEDED(hr))hr=IAudioClient_Start(audio);
    unsigned long long samples=0,crossings=0;double sum=0;float previous=0;ULONGLONG start=GetTickCount64();
    while(SUCCEEDED(hr)&&GetTickCount64()-start<2500) {
        UINT32 next=0;hr=IAudioCaptureClient_GetNextPacketSize(capture,&next);if(FAILED(hr))break;
        while(next) {
            BYTE *data=NULL;UINT32 n=0;DWORD flags=0;UINT64 pos=0,time=0;
            hr=IAudioCaptureClient_GetBuffer(capture,&data,&n,&flags,&pos,&time);if(FAILED(hr))break;
            for(unsigned i=0;i<n;++i){float x=(flags&AUDCLNT_BUFFERFLAGS_SILENT)?0:((float*)data)[i*2];
                if(x>0&&previous<=0)++crossings;previous=x;sum+=x*x;++samples;}
            IAudioCaptureClient_ReleaseBuffer(capture,n);hr=IAudioCaptureClient_GetNextPacketSize(capture,&next);if(FAILED(hr))break;
        }
        Sleep(2);
    }
    double rms=samples?sqrt(sum/samples):0,hz=samples?crossings*48000.0/samples:0;
    printf("{\"frames\":%llu,\"rms\":%.8f,\"frequency_hz\":%.3f,\"hresult\":%ld}\n",samples,rms,hz,(long)hr);
    if(audio)IAudioClient_Stop(audio);if(capture)IAudioCaptureClient_Release(capture);if(audio)IAudioClient_Release(audio);
    if(device)IMMDevice_Release(device);if(devices)IMMDeviceCollection_Release(devices);if(e)IMMDeviceEnumerator_Release(e);CoUninitialize();
    return SUCCEEDED(hr)&&rms>.00001&&hz>430&&hz<450?0:1;
}
