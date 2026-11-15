#ifndef LANSYNC_SYNC_H
#define LANSYNC_SYNC_H
#include <stdint.h>
#define LS_RATE 48000
#define LS_CHANNELS 2
#define LS_FRAMES 480
#define LS_RING 1024
#define LS_MAX_CLIENTS 32
#define LS_BUFFER_DEFAULT 600
#define LS_BUFFER_MIN 50
#define LS_BUFFER_MAX 5000
typedef struct {
    uint64_t seq;
    unsigned epoch;
    double captured, play, duration;
    unsigned frames;
    int16_t pcm[LS_FRAMES * LS_CHANNELS];
} ls_packet;
typedef struct {
    unsigned buffer_ms;
} ls_timeline;
typedef struct {
    int active, ready;
    double updated, since, required, rtt, jitter, output;
    unsigned late;
} ls_peer;
void ls_timeline_init(ls_timeline *t, double now);
double ls_delay(const ls_timeline *t, double capture_time);
double ls_play(const ls_timeline *t, double capture_time);
int ls_buffer_parse(const char *text, unsigned *value);
int ls_timeline_set(ls_timeline *t, unsigned buffer_ms);
/* NTP four timestamps: local send, server receive, server send, local receive. */
int ls_clock_sample(double t0, double t1, double t2, double t3,
                    double *offset, double *rtt);
unsigned ls_pack(const ls_packet *p, unsigned char *out, unsigned capacity);
#endif
