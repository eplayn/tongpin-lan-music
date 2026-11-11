import test from 'node:test';
import assert from 'node:assert/strict';
import {ClockEstimator,positionAt,targetContextTime,serverAtContextTime,segmentPosition} from '../public/sync-core.mjs';
test('NTP midpoint selects low-latency probes and rejects long stalls',()=>{
 const c=new ClockEstimator();const offset=1_700_000_000_000;
 for(let i=0;i<9;i++){const a=i*100;assert(c.add(a,a+offset+1,a+offset+1.1,a+2.1));}
 c.add(1000,1000+offset+350,1000+offset+351,1701);
 assert(c.ready);assert(Math.abs(c.offsetMs-offset)<.01);assert(c.uncertaintyMs<2);
 assert.equal(c.add(2000,2001+offset,2001+offset,5000),false);
});
test('future pause keeps previous position until the common transition',()=>{
 const playing={status:'playing',position:12,anchorMs:1000,duration:300};
 const pause={status:'paused',position:15,anchorMs:4000,duration:300,previous:playing};
 assert.equal(positionAt(pause,3000),14);assert.equal(positionAt(pause,5000),15);
 assert.equal(positionAt({...playing,position:299},9000),300);
});
test('output timestamp and manual advance map to the same server sample time',()=>{
 const ctx={currentTime:10.2,getOutputTimestamp:()=>({contextTime:10,performanceTime:1000})};
 const when=targetContextTime(10500,8000,120,ctx,1005);
 assert(Math.abs(when-11.38)<1e-9);
 assert(Math.abs(serverAtContextTime(when,8000,120,ctx,1005)-10500)<1e-9);
});
test('estimated latency fallback accounts for base and hardware latency',()=>{
 const ctx={currentTime:10,baseLatency:.01,outputLatency:.08};
 assert(Math.abs(targetContextTime(5000,3000,0,ctx,1000)-10.91)<1e-9);
});
test('drift correction history integrates audio clock rather than wall clock',()=>{
 const history=[{ctx:10,position:5,rate:1},{ctx:20,position:15,rate:.997},{ctx:30,position:24.97,rate:1.002}];
 assert(Math.abs(segmentPosition(history,31)-25.972)<1e-9);
 assert.equal(segmentPosition(history,15),10);
});
