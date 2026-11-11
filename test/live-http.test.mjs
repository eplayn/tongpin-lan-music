import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createMusicServer} from '../server.mjs';
import {makePacket} from '../public/live/protocol.mjs';
test('live HTTP credentials, origin checks, PCM streaming and HTTPS share one room',async()=>{
  const cert=fileURLToPath(new URL('../data/https.pfx',import.meta.url));
  const app=await createMusicServer({host:'127.0.0.1',port:0,...(fs.existsSync(cert)?{tlsPort:0,tlsPfx:cert}:{})});
  const base=`http://127.0.0.1:${app.server.address().port}`,abort=new AbortController();let reader;
  const post=async(route,data,headers={})=>{const r=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(data)});return{status:r.status,data:await r.json()};};
  try{
    assert.equal((await fetch(base+'/live/')).status,200);
    if(fs.existsSync(cert)){assert.equal((await fetch(base+'/live/server.cer')).status,200);assert.equal((await fetch(base+'/data/https.pfx')).status,404);}
    assert.equal((await post('/api/live/hello',{id:'1234123412341234',name:'test'},{Origin:'http://example.com'})).status,403);
    const a=await post('/api/live/hello',{id:'1234123412341234',name:'test'});assert.equal(a.status,200);
    const h={'X-Live-Id':a.data.id,'X-Live-Token':a.data.token};
    assert.equal((await post('/api/live/hello',{id:a.data.id,name:'stolen'})).status,400);
    assert.equal((await post('/api/live/control',{action:'claim'})).status,401);
    await post('/api/live/heartbeat',{enabled:true,ready:true,contextState:'running',uncertaintyMs:1,outputLatencyMs:20,advanceMs:0},h);
    await post('/api/live/control',{action:'claim'},h);
    const stream=await fetch(base+'/api/live/audio',{headers:h,signal:abort.signal});reader=stream.body.getReader();
    assert.equal((await post('/api/live/control',{action:'source'},h)).status,200);
    const before=app.now();
    for(let sequence=0;sequence<3;sequence++){
      const p=makePacket({generation:app.live.generation,sequence,captureMs:before-80+sequence*80,sampleRate:48000,channels:2,frames:3840},new Float32Array(7680));
      assert.equal((await fetch(base+'/api/live/pcm',{method:'POST',headers:h,body:p})).status,200);
    }
    const {value}=await reader.read();assert.ok(value.length>=32);
    await post('/api/live/heartbeat',{enabled:true,ready:true,bufferGeneration:app.live.generation,bufferedPackets:3,contextState:'running',uncertaintyMs:1,outputLatencyMs:20,advanceMs:0},h);
    const snapshot=await(await fetch(base+'/api/live/status')).json();assert.equal(snapshot.live.status,'playing');assert.ok(!JSON.stringify(snapshot).includes(a.data.token));
    assert.equal((await post('/api/import',{path:'C:\\Windows\\win.ini'},h)).status,400);
    if(app.tlsServer){
      const response=await new Promise((resolve,reject)=>{https.get(`https://127.0.0.1:${app.tlsServer.address().port}/api/live/status`,{rejectUnauthorized:false},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(b)}));}).on('error',reject);});
      assert.equal(response.status,200);assert.equal(response.data.live.generation,snapshot.live.generation);assert.equal(response.data.bootId,snapshot.bootId);
    }
    const wrong=makePacket({generation:app.live.generation,sequence:99,captureMs:app.now(),sampleRate:48000,channels:2,frames:3840},new Float32Array(7680));
    assert.equal((await fetch(base+'/api/live/pcm',{method:'POST',headers:h,body:wrong})).status,400);assert.equal(app.live.status,'ended');
  }finally{abort.abort();reader?.cancel().catch(()=>{});await app.close();}
});
