#ifndef LANSYNC_CALIBRATE_H
#define LANSYNC_CALIBRATE_H
#include <audioclient.h>
typedef struct ls_calibrator ls_calibrator;
ls_calibrator *ls_cal_create(IAudioCaptureClient *capture);
void ls_cal_destroy(ls_calibrator *c);
void ls_cal_reference(ls_calibrator *c,const float *pcm,unsigned frames,double clock_time);
/* Passive physical-output loopback matching; no extra calibration sound. */
void ls_cal_poll(ls_calibrator *c,double now);
double ls_cal_apply(ls_calibrator *c,unsigned frames);
double ls_cal_confidence(const ls_calibrator *c);
int ls_cal_ready(const ls_calibrator *c);
#endif
