import test from 'node:test';
import assert from 'node:assert/strict';
import {AdaptiveBuffer} from '../lib/adaptive-buffer.mjs';
import {LiveRoom} from '../lib/live-room.mjs';
import {PlaybackMetrics} from '../public/live/playback-metrics.mjs';
import {makePacket,readPacket,PacketReader,withPlayout,TIMED_HEADER_BYTES} from '../public/live/protocol.mjs';

function client(now,extra={}){return{id:'device',enabled:true,stream:true,ready:true,contextState:'running',lastSeen:now,outputLatencyMs:50,uncertaintyMs:2,advanceMs:0,error:'',metrics:{serial:now,samples:100,lastSampleAgoMs:0,arrivalP98Ms:70,arrivalMedianMs:60,phaseP98Ms:1,late:0,underruns:0,sourceDrops:0},...extra};}
test('adaptive starts at 1000 and converges smoothly above measured floor without discontinuities',()=>{
  const a=new AdaptiveBuffer(0);assert.equal(a.valueAt(0),1000);
  let previousTarget=1000,changes=0;
  for(let time=40;time<=600000;time+=40){
    a.observeUpload(time,50);const at=time-40,before=a.playoutAt(at);
    a.step(time,at,[client(time)]);
    assert.ok(Math.abs(a.playoutAt(at)-before)<.00001,'replacing a ramp must preserve its boundary');
    const duration=a.playoutAt(at+40)-a.playoutAt(at);
    assert.ok(duration>=39.19&&duration<=41.21,'time mapping stays monotonic with bounded speed');
    assert.ok(a.target>=a.estimatedFloor&&a.target>=100);
    if(a.target!==previousTarget){assert.ok(previousTarget-a.target<=200);changes++;previousTarget=a.target;}
  }
  assert.ok(changes>=5);assert.ok(a.target<300);assert.ok(a.target>=a.stabilityFloor+60,'converges with a measured safety cushion');
});
test('slow online hardware raises shared budget; offline devices cannot hold it or pause playback',()=>{
  const a=new AdaptiveBuffer(0);for(let t=40;t<=200000;t+=40){a.observeUpload(t,50);a.step(t,t-40,[client(t)]);}
  const prior=a.target,slow=client(204000,{id:'slow',outputLatencyMs:220,metrics:{...client(204000).metrics,arrivalP98Ms:400,arrivalMedianMs:390}});
  a.observeUpload(204000,60);const boundary=a.playoutAt(203960);a.step(204000,203960,[client(204000),slow]);
  for(let t=205000;t<=206000;t+=1000){slow.lastSeen=t;slow.metrics.serial=t;a.observeUpload(t,60);a.step(t,t-40,[client(t),slow]);}
  assert.ok(a.target>=670&&a.target>prior);assert.ok(Number.isFinite(boundary));
  const offline=new AdaptiveBuffer(0);for(let t=40;t<=600000;t+=40){offline.observeUpload(t,50);offline.step(t,t-40,[client(t),{...slow,lastSeen:0,enabled:false,stream:false}]);}
  assert.ok(offline.target<300);
});
test('sustained fresh deadline failures back off; repeated and missing reports cannot raise delay',()=>{
  const a=new AdaptiveBuffer(0);for(let t=40;t<=12000;t+=40){a.observeUpload(t,50);a.step(t,t-40,[client(t)]);}
  let bad;
  for(let t=13000;t<=15000;t+=1000){bad=client(t);bad.metrics.late=(t-12000)/1000;a.observeUpload(t,50);a.step(t,t-40,[bad]);}
  const raised=a.target;assert.ok(raised> a.valueAt(14960));assert.equal(a.holdUntil,23000);
  a.observeUpload(16000,50);bad.lastSeen=16000;a.step(16000,15960,[bad]);assert.equal(a.target,raised);
  const missing=new AdaptiveBuffer(0);for(let t=40;t<=40000;t+=40){missing.observeUpload(t,50);missing.step(t,t-40,[{...client(t),metrics:null}]);}assert.equal(missing.target,1000);
});
test('timed framing survives byte-at-a-time transfer and preserves PCM exactly',()=>{
  const pcm=new Float32Array(1920);pcm[1]=.125;pcm[100]=-.75;
  const original=makePacket({generation:1,sequence:0,sampleRate:48000,channels:2,frames:960,captureMs:1000},pcm);
  const timed=withPlayout(original,2000,2019.9),reader=new PacketReader();let packets=[];
  for(const byte of timed)packets.push(...reader.push(new Uint8Array([byte])));
  assert.equal(packets.length,1);const p=packets[0];assert.equal(p.headerBytes,TIMED_HEADER_BYTES);assert.equal(p.playoutMs,2000);assert.equal(p.playoutEndMs,2019.9);
  assert.deepEqual(p.bytes.subarray(p.headerBytes),original.subarray(32));
  const bad=timed.slice();new DataView(bad.buffer).setFloat64(40,NaN,true);assert.throws(()=>readPacket(bad),/播放时间/);
});
test('server stamps immutable shared playout times through shrinking and growing ramps, skips backlog without ending source',()=>{
  let time=10000;const out=[],r=new LiveRoom({now:()=>time,bufferMode:'adaptive',onAudio:b=>out.push(readPacket(b))});
  const h=r.hello({id:'aaaaaaaaaaaaaaaa'}),c=r.auth(h.id,h.token);r.stream(c,true);
  const beat=()=>r.heartbeat(c,{enabled:true,ready:true,contextState:'running',uncertaintyMs:2,outputLatencyMs:60,advanceMs:0,bufferGeneration:r.generation,bufferedPackets:3});beat();r.takeControl(c);r.beginSource(c);
  let sequence=0;const frame=(gap=0)=>{sequence+=gap;r.receive(c,makePacket({generation:r.generation,sequence:sequence++,captureMs:time-40,sampleRate:48000,channels:2,frames:1920},new Float32Array(3840)));time+=40;};
  for(let i=0;i<3;i++)frame();beat();const revision=r.revision,anchor=r.playFromMs;
  r.adaptive.setTarget(500,time,r.lastCaptureEnd);
  for(let i=0;i<200;i++)frame();
  r.adaptive.setTarget(1400,time,r.lastCaptureEnd);
  for(let i=0;i<200;i++)frame();
  for(let i=1;i<out.length;i++)assert.ok(Math.abs(out[i].playoutMs-out[i-1].playoutEndMs)<.00001);
  assert.equal(r.revision,revision);assert.equal(r.playFromMs,anchor);frame(12);assert.equal(r.sourceId,c.id);
  beat();time+=1800;r.tick();assert.equal(r.status,'playing');time+=3300;r.tick();assert.equal(r.status,'ended');
});
test('metrics ignore reconnect history and expire stale samples',()=>{
  let t=0;const m=new PlaybackMetrics(()=>t);m.reset(2);m.arrival({captureMs:100},1000);assert.equal(m.snapshot().samples,0);
  t=2100;for(let i=0;i<20;i++)m.arrival({captureMs:1000},1060+i);m.miss();m.phase(-20);
  const s=m.snapshot();assert.equal(s.samples,20);assert.equal(s.late,1);assert.equal(s.underruns,1);assert.ok(s.arrivalP98Ms>=77);
  t+=7000;assert.equal(m.snapshot().samples,0);assert.equal(m.snapshot().lastSampleAgoMs,1e9);
  m.reset(2,1000);m.miss();assert.equal(m.snapshot().late,0,'discarding history after recovery is not a deadline failure');t+=1001;m.miss();assert.equal(m.snapshot().late,1);
});

