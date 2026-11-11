import test from 'node:test';
import assert from 'node:assert/strict';
import {LiveRoom} from '../lib/live-room.mjs';
import {makePacket} from '../public/live/protocol.mjs';

test('100 ms stays fixed through source and resume, accepts normal output without 600 ms guard',()=>{
  let time=10000;const room=new LiveRoom({now:()=>time,bufferMode:'100ms'});
  const h=room.hello({id:'aaaaaaaaaaaaaaaa'}),c=room.auth(h.id,h.token);room.stream(c,true);
  room.heartbeat(c,{enabled:true,ready:true,contextState:'running',uncertaintyMs:2,outputLatencyMs:60,advanceMs:0});
  assert.equal(room.delayMs,100);assert.ok(room.ready(c));room.takeControl(c);room.beginSource(c);
  for(let sequence=0;sequence<3;sequence++){room.receive(c,makePacket({generation:room.generation,sequence,sampleRate:48000,channels:2,frames:960,captureMs:time-120},new Float32Array(1920)));time+=20;}
  room.heartbeat(c,{enabled:true,ready:true,contextState:'running',uncertaintyMs:2,outputLatencyMs:60,advanceMs:0,bufferGeneration:room.generation,bufferedPackets:3});
  assert.equal(room.status,'playing');room.pause();room.resume(c);assert.equal(room.delayMs,100);
  c.outputLatencyMs=100;assert.equal(room.ready(c),false);
});
