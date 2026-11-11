import test from 'node:test';
import assert from 'node:assert/strict';
import {LiveRoom} from '../lib/live-room.mjs';
import {makePacket} from '../public/live/protocol.mjs';

test('minimum buffer selects smallest whole millisecond above all device guards and freezes while playing',()=>{
  let time=10000;
  const room=new LiveRoom({now:()=>time,bufferMode:'minimum'});
  const add=(id,output,advance=0)=>{
    const h=room.hello({id:id.repeat(16)}),c=room.auth(h.id,h.token);room.stream(c,true);
    room.heartbeat(c,{enabled:true,ready:true,contextState:'running',uncertaintyMs:2,outputLatencyMs:output,advanceMs:advance});return c;
  };
  const source=add('a',23.1),phone=add('b',82.25,10);room.takeControl(source);room.beginSource(source);
  assert.equal(room.delayMs,693);
  assert.ok(room.ready(phone));
  for(let sequence=0;sequence<3;sequence++){
    room.receive(source,makePacket({generation:room.generation,sequence,sampleRate:48000,channels:2,frames:3840,captureMs:time-80},new Float32Array(7680)));time+=80;
  }
  for(const c of [source,phone])room.heartbeat(c,{enabled:true,ready:true,contextState:'running',uncertaintyMs:2,outputLatencyMs:c.outputLatencyMs,advanceMs:c.advanceMs,bufferGeneration:room.generation,bufferedPackets:3});
  assert.equal(room.status,'playing');const anchor=room.playFromMs;
  const slow=add('c',200);
  assert.equal(room.delayMs,693);assert.equal(room.playFromMs,anchor);assert.equal(room.ready(slow),false);
  room.pause();room.resume(source);assert.equal(room.delayMs,801);
  assert.equal(room.snapshot().live.delayMs,801);
});

test('stable mode preserves 2000 ms and minimum mode cannot bypass strict output guard',()=>{
  const stable=new LiveRoom({now:()=>0});stable.selectDelay();assert.equal(stable.delayMs,2000);
  const minimal=new LiveRoom({now:()=>0,bufferMode:'minimum'});minimal.selectDelay();assert.equal(minimal.delayMs,601);
  const h=minimal.hello({id:'dddddddddddddddd'}),c=minimal.auth(h.id,h.token);
  minimal.stream(c,true);minimal.heartbeat(c,{enabled:true,ready:true,contextState:'running',uncertaintyMs:2,outputLatencyMs:1,advanceMs:0});
  assert.equal(minimal.ready(c),false);
});