test('disconnected, recovering and stale listeners cannot raise or retain a shared floor',()=>{
  for(const failure of [{stream:false},{ready:false,error:'reconnecting'},{contextState:'suspended'},{lastSeen:3000}]){
    const a=new AdaptiveBuffer(0);
    for(let t=40;t<=6000;t+=40){a.observeUpload(t,50);a.step(t,t-40,[client(t),client(t,{id:'phone'})]);}
    const prior=a.target;
    const dying=client(7000,{id:'phone'});dying.metrics.late=30;dying.metrics.underruns=30;dying.metrics.arrivalP98Ms=1800;
    a.observeUpload(7000,50);a.step(7000,6960,[client(7000),dying]);
    assert.equal(a.target,prior,'one burst before disconnect must not raise delay');
    for(let t=8000;t<=12000;t+=1000){a.observeUpload(t,50);a.step(t,t-40,[client(t),{...dying,lastSeen:t,...failure}]);}
    assert.ok(a.target<=prior);assert.equal(a.learnedFloor,100);assert.ok(!a.reports.has('phone'));
  }
});
test('sample age advances without heartbeats, and return with old metrics needs fresh probation',()=>{
  const a=new AdaptiveBuffer(0);
  for(let t=40;t<=6000;t+=40){a.observeUpload(t,50);a.step(t,t-40,[client(t)]);}
  const stale=client(6000);stale.metrics.arrivalP98Ms=1900;
  a.observeUpload(7000,50);a.step(7000,6960,[stale]);assert.equal(a.reports.size,0);
  const target=a.target;
  for(let t=8000;t<=12000;t+=1000){stale.lastSeen=t;a.observeUpload(t,50);a.step(t,t-40,[stale]);}
  assert.equal(a.target,target,'repeated serial cannot confirm a delayed burst');
});
test('learned floor belongs to the faulty listener and its departure cancels a rising ramp',()=>{
  const a=new AdaptiveBuffer(0);
  for(let t=40;t<=6000;t+=40){a.observeUpload(t,50);a.step(t,t-40,[client(t),client(t,{id:'phone'})]);}
  for(let t=7000;t<=9000;t+=1000){const phone=client(t,{id:'phone'});phone.metrics.late=t/1000-6;a.observeUpload(t,50);a.step(t,t-40,[client(t),phone]);}
  assert.ok(a.learnedFloor>100);const raised=a.target;
  const boundary=a.playoutAt(9960);a.observeUpload(10000,50);a.step(10000,9960,[client(10000)]);
  assert.equal(a.learnedFloor,100);assert.ok(a.target<raised);assert.equal(a.playoutAt(9960),boundary);
});
test('counter reset and source gaps do not learn false listener deadlines',()=>{
  const a=new AdaptiveBuffer(0);
  for(let t=40;t<=4000;t+=40){a.observeUpload(t,50);a.step(t,t-40,[client(t)]);}
  const reset=client(5000);reset.metrics.serial=1;reset.metrics.late=50;
  a.observeUpload(5000,50);a.step(5000,4960,[reset]);assert.equal(a.learnedFloor,100);
  a.observeUpload(6000,50,true);a.step(6000,5960,[client(6000)]);assert.equal(a.learnedFloor,100);assert.ok(a.target>a.valueAt(5960));
});

