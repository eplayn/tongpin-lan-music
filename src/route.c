#include "app.h"
#include <mmdeviceapi.h>
#include <stdio.h>
#include <shellapi.h>
/* Windows PolicyConfig COM ABI. This interface is undocumented; failure is
   reported and the caller restores every role already changed. */
typedef struct policy policy;
typedef struct {
    HRESULT (STDMETHODCALLTYPE *query)(policy*,REFIID,void**);
    ULONG (STDMETHODCALLTYPE *addref)(policy*);
    ULONG (STDMETHODCALLTYPE *release)(policy*);
    void *unused[10];
    HRESULT (STDMETHODCALLTYPE *set_default)(policy*,LPCWSTR,ERole);
    void *visibility;
} policy_vtable;
struct policy {const policy_vtable *lpVtbl;};
static const GUID policy_class={0x870af99c,0x171d,0x4f9e,{0xaf,0x0d,0xe6,0x3d,0xf4,0x0c,0x2b,0xc9}};
static const GUID policy_iid={0xf8679f50,0x850a,0x41cf,{0x9c,0x72,0x43,0x0f,0x29,0x02,0x90,0xc8}};
typedef struct {DWORD magic;WCHAR target[512];WCHAR saved[3][512];} route_state;
static WCHAR state_path[1024];
static HRESULT default_id(IMMDeviceEnumerator *e,ERole role,WCHAR *out) {
    IMMDevice *d=NULL;LPWSTR id=NULL;
    HRESULT hr=IMMDeviceEnumerator_GetDefaultAudioEndpoint(e,eRender,role,&d);
    if(SUCCEEDED(hr))hr=IMMDevice_GetId(d,&id);
    if(SUCCEEDED(hr)){lstrcpynW(out,id,512);CoTaskMemFree(id);}
    if(d)IMMDevice_Release(d);return hr;
}
static int restore_file(const WCHAR *path) {
    route_state st;HANDLE f=CreateFileW(path,GENERIC_READ,FILE_SHARE_READ,NULL,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,NULL);
    if(f==INVALID_HANDLE_VALUE)return 1;
    DWORD n=0;BOOL ok=ReadFile(f,&st,sizeof(st),&n,NULL);CloseHandle(f);
    if(!ok||n!=sizeof(st)||st.magic!=0x4c535254)return 0;
    st.target[511]=0;for(int i=0;i<3;++i)st.saved[i][511]=0;
    IMMDeviceEnumerator *e=NULL;policy *p=NULL;
    HRESULT hr=CoCreateInstance(&CLSID_MMDeviceEnumerator,NULL,CLSCTX_ALL,&IID_IMMDeviceEnumerator,(void**)&e);
    if(SUCCEEDED(hr))hr=CoCreateInstance(&policy_class,NULL,CLSCTX_ALL,&policy_iid,(void**)&p);
    if(FAILED(hr)){if(e)IMMDeviceEnumerator_Release(e);return 0;}
    int restored=1;
    for(int i=0;i<3;++i) {
        WCHAR current[512]=L"";
        if(FAILED(default_id(e,(ERole)i,current))){restored=0;continue;}
        /* Respect a device choice the user made while sharing was active. */
        if(!wcscmp(current,st.target)&&st.saved[i][0])
            if(FAILED(p->lpVtbl->set_default(p,st.saved[i],(ERole)i)))restored=0;
    }
    p->lpVtbl->release(p);IMMDeviceEnumerator_Release(e);
    if(restored)DeleteFileW(path);return restored;
}
void ls_route_restore(void) {
    if(!state_path[0]) {
        GetModuleFileNameW(NULL,state_path,1024);WCHAR *p=wcsrchr(state_path,L'\\');
        if(p)lstrcpyW(p+1,L"lansync-route.dat");
    }
    restore_file(state_path);
}
int ls_route_begin(void) {
    if(g.no_route||g.test_tone)return 1;
    ls_route_restore();
    if(GetFileAttributesW(state_path)!=INVALID_FILE_ATTRIBUTES) {
        lstrcpynW(g.error,L"上次的默认音频设备尚未恢复；为避免覆盖恢复记录，本次不改变音频路由。",512);return 0;
    }
    route_state st={0};st.magic=0x4c535254;lstrcpynW(st.target,g.source_id,512);
    IMMDeviceEnumerator *e=NULL;policy *p=NULL;
    HRESULT hr=CoCreateInstance(&CLSID_MMDeviceEnumerator,NULL,CLSCTX_ALL,&IID_IMMDeviceEnumerator,(void**)&e);
    if(SUCCEEDED(hr))for(int i=0;i<3;++i){hr=default_id(e,(ERole)i,st.saved[i]);if(FAILED(hr))break;}
    if(e)IMMDeviceEnumerator_Release(e);
    if(SUCCEEDED(hr))hr=CoCreateInstance(&policy_class,NULL,CLSCTX_ALL,&policy_iid,(void**)&p);
    if(FAILED(hr)){ls_error(L"读取默认音频路由",hr);return 0;}
    HANDLE f=CreateFileW(state_path,GENERIC_WRITE,0,NULL,CREATE_NEW,FILE_ATTRIBUTE_NORMAL|FILE_FLAG_WRITE_THROUGH,NULL);
    DWORD n=0;BOOL saved=f!=INVALID_HANDLE_VALUE&&WriteFile(f,&st,sizeof(st),&n,NULL)&&n==sizeof(st);
    if(f!=INVALID_HANDLE_VALUE)CloseHandle(f);
    if(!saved){p->lpVtbl->release(p);ls_error(L"保存音频路由恢复记录",HRESULT_FROM_WIN32(GetLastError()));return 0;}
    WCHAR event_name[128],exe[1024],command[2400];
    swprintf(event_name,128,L"Local\\LanSyncGuard-%lu",GetCurrentProcessId());
    HANDLE event=CreateEventW(NULL,TRUE,FALSE,event_name);GetModuleFileNameW(NULL,exe,1024);
    swprintf(command,2400,L"\"%ls\" --guard %lu \"%ls\" \"%ls\"",exe,GetCurrentProcessId(),state_path,event_name);
    STARTUPINFOW si={0};si.cb=sizeof(si);PROCESS_INFORMATION pi={0};
    BOOL created=event&&CreateProcessW(exe,command,NULL,NULL,FALSE,CREATE_NO_WINDOW,NULL,NULL,&si,&pi);
    int ready=created&&WaitForSingleObject(event,5000)==WAIT_OBJECT_0;
    if(created){CloseHandle(pi.hThread);CloseHandle(pi.hProcess);}if(event)CloseHandle(event);
    if(!ready){DeleteFileW(state_path);p->lpVtbl->release(p);
        lstrcpynW(g.error,L"无法启动音频路由恢复守护进程；未改变默认音频设备。",512);return 0;}
    for(int i=0;i<3;++i){hr=p->lpVtbl->set_default(p,g.source_id,(ERole)i);if(FAILED(hr))break;}
    p->lpVtbl->release(p);
    if(FAILED(hr)){restore_file(state_path);ls_error(L"切换默认音频设备",hr);return 0;}
    return 1;
}
int ls_guard(DWORD parent,const WCHAR *path,const WCHAR *event_name) {
    HANDLE process=OpenProcess(SYNCHRONIZE,FALSE,parent);
    HANDLE event=OpenEventW(EVENT_MODIFY_STATE,FALSE,event_name);
    if(!process||!event){if(process)CloseHandle(process);if(event)CloseHandle(event);return 1;}
    SetEvent(event);CloseHandle(event);WaitForSingleObject(process,INFINITE);CloseHandle(process);
    CoInitializeEx(NULL,COINIT_MULTITHREADED);
    int ok=0;for(int i=0;i<5&&!ok;++i){ok=restore_file(path);if(!ok)Sleep(1000);}
    CoUninitialize();return ok?0:1;
}
