"""Package the current native VB-CABLE release, without publishing or signing."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import hashlib
import json

root = Path(__file__).resolve().parents[1]
dist = root / 'dist'
version = '1.1.3'
release = dist / f'LanSync-C-{version}-Windows-x64.zip'
source = dist / f'LanSync-C-{version}-Source.zip'
report = json.loads((root/'tests/verification.json').read_text(encoding='utf-8'))
assert report['version'] == version and report['passed'], 'Verification must pass before packaging'
assert report['executable_sha256'] == hashlib.sha256((dist/'LanSync.exe').read_bytes()).hexdigest(), 'EXE changed since verification'

with ZipFile(release, 'w', ZIP_DEFLATED) as z:
    for local, name in (
        (dist/'LanSync.exe', 'LanSync.exe'),
        (root/'README.md', 'README.md'),
        (root/'LICENSE', 'LICENSE'),
        (root/'THIRD_PARTY_NOTICES.txt', 'THIRD_PARTY_NOTICES.txt'),
        (root/'tests/verification.json', 'verification.json'),
        (root/'tools/Start-Test.cmd', 'Start-Test.cmd'),
    ):
        z.write(local, name)
with ZipFile(source, 'w', ZIP_DEFLATED) as z:
    allowed = {'.c', '.h', '.html', '.js', '.cjs', '.ps1', '.py', '.json', '.cmd'}
    for folder in ('src', 'web', 'tests', 'tools'):
        for p in sorted((root/folder).rglob('*')):
            if not p.is_file() or p.suffix not in allowed or '__pycache__' in p.parts:
                continue
            if p.name in ('web_assets.h', 'last-output.json', 'test_cert_pin.h'):
                continue
            z.write(p, p.relative_to(root).as_posix())
    for name in ('build.ps1', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.txt', '.gitignore', '.gitattributes', '.github/workflows/build.yml'):
        z.write(root/name, name)
for path in (release, source):
    with ZipFile(path) as z:
        assert z.testzip() is None
        assert not any(name.lower().endswith(('.pfx', '.key', '.pem')) for name in z.namelist())
        assert not any(name.lower().endswith(('.sys', '.cat', '.inf', '.zip')) for name in z.namelist()), 'No driver packages in release or source archive'
hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in (dist/'LanSync.exe', release, source)}
(dist/'SHA256.json').write_text(json.dumps(hashes, indent=2)+'\n', encoding='utf-8')
print(json.dumps(hashes, indent=2))
