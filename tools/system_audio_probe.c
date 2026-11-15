/* An independent C audio application. Plays through the Windows default output,
   so LanSync must capture real system audio, not its synthetic test generator. */
#define COBJMACROS
#define INITGUID
#include <windows.h>
#include <mmdeviceapi.h>
#include <mmsystem.h>
#include <stdio.h>
#include <stdlib.h>
#include <math.h>
#include <stdint.h>
static int defaults(void) {
    IMMDeviceEnumerator *e=NULL;CoInitializeEx(NULL,COINIT_MULTITHREADED);
    HRESULT hr=CoCreateInstance(&CLSID_MMDeviceEnumerator,NULL,CLSCTX_ALL,&IID_IMMDeviceEnumerator,(void**)&e);
    if(FAILED(hr))return 1;
    for(int i=0;i<3;++i){IMMDevice *d=NULL;LPWSTR id=NULL;
        hr=IMMDeviceEnumerator_GetDefaultAudioEndpoint(e,eRender,(ERole)i,&d);
        if(SUCCEEDED(hr))hr=IMMDevice_GetId(d,&id);
        if(SUCCEEDED(hr)){wprintf(L"%d %ls\n",i,id);CoTaskMemFree(id);}
        if(d)IMMDevice_Release(d);if(FAILED(hr)){IMMDeviceEnumerator_Release(e);CoUninitialize();return 1;}}
    IMMDeviceEnumerator_Release(e);CoUninitialize();return 0;
}
int main(int argc,char **argv) {
    if(argc==2&&!strcmp(argv[1],"--defaults"))return defaults();
    if(argc!=3||(strcmp(argv[1],"--play")&&strcmp(argv[1],"--pattern")&&strcmp(argv[1],"--quiet")))return 2;
    int quiet=!strcmp(argv[1],"--quiet");
    int pattern=!strcmp(argv[1],"--pattern");uint32_t random=0x12345678;double held=0;
    unsigned seconds=(unsigned)atoi(argv[2]);if(seconds<1||seconds>600)return 2;
    unsigned frames=seconds*48000;short *pcm=malloc((size_t)frames*4);if(!pcm)return 3;
    for(unsigned i=0;i<frames;++i){
        if(i%12==0){random^=random<<13;random^=random>>17;random^=random<<5;held=((int32_t)(random&65535)-32768)/32768.0;}
        double v=pattern?(i%12000<2400?held*.01:0):sin(i*6.283185307179586*440/48000)*.02;
        short value=(short)((quiet?0:v)*32767);
        pcm[i*2]=pcm[i*2+1]=value;}
    WAVEFORMATEX f={.wFormatTag=WAVE_FORMAT_PCM,.nChannels=2,.nSamplesPerSec=48000,
        .nAvgBytesPerSec=192000,.nBlockAlign=4,.wBitsPerSample=16};
    HWAVEOUT out=NULL;MMRESULT result=waveOutOpen(&out,WAVE_MAPPER,&f,0,0,CALLBACK_NULL);
    if(result!=MMSYSERR_NOERROR){free(pcm);fprintf(stderr,"waveOutOpen error %u\n",result);return 4;}
    WAVEHDR header={0};header.lpData=(LPSTR)pcm;header.dwBufferLength=frames*4;
    result=waveOutPrepareHeader(out,&header,sizeof(header));
    if(result==MMSYSERR_NOERROR)result=waveOutWrite(out,&header,sizeof(header));
    while(result==MMSYSERR_NOERROR&&!(header.dwFlags&WHDR_DONE))Sleep(10);
    waveOutReset(out);waveOutUnprepareHeader(out,&header,sizeof(header));waveOutClose(out);free(pcm);
    return result==MMSYSERR_NOERROR?0:5;
}
