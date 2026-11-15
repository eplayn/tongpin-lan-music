"""Compare actual hardware-loopback timestamps against server PCM deadlines.
This is a driver/clock measurement, not a microphone acoustic measurement.
"""
from pathlib import Path
import sys,time,subprocess,struct,json
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'work/analysis-libs'))
import numpy as np
URL=sys.argv[1];device=sys.argv[2]
sys.argv=['measure_host_timing',URL]
import network as protocol

out=ROOT/'work/vb-cable/physical-timing.pcm'
capture=subprocess.Popen([str(ROOT/'tools/record_output.exe'),device,'14',str(out)],stdout=subprocess.PIPE,text=True)
time.sleep(.2)
signal=subprocess.Popen([str(ROOT/'tools/system_audio_probe.exe'),'--pattern','12'])
ws=protocol.WS();packets=[];deadline=time.monotonic()+12.5
while time.monotonic()<deadline:
    op,b=ws.recv()
    if op==2:
        magic,seq,stamp,play,duration,rate,frames,channels,fmt=struct.unpack('<4sIdddIHBB',b[:40])
        if frames:
            pcm=np.frombuffer(b[40:],dtype='<i2').astype(float).reshape(-1,2)[:,0]/32768
            packets.append((play,duration,pcm))
ws.close();signal.wait(timeout=5);capture_text=capture.communicate(timeout=5)[0]
actual=[];data=out.read_bytes();position=0
while position<len(data):
    stamp,frames,flags=struct.unpack_from('<dII',data,position);position+=16
    pcm=np.frombuffer(data,dtype='<f4',count=frames*2,offset=position).reshape(-1,2)[:,0].copy()
    position+=frames*8;actual.append((stamp,pcm))
assert packets and actual
origin=min(packets[0][0],actual[0][0]);end=max(actual[-1][0]+len(actual[-1][1])/48,packets[-1][0]+packets[-1][1])
n=int((end-origin)*48)+4800;expected=np.zeros(n);observed=np.zeros(n)
for stamp,duration,pcm in packets:
    a=max(0,round((stamp-origin)*48));length=max(1,round(duration*48));b=min(n,a+length)
    expected[a:b]=np.interp(np.arange(b-a)*len(pcm)/length,np.arange(len(pcm)),pcm)
for stamp,pcm in actual:
    a=max(0,round((stamp-origin)*48));b=min(n,a+len(pcm));observed[a:b]=pcm[:b-a]
lags=np.arange(-4800,4801);measurements=[];coherences=[]
for start in range(5*48000,n-96000,96000):
    x=expected[start:start+96000];y=observed[start:start+96000]
    if np.dot(x,x)<1e-5 or np.dot(y,y)<1e-5:continue
    size=1<<(len(x)*2-1).bit_length()
    correlation=np.fft.irfft(np.fft.rfft(y,size)*np.conj(np.fft.rfft(x,size)),size)
    local=correlation[lags%size];index=int(np.argmax(np.abs(local)))
    measurements.append(float(lags[index]/48))
    coherences.append(float(abs(local[index])/np.sqrt(np.dot(x,x)*np.dot(y,y))))
assert len(measurements)>=3,'Insufficient independent signal segments'
result={'measurement':'WASAPI physical output vs shared packet play deadlines','acoustic_measurement':False,
    'initial_calibration_warmup_excluded_seconds':5,
    'median_output_offset_ms':float(np.median(measurements)),'max_abs_output_offset_ms':float(np.max(np.abs(measurements))),
    'segment_offsets_ms':measurements,'segment_correlations':coherences,'recorder':json.loads(capture_text),
    'source_packets':len(packets),'passed':max(abs(v) for v in measurements)<20 and min(coherences)>.4}
(ROOT/'work/vb-cable/host-timing.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
if not result['passed']:raise SystemExit(1)