function simulate(arrival,duration=600000){
  const a=new AdaptiveBuffer(0),trace=[];
  for(let t=40;t<=duration;t+=40){const c=client(t);c.metrics.arrivalP98Ms=arrival;c.metrics.arrivalMedianMs=arrival-10;a.observeUpload(t,50);const before=a.target;a.step(t,t-40,[c]);if(a.target!==before)trace.push({at:t,from:before,to:a.target});}
  return {a,trace};
}
test('below 500 ms probes are small and separated by a stable observation period',()=>{
  const {a,trace}=simulate(200);
  const low=trace.filter(x=>x.from<=500&&x.to<x.from);
  assert.ok(low.length>0);assert.ok(low.every(x=>x.from-x.to<=20));
  for(let i=1;i<low.length;i++)assert.ok(low[i].at-low[i-1].at>=30000);
  assert.ok(a.target>=370&&a.target<=400,'measured arrival and hardware lead to about 400, not a fixed preset');
  assert.ok(trace.every(x=>x.from<=500||x.to>=500),'fast descent stops at the stability region');
  assert.ok(trace.at(-1).at<450000,'stops probing after convergence');
  const fast=simulate(70).a,slow=simulate(260).a;
  assert.ok(fast.target<a.target&&slow.target>a.target,'different measurements yield different convergence values');
});
test('isolated playback glitches postpone low-latency probes without raising everyone',()=>{
  const {a}=simulate(200,120000);const prior=a.target;let late=0;
  for(let t=120040;t<=240000;t+=40){const c=client(t);c.metrics.arrivalP98Ms=200;c.metrics.arrivalMedianMs=190;if(t%10000===0)late++;c.metrics.late=late;a.observeUpload(t,50);a.step(t,t-40,[c]);}
  assert.equal(a.target,prior,'intermittent faults favor holding over continued downward experiments');
});
