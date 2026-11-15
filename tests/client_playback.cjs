/* Execute the actual browser receiver with a deterministic Web Audio clock.
   Exercise stalls, clock drift, live resets and a five-second fixed buffer. */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
let now=10000,sequence=0;
const elements=new Map(),intervals=[],played=[],sockets=[];
function element(id){
  if(!elements.has(id))elements.set(id,{style:{},listeners:{},value:'80',
    addEventListener(name,fn){this.listeners[name]=fn;}});
  return elements.get(id);
}
class AudioContext {
  constructor(){this.state='running';this.baseLatency=0;this.outputLatency=0;}
  get currentTime(){return now/1000;}
  getOutputTimestamp(){return {performanceTime:now,contextTime:this.currentTime};}
  createGain(){return {gain:{value:0,setTargetAtTime(){}},connect(){}};}
  createBuffer(channels,frames,rate){return {duration:frames/rate,getChannelData(){return new Float32Array(frames);}};}
  createBufferSource(){return {playbackRate:{value:1},connect(){},disconnect(){},
    start(at){this.at=at;played.push(this);},stop(){this.stopped=true;}};}
  async resume(){}
}
class WebSocket {
  static OPEN=1;
  constructor(){this.readyState=1;sockets.push(this);}
  send(){}
  close(){this.readyState=3;}
}
const sandbox={console,ArrayBuffer,DataView,Float32Array,Set,Map,Math,Number,JSON,
  performance:{now:()=>now},AudioContext,WebSocket,
  document:{hidden:false,getElementById:element,addEventListener(){}},
  location:{protocol:'http:',host:'localhost'},
  fetch:async()=>({ok:true,json:async()=>({test:true,localHost:true,latency:600})}),
  setInterval:(fn,ms)=>intervals.push({fn,ms}),clearInterval(){},
  setTimeout(){},clearTimeout(){},addEventListener(){}};
sandbox.window=sandbox;
vm.runInNewContext(fs.readFileSync('web/client.js','utf8'),sandbox);
function message(data){sockets.at(-1).onmessage({data:typeof data==='object'&&!(data instanceof ArrayBuffer)?JSON.stringify(data):data});}
function clock(offset=0){message({type:'sync',t0:now-2,t1:now-1+offset,t2:now-1+offset});}
function packet(delay=100){
  const b=new ArrayBuffer(1960),v=new DataView(b);
  v.setUint32(0,0x3141534c,true);v.setUint32(4,sequence++,true);
  v.setFloat64(8,now,true);v.setFloat64(16,now+delay,true);v.setFloat64(24,10,true);
  v.setUint32(32,48000,true);v.setUint16(36,480,true);v.setUint8(38,2);v.setUint8(39,1);
  message(b);
}
(async()=>{
  await element('start').listeners.click();sockets[0].onopen();
  message({type:'hello',test:true});for(let i=0;i<6;i++){now+=10;clock();}
  assert.equal(sandbox.lanSyncDiagnostics().clockReady,true);
  for(let i=0;i<30;i++){now+=10;packet();}
  assert.ok(played.length>=28);
  for(let i=1;i<played.length;i++)assert.ok(Math.abs(played[i].at-played[i-1].at-.01)<1e-6);
  const before=played.length;
  now+=120;packet(-80); // late audio is discarded; no compressed catch-up
  assert.equal(played.length,before);assert.ok(sandbox.lanSyncDiagnostics().late>0);
  for(let i=0;i<15;i++){now+=10;clock(8);packet();}
  assert.ok(played.length>before);
  message({type:'reset',epoch:2,latency:5000,speed:1});
  assert.ok(played.every(s=>s.stopped));
  for(let i=0;i<450;i++){now+=10;packet(5000);}
  assert.ok(sandbox.lanSyncDiagnostics().queued>=440,'five-second buffer must not overflow at 250 packets');
  message({type:'reset',epoch:3,latency:100,speed:1});
  assert.equal(sandbox.lanSyncDiagnostics().queued,0);
  for(let i=0;i<20;i++){now+=10;packet(100);}
  assert.ok(played.every(s=>s.playbackRate.value===1));
  console.log(`PASS: browser original speed (${played.length} sources), late drop, clock drift, live reset, 5000 ms queue`);
})().catch(e=>{console.error(e);process.exitCode=1;});
