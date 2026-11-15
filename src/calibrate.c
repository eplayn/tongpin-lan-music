#define COBJMACROS
#include <windows.h>
#include "calibrate.h"
#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#define CAL_SLOTS 8192
#define CAL_WINDOW 512
typedef struct {int64_t stamp;float value;} cal_sample;
struct ls_calibrator {
    IAudioCaptureClient *capture;
    cal_sample reference[CAL_SLOTS],observed[CAL_SLOTS];
    int64_t latest;
    double last_analysis,target,applied,candidate,confidence;
    unsigned stable;
    int ready;
};
ls_calibrator *ls_cal_create(IAudioCaptureClient *capture) {
    if(!capture)return NULL;
    ls_calibrator *c=calloc(1,sizeof(*c));if(c)c->capture=capture;return c;
}
void ls_cal_destroy(ls_calibrator *c){free(c);}
static void put(cal_sample *ring,int64_t t,float value) {
    if(t<=0)return;unsigned slot=(unsigned)((uint64_t)t%CAL_SLOTS);
    ring[slot].stamp=t;ring[slot].value=value;
}
void ls_cal_reference(ls_calibrator *c,const float *pcm,unsigned frames,double clock_time) {
    if(!c)return;
    for(unsigned i=0;i<frames;i+=24){int64_t t=(int64_t)llround((clock_time+i/48.0)*2);
        put(c->reference,t,(pcm[i*2]+pcm[i*2+1])*.5f);}
}
static double coefficient(ls_calibrator *c,int64_t end,int lag,unsigned *points) {
    double sx=0,sy=0,xx=0,yy=0,xy=0;unsigned n=0;
    for(int i=0;i<CAL_WINDOW;++i){int64_t t=end-i,r=t-lag;
        if(r<=0||t<=0)continue;
        cal_sample *x=&c->reference[(uint64_t)r%CAL_SLOTS],*y=&c->observed[(uint64_t)t%CAL_SLOTS];
        if(x->stamp!=r||y->stamp!=t)continue;
        double a=x->value,b=y->value;sx+=a;sy+=b;xx+=a*a;yy+=b*b;xy+=a*b;++n;}
    *points=n;if(n<400)return 0;
    xx-=sx*sx/n;yy-=sy*sy/n;xy-=sx*sy/n;
    if(xx<1e-8||yy<1e-8)return 0;
    return xy/sqrt(xx*yy);
}
void ls_cal_poll(ls_calibrator *c,double now) {
    if(!c)return;UINT32 next=0;HRESULT hr=IAudioCaptureClient_GetNextPacketSize(c->capture,&next);
    if(FAILED(hr))return;
    while(next){BYTE *data=NULL;UINT32 frames=0;DWORD flags=0;UINT64 position=0,qpc=0;
        hr=IAudioCaptureClient_GetBuffer(c->capture,&data,&frames,&flags,&position,&qpc);if(FAILED(hr))break;
        if(qpc&&!(flags&AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR)){
            for(unsigned i=0;i<frames;i+=24){int64_t t=(int64_t)llround((qpc/10000.0+i/48.0)*2);
                float value=flags&AUDCLNT_BUFFERFLAGS_SILENT?0:(((float*)data)[i*2]+((float*)data)[i*2+1])*.5f;
                put(c->observed,t,value);if(t>c->latest)c->latest=t;}}
        IAudioCaptureClient_ReleaseBuffer(c->capture,frames);
        hr=IAudioCaptureClient_GetNextPacketSize(c->capture,&next);if(FAILED(hr))break;}
    if(now-c->last_analysis<750||!c->latest)return;c->last_analysis=now;
    double scores[1081],best=0;int best_lag=0;int64_t end=c->latest-32;
    for(int lag=-80;lag<=1000;++lag){unsigned points=0;double score=fabs(coefficient(c,end,lag,&points));
        scores[lag+80]=score;if(score>best){best=score;best_lag=lag;}}
    double other=0;for(int lag=-80;lag<=1000;++lag)
        if(abs(lag-best_lag)>12&&scores[lag+80]>other)other=scores[lag+80];
    /* Pure tones and low-information signals have repeated peaks. Do not use
       those to invent a delay measurement; wait for identifiable source audio. */
    if(best<.35||best-other<.035)return;
    double measured=best_lag*.5;
    if(!c->stable||fabs(measured-c->candidate)>3){c->candidate=measured;c->stable=1;return;}
    c->candidate=(c->candidate+measured)*.5;++c->stable;
    if(c->stable>=2){c->target=c->candidate;c->confidence=best;c->ready=1;}
}
double ls_cal_apply(ls_calibrator *c,unsigned frames) {
    if(!c)return 0;
    (void)frames;
    /* Discrete phase correction: the renderer inserts silence or discards late
       samples. Never slew the sample rate to approach a device measurement. */
    if(c->ready&&fabs(c->target-c->applied)>=2)c->applied=c->target;
    return c->applied;
}
double ls_cal_confidence(const ls_calibrator *c){return c?c->confidence:0;}
int ls_cal_ready(const ls_calibrator *c){return c?c->ready:0;}
