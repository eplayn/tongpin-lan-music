import test from 'node:test';
import assert from 'node:assert/strict';
import {LiveRoom} from '../lib/live-room.mjs';
import {devicePlatform,getDeviceInfo,isCableInput,isPhysicalOutput} from '../public/live/device.mjs';
const room=()=>new LiveRoom({now:()=>10000});
const hello=(r,key,name)=>r.hello({deviceKey:key.repeat(64),name,deviceInfo:{platform:'Windows',browser:'Chrome'}});
test('identity remains stable across reload and server restart; old tab loses access',()=>{
  const r=room(),a=hello(r,'a'),first=r.auth(a.id,a.token);first.enabled=true;r.takeControl(first);
  const again=hello(r,'a');assert.equal(again.id,a.id);assert.notEqual(again.token,a.token);
  assert.throws(()=>r.auth(a.id,a.token),e=>e.status===401);assert.ok(r.auth(again.id,again.token));
  assert.equal(hello(room(),'a').id,a.id);assert.notEqual(hello(r,'b').id,a.id);
  assert.ok(!JSON.stringify(r.snapshot()).includes('a'.repeat(64)));assert.ok(!JSON.stringify(r.snapshot()).includes(again.token));
});
test('actual hostname is preferred, requested nickname is preserved, model is fallback',()=>{
  const r=room(),a=r.hello({deviceKey:'c'.repeat(64),deviceInfo:{platform:'Windows'}},{realName:'SOURCE-PC',nameSource:'host'});
  assert.equal(r.clients.get(a.id).name,'SOURCE-PC');
  const b=r.hello({deviceKey:'d'.repeat(64),name:'客厅电脑',deviceInfo:{model:'24122RKC7C'}},{realName:'some-host',nameSource:'network'});
  assert.equal(r.clients.get(b.id).name,'客厅电脑');
  const c=r.hello({deviceKey:'e'.repeat(64),deviceInfo:{platform:'Android',model:'Pixel 7'}});assert.equal(r.clients.get(c.id).name,'Pixel 7');
});
test('only controller can change room or individual volume; playback clock is preserved',()=>{
  const r=room(),a=hello(r,'1'),b=hello(r,'2'),host=r.auth(a.id,a.token),guest=r.auth(b.id,b.token);host.enabled=true;r.takeControl(host);
  const before=r.snapshot().live;
  assert.throws(()=>r.volume(guest,{value:20}),/接管主持/);
  r.volume(host,{value:40});r.volume(host,{clientId:b.id,value:25});
  const s=r.snapshot();assert.equal(s.live.masterVolume,40);assert.equal(s.clients.find(c=>c.id===b.id).remoteVolume,25);
  assert.equal(s.live.generation,before.generation);assert.equal(s.live.revision,before.revision);assert.equal(s.live.playFromMs,before.playFromMs);
  assert.throws(()=>r.volume(host,{value:101}),/音量/);assert.throws(()=>r.volume(host,{value:'30'}),/音量/);
  assert.equal(r.clients.get(hello(r,'3').id).remoteVolume,100);assert.equal(r.masterVolume,40);
});
test('macOS, Windows, Android and iPad desktop user agents are identified',async()=>{
  assert.equal(devicePlatform('Mozilla Macintosh','MacIntel',0),'macOS');assert.equal(devicePlatform('Mozilla Macintosh','MacIntel',5),'iPadOS');
  assert.equal(devicePlatform('Mozilla Windows NT 10.0','Win32',0),'Windows');
  const info=await getDeviceInfo({userAgent:'Mozilla Android 14; Pixel 7 Build/123) Chrome/122',platform:'Linux',userAgentData:{platform:'Android',getHighEntropyValues:async()=>({model:'Pixel 7'})}});
  assert.equal(info.model,'Pixel 7');assert.equal(info.platform,'Android');
});
test('Windows and Mac cable inputs accepted, microphone and virtual output feedback rejected',()=>{
  for(const label of ['CABLE Output (VB-Audio Virtual Cable)','VB-Cable','VB-CABLE (VB-Audio)','CABLE-A Output (VB-Audio Virtual Cable)'])assert.ok(isCableInput({kind:'audioinput',deviceId:'real-id',label}),label);
  assert.ok(!isCableInput({kind:'audioinput',deviceId:'real-id',label:'Microphone (Realtek)'}));
  for(const label of ['CABLE Input','VB-Cable','CABLE In 16ch','BlackHole 2ch','Multi-Output Device','聚集设备'])assert.ok(!isPhysicalOutput({kind:'audiooutput',deviceId:'real-id',label}),label);
  assert.ok(isPhysicalOutput({kind:'audiooutput',deviceId:'real-id',label:'MacBook Pro Speakers'}));
  assert.ok(!isPhysicalOutput({kind:'audiooutput',deviceId:'default',label:'Speakers'}));
});
test('removed browser-tab source cannot be started through the API',()=>{const r=room(),a=hello(r,'f'),c=r.auth(a.id,a.token);c.enabled=true;r.takeControl(c);assert.throws(()=>r.beginSource(c,{kind:'tab'}),/仅支持 CABLE/);assert.equal(r.generation,0);});
