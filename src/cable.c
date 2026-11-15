#include "app.h"
#include <shellapi.h>
#include <wintrust.h>
#include <softpub.h>
#include <stdio.h>
static int trusted(const WCHAR *path) {
    WINTRUST_FILE_INFO file={0};file.cbStruct=sizeof(file);file.pcwszFilePath=path;
    WINTRUST_DATA data={0};data.cbStruct=sizeof(data);data.dwUIChoice=WTD_UI_NONE;
    data.fdwRevocationChecks=WTD_REVOKE_NONE;data.dwUnionChoice=WTD_CHOICE_FILE;data.pFile=&file;
    data.dwStateAction=WTD_STATEACTION_VERIFY;data.dwProvFlags=WTD_CACHE_ONLY_URL_RETRIEVAL;
    GUID action=WINTRUST_ACTION_GENERIC_VERIFY_V2;LONG result=WinVerifyTrust(NULL,&action,&data);
    data.dwStateAction=WTD_STATEACTION_CLOSE;WinVerifyTrust(NULL,&action,&data);
    return result==ERROR_SUCCESS;
}
int ls_cable_status(void) {
    int ready=ls_audio_select();int running=0;WCHAR image[1200]=L"";
    SC_HANDLE scm=OpenSCManagerW(NULL,NULL,SC_MANAGER_CONNECT);
    if(scm){SC_HANDLE service=OpenServiceW(scm,L"VBAudioVACMME",SERVICE_QUERY_STATUS|SERVICE_QUERY_CONFIG);
        if(service){SERVICE_STATUS_PROCESS status={0};DWORD n=0;
            if(QueryServiceStatusEx(service,SC_STATUS_PROCESS_INFO,(BYTE*)&status,sizeof(status),&n))running=status.dwCurrentState==SERVICE_RUNNING;
            BYTE buffer[4096];QUERY_SERVICE_CONFIGW *config=(QUERY_SERVICE_CONFIGW*)buffer;
            if(QueryServiceConfigW(service,config,sizeof(buffer),&n)){
                const WCHAR *s=config->lpBinaryPathName;
                if(!_wcsnicmp(s,L"\\SystemRoot\\",12)){WCHAR windows[512];GetWindowsDirectoryW(windows,512);swprintf(image,1200,L"%ls\\%ls",windows,s+12);}
                else lstrcpynW(image,s,1200);}
            CloseServiceHandle(service);}CloseServiceHandle(scm);}
    char source[1024],output[1024];
    WideCharToMultiByte(CP_UTF8,0,g.source_name,-1,source,sizeof(source),NULL,NULL);
    WideCharToMultiByte(CP_UTF8,0,g.output_name,-1,output,sizeof(output),NULL,NULL);
    int signature=image[0]&&trusted(image);
    printf("{\"vbcable_endpoint_ready\":%s,\"driver_running\":%s,\"windows_signature_valid\":%s}\n",
        ready?"true":"false",running?"true":"false",signature?"true":"false");
    printf("Capture: %s\nOutput: %s\n",source,output);
    return ready&&running&&signature?0:1;
}
int ls_cable_install(void) {
    /* Installation is an external prerequisite. This entry point only opens
       the official download page; it never unpacks or launches an installer. */
    HINSTANCE launched=ShellExecuteW(NULL,L"open",L"https://vb-audio.com/Cable/",NULL,NULL,SW_SHOWNORMAL);
    if((INT_PTR)launched<=32){
        MessageBoxW(NULL,L"无法打开浏览器。请手动访问 https://vb-audio.com/Cable/ 下载 VB-CABLE，安装完成并重启 Windows 后再打开本程序。",LS_TITLE,MB_ICONERROR);
        return 1;
    }
    return 0;
}
