#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
typedef LONG (WINAPI *query_fn)(ULONG,PVOID,ULONG,PULONG);
int main(void){struct{ULONG length,options;}ci={8,0};HMODULE n=GetModuleHandleW(L"ntdll.dll");query_fn q=(query_fn)(void*)GetProcAddress(n,"NtQuerySystemInformation");LONG status=q?q(103,&ci,sizeof(ci),NULL):-1;TOKEN_ELEVATION elevation={0};DWORD size=0;HANDLE token=NULL;if(OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&token)){GetTokenInformation(token,TokenElevation,&elevation,sizeof(elevation),&size);CloseHandle(token);}SYSTEM_INFO si;GetNativeSystemInfo(&si);printf("{\"ci_query_status\":%ld,\"ci_options\":%lu,\"test_signing\":%s,\"hvci_enabled\":%s,\"elevated\":%s,\"cpu_arch\":%u,\"virtualization_firmware\":%s}\n",status,ci.options,(ci.options&2)?"true":"false",(ci.options&0x400)?"true":"false",elevation.TokenIsElevated?"true":"false",si.wProcessorArchitecture,IsProcessorFeaturePresent(21)?"true":"false");return status<0?1:0;}
