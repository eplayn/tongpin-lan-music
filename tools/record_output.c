/* Independent physical-output loopback recorder, timestamped with WASAPI QPC. */
#define COBJMACROS
#define INITGUID
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
int main(int argc,char **argv) {
    if(argc!=4)return 2;int device_index=atoi(argv[1]),seconds=atoi(argv[2]);
    if(device_index<0||seconds<1||seconds>120)return 2;
    FILE *file=fopen(argv[3],"wb");if(!file)return 3;
    CoInitializeEx(NULL,COINIT_MULTITHREADED);
    IMMDeviceEnumerator *e=NULL;IMMDeviceCollection *list=NULL;IMMDevice *device=NULL;
    IAudioClient *audio=NULL;IAudioCaptureClient *capture=NULL;
    HRESULT hr=CoCreateInstance(&CLSID_MMDeviceEnumerator,NULL,CLSCTX_ALL,&IID_IMMDeviceEnumerator,(void**)&e);
    if(SUCCEEDED(hr))hr=IMMDeviceEnumerator_EnumAudioEndpoints(e,eRender,DEVICE_STATE_ACTIVE,&list);
    if(SUCCEEDED(hr))hr=IMMDeviceCollection_Item(list,(UINT)device_index,&device);
    if(SUCCEEDED(hr))hr=IMMDevice_Activate(device,&IID_IAudioClient,CLSCTX_ALL,NULL,(void**)&audio);
    WAVEFORMATEX f={.wFormatTag=WAVE_FORMAT_IEEE_FLOAT,.nChannels=2,.nSamplesPerSec=48000,
        .nAvgBytesPerSec=384000,.nBlockAlign=8,.wBitsPerSample=32};
    if(SUCCEEDED(hr))hr=IAudioClient_Initialize(audio,AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK|AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM|
        AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,1000000,0,&f,NULL);
    if(SUCCEEDED(hr))hr=IAudioClient_GetService(audio,&IID_IAudioCaptureClient,(void**)&capture);
    if(SUCCEEDED(hr))hr=IAudioClient_Start(audio);
    unsigned packets=0,invalid=0;ULONGLONG begin=GetTickCount64();float silence[960]={0};
    while(SUCCEEDED(hr)&&GetTickCount64()-begin<(ULONGLONG)seconds*1000) {
        UINT32 next=0;hr=IAudioCaptureClient_GetNextPacketSize(capture,&next);if(FAILED(hr))break;
        while(next){BYTE *data=NULL;UINT32 frames=0;DWORD flags=0;UINT64 position=0,qpc=0;
            hr=IAudioCaptureClient_GetBuffer(capture,&data,&frames,&flags,&position,&qpc);if(FAILED(hr))break;
            if(!(flags&AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR)&&qpc){double ms=qpc/10000.0;uint32_t n=frames;
                fwrite(&ms,8,1,file);fwrite(&n,4,1,file);fwrite(&flags,4,1,file);
                if(flags&AUDCLNT_BUFFERFLAGS_SILENT){unsigned left=frames;
                    while(left){unsigned chunk=left>480?480:left;fwrite(silence,8,chunk,file);left-=chunk;}}
                else fwrite(data,8,frames,file);++packets;
            }else ++invalid;
            IAudioCaptureClient_ReleaseBuffer(capture,frames);hr=IAudioCaptureClient_GetNextPacketSize(capture,&next);if(FAILED(hr))break;}
        Sleep(2);
    }
    if(audio)IAudioClient_Stop(audio);if(capture)IAudioCaptureClient_Release(capture);if(audio)IAudioClient_Release(audio);
    if(device)IMMDevice_Release(device);if(list)IMMDeviceCollection_Release(list);if(e)IMMDeviceEnumerator_Release(e);
    CoUninitialize();fclose(file);
    printf("{\"packets\":%u,\"invalid_timestamp_packets\":%u,\"hresult\":%ld}\n",packets,invalid,(long)hr);
    return SUCCEEDED(hr)&&packets?0:1;
}
