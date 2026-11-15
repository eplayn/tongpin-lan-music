/* Build-tool launcher: keep compiler crashes in the build log, not modal UI. */
#include <windows.h>
#include <process.h>
#include <stdint.h>
int wmain(int argc,wchar_t **argv) {
    if(argc<2)return 2;
    SetErrorMode(SEM_FAILCRITICALERRORS|SEM_NOGPFAULTERRORBOX|SEM_NOOPENFILEERRORBOX);
    intptr_t result=_wspawnvp(_P_WAIT,argv[1],(const wchar_t *const *)(argv+1));
    return result<0?127:(int)result;
}
