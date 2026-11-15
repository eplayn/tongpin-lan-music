"""Sustained real VB-CABLE stream over the actual native WebSocket server.
All clients are on this computer; this is not a multi-device acoustic test.
"""
from pathlib import Path
import sys,time,threading,subprocess,struct,json
URL=sys.argv[1];duration=int(sys.argv[2]) if len(sys.argv)>2 else 180
sys.argv=['soak',URL]
import network as protocol
ROOT=Path(__file__).resolve().parents[1]
results=[];lock=threading.Lock()
def client(index):
    result={'client':index,'packets':0,'sequence_gaps':0,'time_regressions':0,'error':None}
    ws=None
    try:
        ws=protocol.WS();deadline=time.monotonic()+duration;last_clock=0;previous=None;previous_time=None
        while time.monotonic()<deadline:
            now=time.monotonic()
            if now-last_clock>1:
                ws.send({'type':'sync','t0':now*1000});last_clock=now
            op,b=ws.recv()
            if op!=2:continue
            magic,sequence,captured,play,span,rate,frames,channels,fmt=struct.unpack('<4sIdddIHBB',b[:40])
            assert magic==b'LSA1' and rate==48000 and channels==2 and fmt==1 and len(b)==40+frames*4
            if previous is not None and sequence!=((previous+1)&0xffffffff):result['sequence_gaps']+=1
            if previous_time is not None and play<previous_time:result['time_regressions']+=1
            previous=sequence;previous_time=play;result['packets']+=1
    except BaseException as error:result['error']=repr(error)
    finally:
        if ws:ws.close()
        with lock:results.append(result)

signal=subprocess.Popen([str(ROOT/'tools/system_audio_probe.exe'),'--quiet',str(duration+5)])
time.sleep(.2)
threads=[threading.Thread(target=client,args=(i,)) for i in range(4)]
for thread in threads:thread.start()
for thread in threads:thread.join()
signal.wait(timeout=8)
_,body=protocol.http('/status');status=json.loads(body)
passed=all(not x['error'] and not x['sequence_gaps'] and not x['time_regressions'] and x['packets']>=duration*80 for x in results)
report={'duration_seconds':duration,'actual_vbcable_stream':status.get('sourceIsCable',False),
    'all_clients_same_machine':True,'clients':sorted(results,key=lambda x:x['client']),
    'final_status':status,'passed':passed}
(ROOT/'work/vb-cable/soak.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
if not passed:raise SystemExit(1)
