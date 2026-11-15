#include "sync.h"
#include <math.h>
#include <string.h>
void ls_timeline_init(ls_timeline *t, double now) {
    (void)now;t->buffer_ms=LS_BUFFER_DEFAULT;
}
double ls_delay(const ls_timeline *t, double capture_time) {
    (void)capture_time;return t->buffer_ms;
}
double ls_play(const ls_timeline *t, double capture_time) {
    return capture_time + ls_delay(t, capture_time);
}
int ls_buffer_parse(const char *text,unsigned *value) {
    if(!text||!*text||!value)return 0;
    unsigned n=0;
    for(const char *p=text;*p;++p){if(*p<'0'||*p>'9'||n>LS_BUFFER_MAX)return 0;n=n*10+(unsigned)(*p-'0');}
    if(n<LS_BUFFER_MIN||n>LS_BUFFER_MAX)return 0;
    *value=n;return 1;
}
int ls_timeline_set(ls_timeline *t,unsigned buffer_ms) {
    if(buffer_ms<LS_BUFFER_MIN||buffer_ms>LS_BUFFER_MAX)return 0;
    t->buffer_ms=buffer_ms;return 1;
}
int ls_clock_sample(double t0, double t1, double t2, double t3,
                    double *offset, double *rtt) {
    double delay = (t3 - t0) - (t2 - t1);
    if (!isfinite(delay) || delay < 0 || delay > 2000 || t2 < t1 || t3 < t0)
        return 0;
    *offset = ((t1 - t0) + (t2 - t3)) / 2;
    *rtt = delay;
    return isfinite(*offset);
}
static void u32(unsigned char *d, uint32_t x) {
    for (int i = 0; i < 4; ++i) d[i] = (unsigned char)(x >> (i * 8));
}
unsigned ls_pack(const ls_packet *p, unsigned char *out, unsigned capacity) {
    unsigned bytes = 40 + p->frames * LS_CHANNELS * 2;
    if (!p->frames || p->frames > LS_FRAMES || capacity < bytes) return 0;
    memcpy(out, "LSA1", 4);
    u32(out + 4, (uint32_t)p->seq);
    memcpy(out + 8, &p->captured, 8);
    memcpy(out + 16, &p->play, 8);
    memcpy(out + 24, &p->duration, 8);
    u32(out + 32, LS_RATE);
    out[36] = (unsigned char)p->frames;
    out[37] = (unsigned char)(p->frames >> 8);
    out[38] = LS_CHANNELS;
    out[39] = 1; /* signed 16-bit little endian */
    memcpy(out + 40, p->pcm, bytes - 40);
    return bytes;
}
