"""Inspect the native executable and ensure no driver installer is bundled."""
from pathlib import Path
import struct,subprocess
root=Path(__file__).resolve().parents[1]
exe=(root/'dist/LanSync.exe').read_bytes()
pe=struct.unpack_from('<I',exe,0x3c)[0]
assert exe[pe:pe+4]==b'PE\0\0' and struct.unpack_from('<H',exe,pe+4)[0]==0x8664
assert struct.unpack_from('<H',exe,pe+24+68)[0]==2
# GCC supplies a small Windows manifest (type 24). Installer RCDATA (type 10)
# must be absent; a normal application manifest is unrelated to driver payloads.
resource_rva,resource_size=struct.unpack_from('<II',exe,pe+24+112+2*8)
assert resource_size<8192, 'Unexpected large resource payload'
if resource_rva:
    sections=struct.unpack_from('<H',exe,pe+6)[0]
    table=pe+24+struct.unpack_from('<H',exe,pe+20)[0]
    resource_offset=None
    for i in range(sections):
        virtual_size,rva,raw_size,raw_offset=struct.unpack_from('<IIII',exe,table+i*40+8)
        if rva<=resource_rva<rva+max(virtual_size,raw_size):
            resource_offset=raw_offset+resource_rva-rva;break
    assert resource_offset is not None
    named,ids=struct.unpack_from('<HH',exe,resource_offset+12)
    assert named==0
    types=[struct.unpack_from('<I',exe,resource_offset+16+i*8)[0] for i in range(ids)]
    assert all(t==24 for t in types), f'Unexpected resources: {types}'
assert len(exe)<600_000, 'Unexpected installer-sized executable'
assert 'https://vb-audio.com/Cable/'.encode('utf-16le') in exe
assert b'VBC1' not in exe
for text in ('VBCABLE_Setup_x64.exe','VBCABLE_Setup.exe','vbaudio_cable64_win10.sys'):
    assert text.encode() not in exe and text.encode('utf-16le') not in exe
imports=subprocess.check_output(['objdump','-p',str(root/'dist/LanSync.exe')],text=True)
assert 'CertAddCertificateContextToStore' not in imports
assert 'UpdateDriverForPlugAndPlayDevices' not in imports
assert not any(s in imports.lower() for s in ('libstdc++','python3','node.dll','msys-2.0.dll','libgcc_s','libwinpthread'))
assert 'LanSync Local Driver Test Only'.encode('utf-16le') not in exe
print('PASS: native x64 C application, official download entry only, no embedded driver files, no experimental driver trust/install code, no extra language runtime DLLs')
