"""Real Windows GUI/server integration, controlled through the app's local CLI.
Changes system default audio temporarily; restores it through normal exit/guard.
"""
from pathlib import Path
import json, re, subprocess, sys, time, urllib.request
ROOT = Path(__file__).resolve().parents[1]
EXE = ROOT/'dist/LanSync.exe'
WORK = ROOT/'work/fixed-buffer'
WORK.mkdir(parents=True,exist_ok=True)
INI = ROOT/'dist/lansync.ini'
old_ini = INI.read_bytes() if INI.exists() else None
def defaults():
    return subprocess.check_output([str(ROOT/'tools/system_audio_probe.exe'),'--defaults']).decode().splitlines()
def launch(*args):
    app=subprocess.Popen([str(EXE),*args])
    deadline=time.monotonic()+10
    while time.monotonic()<deadline:
        try:
            log=(ROOT/'dist/lansync.log').read_text(encoding='utf8')
            url=re.search(r'http://127\.0\.0\.1:\d+/',log).group()
            with urllib.request.urlopen(url+'status',timeout=1) as response:
                status=json.load(response)
            if status['capturing'] and status['rendering']:
                return app,url,status
        except Exception: pass
        if app.poll() is not None:raise RuntimeError(f'app exited {app.returncode}')
        time.sleep(.1)
    app.terminate();raise TimeoutError('startup')
def set_buffer(value):
    return subprocess.run([str(EXE),'--set-buffer-ms',str(value)],timeout=5).returncode
def close(app):
    # Close through the app's documented local command, including normal restore.
    subprocess.run([str(EXE),'--stop'],check=True,timeout=5)
    app.wait(timeout=8)
    assert app.returncode==0
before=defaults();app=None;signal=None;clients=[];report={}
try:
    app,url,status=launch('--buffer-ms','600')
    report['initial_status']=status
    sys.argv=['fixed-buffer',url]
    import network as protocol
    signal=subprocess.Popen([str(ROOT/'tools/system_audio_probe.exe'),'--quiet','90'])
    clients=[protocol.WS(),protocol.WS()]
    changes=[]
    for value in (1200,80,5000,600):
        assert set_buffer(value)==0
        epochs=[];packets=[]
        for ws in clients:
            ws.send({'type':'sync','t0':time.monotonic()*1000})
            while True:
                op,raw=ws.recv()
                if op==1:
                    msg=json.loads(raw)
                    if msg.get('type')=='reset' and msg['latency']==value:
                        epochs.append(msg['epoch']);break
            for _ in range(40):
                p=ws.packet();assert abs(p[2]-p[1]-value)<.001
                assert p[3]==10
                packets.append(p)
        assert len(set(epochs))==1
        changes.append({'buffer_ms':value,'epoch':epochs[0],'packets_checked':len(packets),'duration_ms':10})
    report['manual_changes']=changes
    # High latency/loss reports must never change the selected fixed value.
    assert set_buffer(80)==0
    for ws in clients:ws.close()
    clients=[protocol.WS()]
    deadline=time.monotonic()+25;last=0;checked=0
    while time.monotonic()<deadline:
        now=time.monotonic()
        if now-last>1:
            clients[0].send({'type':'report','ready':1,'required':2900,'rtt':2000,'jitter':900,'output':1900,'late':9999})
            last=now
        p=clients[0].packet();assert abs(p[2]-p[1]-80)<.001 and p[3]==10;checked+=1
    report['slow_peer_fixed_buffer']={'seconds':25,'buffer_ms':80,'packets':checked,'unchanged':True}
    for invalid in ('49','5001','-1','NaN','600x'):
        assert set_buffer(invalid)==2
    report['invalid_inputs_rejected']=True
    assert set_buffer(375)==0
    for ws in clients:ws.close()
    clients=[];close(app);app=None
    assert defaults()==before
    app,url,status=launch()
    assert status['latency']==375
    report['saved_value_after_restart']=375
    # Verify the independent guard restores actual VB-CABLE routing after crash.
    app.kill();app.wait(timeout=5);app=None
    deadline=time.monotonic()+8
    while defaults()!=before and time.monotonic()<deadline:time.sleep(.2)
    assert defaults()==before
    report['normal_exit_and_crash_restore']=True
    report['passed']=True
finally:
    for ws in clients:ws.close()
    if signal and signal.poll() is None:signal.terminate();signal.wait(timeout=5)
    if app and app.poll() is None:app.kill();app.wait(timeout=5);time.sleep(1)
    if old_ini is None:INI.unlink(missing_ok=True)
    else:INI.write_bytes(old_ini)
    (WORK/'integration.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
print(json.dumps(report,ensure_ascii=False,indent=2))
