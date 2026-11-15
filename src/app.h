#ifndef LANSYNC_APP_H
#define LANSYNC_APP_H
#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <objbase.h>
#include "sync.h"
#define LS_TITLE L"同频 C · 局域网音频共享"
#define LS_ENDPOINT_NAME L"CABLE Input (VB-Audio Virtual Cable)"
typedef struct {
    CRITICAL_SECTION lock;
    HANDLE stop;
    ls_packet ring[LS_RING];
    uint64_t next_seq;
    uint64_t first_seq;
    unsigned epoch;
    ls_timeline timeline;
    ls_peer peers[LS_MAX_CLIENTS];
    volatile LONG capturing, rendering, workers, serving;
    double host_required, host_error, capture_peak;
    double host_calibration, host_calibration_confidence, last_audio_data;
    int host_calibrated;
    unsigned capture_gaps, host_gaps;
    unsigned port;
    int test_tone, headless, duration, no_route;
    int source_index, output_index;
    WCHAR source_id[512], output_id[512];
    WCHAR source_name[256], output_name[256], error[512];
    char urls[2048];
    SOCKET listener;
    HWND window;
} ls_app;
extern ls_app g;
double ls_now(void);
void ls_error(const WCHAR *where, HRESULT hr);
void ls_log(const char *format, ...);
void ls_publish(const int16_t *pcm, unsigned frames, double capture_time);
int ls_packet_read(uint64_t seq, ls_packet *p);
int ls_audio_select(void);
void ls_audio_devices(void);
DWORD WINAPI ls_capture_thread(void *unused);
DWORD WINAPI ls_render_thread(void *unused);
DWORD WINAPI ls_server_thread(void *unused);
int ls_route_begin(void);
void ls_route_restore(void);
int ls_guard(DWORD parent, const WCHAR *state_file, const WCHAR *event_name);
int ls_cable_install(void);
int ls_cable_status(void);
int ls_allow_lan(void);
#endif
