#include "app.h"
#include <shellapi.h>
#include <stdio.h>
int ls_allow_lan(void) {
    WCHAR exe[1024],netsh[1200],arguments[2600],message[1800];
    GetModuleFileNameW(NULL,exe,1024);GetSystemDirectoryW(netsh,1100);lstrcatW(netsh,L"\\netsh.exe");
    swprintf(message,1800,L"将为本程序添加 Windows 防火墙入站规则：\n专用网络 / 本地子网 / TCP %u。\n\n这会允许同一局域网设备连接当前程序。Windows 会要求你确认管理员授权。是否继续？",g.port);
    if(MessageBoxW(NULL,message,LS_TITLE,MB_OKCANCEL|MB_ICONINFORMATION)!=IDOK)return 1;
    swprintf(arguments,2600,L"advfirewall firewall add rule name=\"LanSync-C-Private-%u\" dir=in action=allow enable=yes profile=private remoteip=LocalSubnet protocol=TCP localport=%u program=\"%ls\"",g.port,g.port,exe);
    SHELLEXECUTEINFOW info={0};info.cbSize=sizeof(info);info.fMask=SEE_MASK_NOCLOSEPROCESS;
    info.lpVerb=L"runas";info.lpFile=netsh;info.lpParameters=arguments;info.nShow=SW_HIDE;
    if(!ShellExecuteExW(&info)){MessageBoxW(NULL,L"未获得管理员授权，防火墙规则未添加。",LS_TITLE,MB_ICONWARNING);return 1;}
    DWORD code=1;if(info.hProcess){WaitForSingleObject(info.hProcess,INFINITE);GetExitCodeProcess(info.hProcess,&code);CloseHandle(info.hProcess);}
    MessageBoxW(NULL,code?L"规则添加未成功。可在 Windows 防火墙提示中允许本程序通过专用网络。":L"已添加专用局域网规则。若网页仍无法打开，请检查设备是否处于同一局域网，以及路由器是否开启访客隔离。",LS_TITLE,code?MB_ICONWARNING:MB_ICONINFORMATION);
    return code?1:0;
}
