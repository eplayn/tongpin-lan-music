import {ClockEstimator,targetContextTime,outputMap,clamp} from '/sync-core.mjs';
import {PacketReader,makePacket,HEADER_BYTES,CaptureClock} from './protocol.mjs';
import {getDeviceInfo,fallbackName,makeDeviceKey,isCableInput,isPhysicalOutput} from './device.mjs';
import {PlaybackMetrics} from './playback-metrics.mjs';
const $=id=>document.getElementById(id);
const storage={getItem(key){try{return localStorage.getItem(key);}catch{return null;}},setItem(key,value){try{localStorage.setItem(key,value);return true;}catch{return false;}}};
let deviceKey=storage.getItem('tp-device-key-v1');if(!/^[a-f0-9]{64}$/.test(deviceKey||''))deviceKey=makeDeviceKey();
const persistentIdentity=storage.setItem('tp-device-key-v1',deviceKey);
let id=storage.getItem('tp-device-id-v1')||'',deviceInfo={platform:'',model:'',browser:''};
let token=null,bootId=null,live=null,clients=[],urls=null,clock=new ClockEstimator();
let ctx=null,master=null,remoteGain=null,enabled=false,audioConnected=false,connected=false,lease=0,error='',driftMs=null;
let packets=[],nodes=[],cursor=null,scheduledSequence=-1,transport=null,sharing=null;
let syncing=false,beating=false,registered=null,shareBusy=false,warmUntil=0;
let recovering=false,recoveryBusy=false,retryCount=0,retryAt=0,audioOpening=false,lastAudioAt=0,resumePending=false;
const NETWORK_ERROR='连接中断，正在自动重连';
const playbackMetrics=new PlaybackMetrics();
let audioDevices=[];
const cableInput=isCableInput,physicalOutput=isPhysicalOutput;
async function readDevices(){
  try{
    if(!isSecureContext||!navigator.mediaDevices?.getUserMedia)throw Error('需要本机地址或可信 HTTPS 页面');
    const permission=await navigator.mediaDevices.getUserMedia({audio:true,video:false});permission.getTracks().forEach(t=>t.stop());
    audioDevices=await navigator.mediaDevices.enumerateDevices();
    for(const [element,filter,prompt]of [[$('systemInput'),cableInput,'选择 CABLE / VB-Cable 输入'],[$('systemOutput'),physicalOutput,'选择实际扬声器或耳机'],[$('listenOutput'),physicalOutput,'跟随系统默认输出']]){const previous=element.value;element.replaceChildren(new Option(prompt,''));for(const d of audioDevices.filter(filter))element.add(new Option(d.label,d.deviceId));if([...element.options].some(o=>o.value===previous))element.value=previous;}
    const inputs=audioDevices.filter(cableInput);if(inputs.length===1)$('systemInput').value=inputs[0].deviceId;
    const saved=storage.getItem('live-physical-output');if(audioDevices.some(d=>physicalOutput(d)&&d.deviceId===saved))$('systemOutput').value=saved;
    if(saved&&[...$('listenOutput').options].some(o=>o.value===saved))$('listenOutput').value=saved;
    notice(inputs.length?'已识别虚拟声卡：选择实际扬声器后开始共享':'没有找到 CABLE 输入。Windows 通常显示 CABLE Output，Mac 通常显示 VB-Cable；请确认驱动和浏览器音频输入权限。',!inputs.length);
  }catch(e){notice('音频设备读取失败：'+e.message,true);}render();
}
let advance=clamp(Number(storage.getItem('live-advance'))||0,-500,500),volume=clamp(Number(storage.getItem('live-volume')??70),0,100);
let customName=storage.getItem('tp-device-name-v1')||'',nameEdited=false,lastRemoteLevel=null;
$('deviceName').value=customName;$('offset').value=advance;$('volume').value=volume;
const now=()=>performance.now()+clock.offsetMs;
const contextAt=t=>targetContextTime(t,clock.offsetMs,advance,ctx,performance.now());
function notice(message,bad=false){$('notice').textContent=message;$('notice').dataset.kind=bad?'error':'info';}
function headers(){return {'X-Live-Id':id,'X-Live-Token':token};}
function sessionLost(message){enabled=false;recovering=false;transport?.abort();audioOpening=false;audioConnected=false;stopAt();closeCapture();if(ctx?.state==='running')ctx.suspend().catch(()=>{});error=message;token=null;registered=null;notice(message,true);render();}
function resetPlayback(){stopAt();packets=[];scheduledSequence=-1;lease=0;playbackMetrics.reset(live?.generation||0);}
function markRecovery(message=NETWORK_ERROR){
  if(!enabled)return;
  if(!recovering&&!sharing)clock=new ClockEstimator();
  recovering=true;error=NETWORK_ERROR;resetPlayback();transport?.abort();audioConnected=false;audioOpening=false;
  retryAt=performance.now()+Math.min(5000,500*2**Math.min(retryCount++,4));
  notice(message+'；本机将自动恢复，其他人继续播放');render();
}
function authFailure(body){
  if(body.code==='SESSION_EXPIRED'&&enabled){token=null;registered=null;markRecovery('连接已过期，正在自动重新加入');}
  else sessionLost(body.error||'本机连接已被其他页面接管');
}
async function request(route,data){const r=await fetch('/api/live/'+route,{method:'POST',headers:{...headers(),'Content-Type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(4000)});const body=await r.json();if(!r.ok){if(r.status===401)authFailure(body);throw Error(body.error||'房间操作失败');}return body;}
async function hello(){if(registered)return registered;registered=(async()=>{deviceInfo=await getDeviceInfo();const s=await request('hello',{deviceKey,name:customName,deviceInfo});id=s.id;storage.setItem('tp-device-id-v1',id);token=s.token;apply(s);await syncClock();return s;})();try{return await registered;}catch(e){registered=null;throw e;}}
function applyRemoteVolume(){const self=clients.find(c=>c.id===id),level=(live?.masterVolume??100)*(self?.remoteVolume??100)/10000;if(remoteGain&&lastRemoteLevel!==level){remoteGain.gain.setTargetAtTime(level,ctx.currentTime,.025);lastRemoteLevel=level;}}
function ensureContext(){
  if(!ctx){
    if(!(window.AudioContext||window.webkitAudioContext))throw Error('当前浏览器不支持网页音频，请使用新版浏览器');
    try{if(navigator.audioSession)navigator.audioSession.type='playback';}catch{}
    ctx=new(window.AudioContext||window.webkitAudioContext)({latencyHint:'interactive'});warmUntil=performance.now()+600;
    master=ctx.createGain();remoteGain=ctx.createGain();master.connect(remoteGain);remoteGain.connect(ctx.destination);master.gain.value=volume/100;applyRemoteVolume();
    const silence=ctx.createConstantSource();silence.offset.value=0;silence.connect(master);silence.start();
    ctx.onstatechange=()=>{if(enabled&&ctx.state!=='running'){markRecovery('本机声音被系统暂停，正在尝试恢复；如受限制请点“加入共听”');heartbeat();}render();};
  }
  if(ctx.state!=='running')warmUntil=performance.now()+500;
  return ctx.resume();
}
async function syncClock(){
  if(syncing)return;syncing=true;
  try{for(let i=0,n=clock.samples.length?4:9;i<n;i++){const a=performance.now(),r=await fetch('/api/clock',{cache:'no-store',signal:AbortSignal.timeout(3000)}),s=await r.json(),b=performance.now();if(bootId&&bootId!==s.bootId){stopAt();closeCapture();location.reload();return;}bootId=s.bootId;clock.add(a,s.receiveMs,s.sendMs,b);await new Promise(r=>setTimeout(r,18));}}
  catch(e){notice('校时未完成：'+e.message,true);}finally{syncing=false;render();schedule();}
}
function stopAt(serverMs=null){
  for(const n of nodes){try{const at=serverMs===null?ctx.currentTime:Math.max(ctx.currentTime,contextAt(serverMs));n.node.stop(Math.min(n.end+.001,at));n.cutoff=Math.min(n.cutoff,serverMs??-Infinity);}catch{}}
  if(serverMs===null){nodes=[];cursor=null;driftMs=null;}
}
function renewStops(){
  for(const n of nodes){try{let cutoff=Math.min(lease,n.cutoff);if(n.generation===live?.generation&&Number.isFinite(live.stopAtMs))cutoff=Math.min(cutoff,live.stopAtMs);n.node.stop(Math.min(n.end+.001,Math.max(ctx.currentTime,contextAt(cutoff))));}catch{}}
}
function apply(s){
  if(bootId&&s.bootId&&s.bootId!==bootId){stopAt();closeCapture();transport?.abort();location.reload();return;}
  bootId=s.bootId||bootId;urls=s.urls||urls;
  if(s.live){
    const old=live;live=s.live;
    if(!old||old.generation!==live.generation){stopAt(live.transitionAtMs??now()+1500);packets=packets.filter(p=>p.generation===live.generation);cursor=null;scheduledSequence=-1;playbackMetrics.reset(live.generation);}
    if(live.playFromMs!==old?.playFromMs&&live.playFromMs!==null){cursor=null;scheduledSequence=-1;}
    if(Number.isFinite(live.stopAtMs))stopAt(live.stopAtMs);
    if(sharing&&live.sourceId!==id&&live.generation>=sharing.generation)closeCapture();
    if(old?.revision!==live.revision&&live.message)notice(live.message);
  }
  clients=s.clients||clients;
  applyRemoteVolume();
  if(Number.isFinite(s.leaseUntilMs)){lease=s.leaseUntilMs;renewStops();}
  connected=true;render();schedule();
}
async function heartbeat(){
  if(beating||!token)return;beating=true;
  try{
    const outputMs=((ctx?.baseLatency||0)+(ctx?.outputLatency||0))*1000;
    const admissible=outputMs+Math.max(0,advance)+(live?.bufferMode==='adaptive'?20:(live?.delayMs||2000)<=100?2:600)<(live?.delayMs||2000);
    const latencyError='本机输出延迟超过同步缓冲，请改用扬声器／有线耳机，或减小补偿';
    if(enabled&&!admissible)error=latencyError;
    else if(error===latencyError)error='';
    const ready=enabled&&!recovering&&audioConnected&&clock.ready&&ctx?.state==='running'&&performance.now()>=warmUntil&&!error&&admissible;
    apply(await request('heartbeat',{enabled,ready,visibility:document.visibilityState,bufferGeneration:live?.generation,bufferedPackets:packets.filter(p=>p.generation===live?.generation).length,contextState:ctx?.state||'suspended',uncertaintyMs:Number.isFinite(clock.uncertaintyMs)?clock.uncertaintyMs:null,outputLatencyMs:outputMs,advanceMs:advance,driftMs,error,metrics:playbackMetrics.snapshot(sharing?.dropped||0)}));
  }catch(e){connected=false;if(enabled)markRecovery('房间连接中断，正在自动重连');render();}finally{beating=false;}
}
async function receiveAudio(signal){
  const timeout=setTimeout(()=>{if(transport?.signal===signal&&audioOpening)transport.abort();},4000);
  try{
    const r=await fetch('/api/live/audio',{headers:headers(),signal});if(!r.ok){if(r.status===401)authFailure(await r.json());throw Error('音频连接失败');}
    clearTimeout(timeout);if(transport?.signal!==signal||signal.aborted)return;
    audioOpening=false;audioConnected=true;lastAudioAt=performance.now();warmUntil=Math.max(warmUntil,performance.now()+250);heartbeat();render();const reader=r.body.getReader(),parser=new PacketReader();
    while(!signal.aborted){const {done,value}=await reader.read();if(done)break;
      if(transport?.signal!==signal)return;lastAudioAt=performance.now();
      for(const p of parser.push(value)){if(p.generation<(live?.generation||0))continue;packets.push(p);if(!recovering&&clock.ready&&p.generation===playbackMetrics.generation)playbackMetrics.arrival(p,now());}
      packets=packets.filter(p=>p.captureMs>now()-3500).slice(-80);schedule();
    }
    if(!signal.aborted)throw Error('音频线路已断开');
  }catch(e){if(!signal.aborted&&enabled)notice('音频连接中断，正在自动重连');}
  finally{clearTimeout(timeout);if(transport?.signal===signal){audioConnected=false;audioOpening=false;if(enabled)markRecovery('音频连接中断，正在自动重连');heartbeat();render();}}
}
function startAudio(){transport?.abort();resetPlayback();recovering=true;audioConnected=false;audioOpening=true;transport=new AbortController();receiveAudio(transport.signal);}
async function recoverConnection(){
  if(!enabled||recoveryBusy)return;
  if(audioConnected&&live?.sourceId&&performance.now()-lastAudioAt>3500)markRecovery('音频传输停滞，正在重连');
  if(!recovering)return;
  if(audioConnected&&clock.ready&&ctx?.state==='running'&&performance.now()>=warmUntil&&(!live?.sourceId||packets.filter(p=>p.generation===live.generation).length>=3)){
    recovering=false;retryCount=0;retryAt=0;playbackMetrics.reset(live?.generation||0,1000);if(error===NETWORK_ERROR)error='';heartbeat();schedule();notice('本机已恢复连接，正在跟随当前共听进度');render();return;
  }
  if(performance.now()<retryAt)return;recoveryBusy=true;
  retryAt=performance.now()+Math.min(5000,500*2**Math.min(retryCount,4));
  try{
    if(!token)await hello();
    if(!clock.ready||!connected)await syncClock();
    if(!enabled)return;
    if(ctx?.state!=='running'&&!resumePending){resumePending=true;ensureContext().catch(()=>notice('系统暂不允许自动恢复声音，请点“加入共听”')).finally(()=>{resumePending=false;});}
    if(!audioConnected&&!audioOpening)startAudio();
  }catch(e){if(enabled)markRecovery('连接尚未恢复，继续自动重试');}
  finally{recoveryBusy=false;}
}
async function join(){
  const resume=ensureContext();await hello();await resume;
  const savedOutput=storage.getItem('live-physical-output');if(savedOutput&&typeof ctx.setSinkId==='function'){try{await ctx.setSinkId(savedOutput);}catch{throw Error('已保存的回放设备不可用，请在“本机回放设备”中重新选择');}}
  enabled=true;error='';retryAt=0;retryCount=0;
  if(!audioConnected)startAudio();await heartbeat();notice('已加入，正在校时并连接实时声音');render();
}
async function leave(){
  if(sharing){try{apply(await request('control',{action:'end'}));}catch{}closeCapture();}
  enabled=false;recovering=false;transport?.abort();audioOpening=false;audioConnected=false;stopAt();packets=[];if(ctx?.state==='running')await ctx.suspend();await heartbeat();notice('本机已退出共听');render();
}
function schedule(){
  if(!enabled||recovering||error||!audioConnected||!clock.ready||ctx?.state!=='running'||performance.now()<warmUntil||!live||!Number.isFinite(live.playFromMs)||lease<=now())return;
  if(!['playing','paused','ended'].includes(live.status))return;
  const cutoff=Math.min(lease,live.stopAtMs??Infinity);
  for(const p of packets){
    if(p.generation!==live.generation||p.sequence<=scheduledSequence||p.captureMs<live.playFromMs-.01)continue;
    const target=p.playoutMs??p.captureMs+live.delayMs;
    if(target>=cutoff)continue;
    const wanted=contextAt(target);
    if(wanted<ctx.currentTime+(live.bufferMode==='adaptive'?.012:live.delayMs<=100?.002:.14)){playbackMetrics.miss();scheduledSequence=p.sequence;cursor=null;continue;}
    const baseRate=p.playoutEndMs?p.durationMs/(p.playoutEndMs-p.playoutMs):1;
    let when=wanted,rate=baseRate,phase=0;
    if(cursor&&cursor.generation===p.generation&&p.sequence>cursor.sequence+1){playbackMetrics.gap();cursor=null;}
    if(cursor&&cursor.generation===p.generation&&cursor.sequence+1===p.sequence){
      phase=(cursor.end-wanted)*1000;
      playbackMetrics.phase(phase);
      if(Math.abs(phase)<45){when=cursor.end;rate=baseRate*clamp(1+phase/4000,.997,1.003);}else cursor=null;
    }
    const b=ctx.createBuffer(p.channels,p.frames,p.sampleRate),v=new DataView(p.bytes.buffer,p.bytes.byteOffset,p.bytes.byteLength);
    for(let c=0;c<p.channels;c++){const out=b.getChannelData(c);for(let i=0;i<p.frames;i++)out[i]=v.getFloat32(p.headerBytes+(i*p.channels+c)*4,true);}
    const node=ctx.createBufferSource(),gain=ctx.createGain();node.buffer=b;node.playbackRate.value=rate;node.connect(gain);gain.connect(master);
    if(!cursor){gain.gain.setValueAtTime(0,when);gain.gain.linearRampToValueAtTime(1,when+.008);}
    const end=when+b.duration/rate,n={node,gain,start:when,end,generation:p.generation,sequence:p.sequence,cutoff:Infinity,target};
    nodes.push(n);node.onended=()=>{gain.disconnect();node.disconnect();nodes=nodes.filter(x=>x!==n);};
    node.start(when);node.stop(Math.min(end+.001,contextAt(cutoff)));cursor=n;scheduledSequence=p.sequence;driftMs=phase;
  }
  renewStops();renderMetrics();
}
function closeCapture(){
  const s=sharing;sharing=null;if(!s)return;s.closed=true;clearTimeout(s.retryTimer);s.worklet?.disconnect();s.input?.disconnect();s.mute?.disconnect();for(const t of s.stream.getTracks())t.stop();s.queue.length=0;render();
}
async function captureFailed(message){
  notice(message,true);if(sharing)sharing.closed=true;
  try{apply(await request('control',{action:'end'}));}
  catch{try{apply(await(await fetch('/api/live/status')).json());}catch{}}
  if(sharing)closeCapture();
}
async function publish(){
  const s=sharing;if(!s||s.sending||s.closed||performance.now()<(s.retryAt||0))return;s.sending=true;
  try{while(s===sharing&&s.queue.length&&!s.closed){
    if(s.adaptive)trimCaptureQueue(s);
    const bytes=s.queue.shift();if(!bytes)break;
    const r=await fetch('/api/live/pcm',{method:'POST',headers:{...headers(),'Content-Type':'application/octet-stream'},body:bytes,signal:AbortSignal.timeout(2500)});
    if(!r.ok){const e=await r.json(),failure=Error(e.error||'声音上传失败');failure.fatal=r.status>=400&&r.status<500&&r.status!==429;throw failure;}
  }}catch(e){if(s===sharing){
    if(s.adaptive&&!e.fatal){s.retryAt=performance.now()+500;clearTimeout(s.retryTimer);s.retryTimer=setTimeout(publish,500);notice('音源上传短暂中断，正在恢复并丢弃过期音频');}
    else await captureFailed(e.message);
  }}finally{s.sending=false;}
}
function trimCaptureQueue(s){while(s.queue.length&&(s.queue.length>13||now()-new DataView(s.queue[0].buffer,s.queue[0].byteOffset).getFloat64(24,true)>500)){s.queue.shift();s.dropped++;}}
async function share(){
  if(shareBusy||sharing)return;shareBusy=true;let stream;
  try{
    if(!isSecureContext||!navigator.mediaDevices?.getUserMedia||!ctx?.audioWorklet&&typeof AudioWorkletNode!=='function')throw Error('共享音源需要支持音频采集的 Windows / Mac 浏览器，以及本机地址或可信 HTTPS 页面');
    if(!audioDevices.some(d=>cableInput(d)&&d.deviceId===$('systemInput').value)||!audioDevices.some(d=>physicalOutput(d)&&d.deviceId===$('systemOutput').value))throw Error('请读取设备，并选择虚拟声卡输入与实际扬声器');
    // Open only the explicitly selected virtual audio input.
    const resumed=ensureContext();
    const selected=navigator.mediaDevices.getUserMedia({video:false,audio:{deviceId:{exact:$('systemInput').value},echoCancellation:false,noiseSuppression:false,autoGainControl:false,channelCount:2}});
    stream=await selected;await resumed;
    const a=stream.getAudioTracks()[0];
    if(a?.getSettings().deviceId!==$('systemInput').value)throw Error('浏览器返回的输入不是所选虚拟通道，已停止共享');
    if(!a)throw Error('未能读取虚拟声卡音频，请确认输入设备');
    {if(typeof ctx.setSinkId!=='function')throw Error('当前浏览器无法单独指定回放设备。收听不受影响；Windows / Mac 供源请使用新版 Chrome／Edge');await ctx.setSinkId($('systemOutput').value);storage.setItem('live-physical-output',$('systemOutput').value);warmUntil=performance.now()+600;error='';}
    if(!enabled)await join();else await hello();
    await syncClock();
    if(live.controllerId!==id){if(live.controllerId)throw Error('请先点“接管主持”，再共享音源');apply(await request('control',{action:'claim'}));}
    for(let i=0;i<30&&!clients.find(c=>c.id===id)?.ready;i++){await heartbeat();await new Promise(r=>setTimeout(r,80));}
    apply(await request('control',{action:'source',kind:'system'}));
    await ctx.audioWorklet.addModule('/live/capture-worklet.mjs');
    const s={stream,generation:live.generation,sequence:0,queue:[],sending:false,closed:false,clock:new CaptureClock(),adaptive:live.bufferMode==='adaptive',dropped:0};sharing=s;
    s.input=ctx.createMediaStreamSource(new MediaStream([a]));s.worklet=new AudioWorkletNode(ctx,'shared-music-capture',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[2],processorOptions:{chunkMs:s.adaptive?40:live.delayMs<=100?20:80}});s.mute=ctx.createGain();s.mute.gain.value=0;
    s.input.connect(s.worklet);s.worklet.connect(s.mute);s.mute.connect(ctx.destination);
    s.worklet.port.onmessage=({data:d})=>{
      if(sharing!==s||s.closed)return;
      const observed=performance.now()+clock.offsetMs+(d.start-ctx.currentTime)*1000;
      const captureMs=s.clock.stamp(d.frames,d.sampleRate,observed);
      s.queue.push(makePacket({generation:s.generation,sequence:s.sequence++,sampleRate:d.sampleRate,frames:d.frames,channels:2,captureMs},d.data));
      if(s.adaptive)trimCaptureQueue(s);
      else if(s.queue.length>7){captureFailed('音源上传跟不上实时速度，已结束共享。请检查网络后重试。');return;}
      publish();
    };
    for(const t of stream.getTracks())t.onended=()=>{if(sharing===s){stopAt();closeCapture();request('control',{action:'end'}).then(apply).catch(()=>{});}};
    notice('音源已连接，各设备就绪后按共同时间播放');
  }catch(e){if(!sharing&&stream)for(const t of stream.getTracks())t.stop();if(live?.sourceId===id&&!sharing)request('control',{action:'end'}).then(apply).catch(()=>{});notice(e.name==='NotAllowedError'?'共享已取消或未获授权':e.message,true);}
  finally{shareBusy=false;render();}
}
const rosterRows=new Map(),mixerTimers=new Map(),pendingVolumes=new Map();
let pulseWorker=null,pulseFallback=false,lastMediaTitle='';
async function copyText(value,label){
  try{if(navigator.clipboard)await navigator.clipboard.writeText(value);else{const input=document.createElement('textarea');input.value=value;document.body.append(input);input.select();const ok=document.execCommand('copy');input.remove();if(!ok)throw Error();}notice(label+'已复制');}catch{notice('请手动选中复制：'+value);}
}
async function control(action,details={}){try{await hello();apply(await request('control',{action,...details}));}catch(e){notice(e.message,true);}}
function queueVolume(value,clientId=''){
  value=clamp(Math.round(Number(value)||0),0,100);const key=clientId||'*';pendingVolumes.set(key,value);clearTimeout(mixerTimers.get(key));
  if(!clientId)$('roomVolumeValue').textContent=value+'%';
  mixerTimers.set(key,setTimeout(async()=>{
    try{apply(await request('control',{action:'volume',value,...(clientId?{clientId}:{})}));}
    catch(e){notice(e.message,true);}
    finally{pendingVolumes.delete(key);mixerTimers.delete(key);render();}
  },130));
}
function rowFor(c){
  if(rosterRows.has(c.id))return rosterRows.get(c.id);
  const el=document.createElement('div');el.className='client-row';el.dataset.deviceId=c.id;
  const avatar=document.createElement('div');avatar.className='client-avatar';
  const body=document.createElement('div'),name=document.createElement('div'),meta=document.createElement('div');name.className='client-name';meta.className='client-meta';body.append(name,meta);
  const status=document.createElement('div');status.className='client-status';
  const volumeBox=document.createElement('div');volumeBox.className='client-volume';
  const slider=document.createElement('input');slider.type='range';slider.min=0;slider.max=100;slider.value=c.remoteVolume??100;slider.setAttribute('aria-label','调节 '+c.name+' 的网页音量');
  const output=document.createElement('output'),mute=document.createElement('button');mute.type='button';mute.className='mute-button';mute.textContent='静音';
  const readonly=document.createElement('div');readonly.className='volume-readonly';
  slider.oninput=()=>{output.textContent=slider.value+'%';queueVolume(slider.value,c.id);};
  mute.onclick=()=>queueVolume((clients.find(x=>x.id===c.id)?.remoteVolume??100)===0?100:0,c.id);
  volumeBox.append(slider,output,mute);el.append(avatar,body,status,volumeBox,readonly);$('clients').append(el);
  const row={el,avatar,name,meta,status,volumeBox,slider,output,mute,readonly};rosterRows.set(c.id,row);return row;
}
function renderRoster(mine){
  const existing=new Set();
  for(const c of clients){
    existing.add(c.id);const row=rowFor(c),info=c.deviceInfo||{};
    row.avatar.textContent=c.name.slice(0,1).toUpperCase();
    row.name.textContent=c.name+(c.id===id?' · 本机':'');
    row.meta.textContent=[info.platform,info.model,info.browser,'ID '+c.id.slice(0,8).toUpperCase()].filter(Boolean).join(' · ');row.meta.title='设备标识：'+c.id;
    const state=c.reconnecting?(c.contextState!=='running'?'等待恢复声音':'正在重连／同步'):!c.enabled?'未加入':c.error?'需要恢复':!c.stream?'连接音频中':c.ready?(c.visibility==='hidden'?'后台共听':'已就绪'):'正在准备';
    row.status.replaceChildren(document.createTextNode(state));row.status.dataset.ready=String(c.ready);
    row.status.title=c.error||('时钟估计误差 '+(c.uncertaintyMs?.toFixed(1)??'—')+' ms');
    const role=[c.controller?'主持':'',c.source?'音源':''].filter(Boolean).join(' · ');
    if(role){const badge=document.createElement('span');badge.className='client-role';badge.textContent=role;row.status.append(badge);}
    const remote=pendingVolumes.get(c.id)??c.remoteVolume??100;
    row.volumeBox.hidden=!mine;row.readonly.hidden=mine;
    if(document.activeElement!==row.slider&&!pendingVolumes.has(c.id))row.slider.value=remote;
    row.output.textContent=remote+'%';row.mute.dataset.muted=String(remote===0);row.mute.textContent=remote===0?'取消静音':'静音';
    row.readonly.textContent='主持设置 '+Math.round((live?.masterVolume??100)*remote/100)+'%';
  }
  for(const [key,row]of rosterRows)if(!existing.has(key)){row.el.remove();rosterRows.delete(key);}
}
function updateMediaSession(){
  if(!('mediaSession'in navigator))return;
  try{
    const source=clients.find(c=>c.id===live?.sourceId)?.name||'局域网共听',title=live?.sourceId?source+' · 同频':'同频 · 局域网共听';
    if(lastMediaTitle!==title&&window.MediaMetadata){navigator.mediaSession.metadata=new MediaMetadata({title,artist:'同频 · 一起听',album:'局域网实时音乐'});lastMediaTitle=title;}
    navigator.mediaSession.playbackState=enabled&&ctx?.state==='running'&&live?.status==='playing'?'playing':enabled?'paused':'none';
  }catch{}
}
function renderMetrics(){
  $('clockValue').textContent=Number.isFinite(clock.uncertaintyMs)?clock.uncertaintyMs.toFixed(1)+' ms':'校时中';
  $('driftValue').textContent=Number.isFinite(driftMs)?driftMs.toFixed(1)+' ms':'—';
  const latest=packets.filter(p=>p.generation===live?.generation).at(-1);
  $('bufferValue').textContent=latest?Math.max(0,(latest.playoutEndMs??latest.captureMs+latest.durationMs+(live?.delayMs||0))-now()).toFixed(0)+' ms':'—';
  $('outputValue').textContent=ctx?(((ctx.baseLatency||0)+(ctx.outputLatency||0))*1000).toFixed(0)+' ms':'—';
  $('volumeValue').textContent=volume+'%';
  const self=clients.find(c=>c.id===id),remote=(live?.masterVolume??100)*(self?.remoteVolume??100)/100;
  $('volumeLimit').textContent='主持设置 '+Math.round(remote)+'% · 当前网页合成音量 '+Math.round(volume*remote/100)+'%';
  $('backgroundValue').textContent=recovering?'本机正在自动恢复，其他设备继续播放':ctx?.state==='interrupted'||ctx?.state==='suspended'&&enabled?'正在尝试恢复声音；如受限制请点加入':enabled&&document.hidden?'后台共听中 · 断线将独立重连':pulseWorker?(navigator.mediaSession?'已启用后台调度与媒体控制':'已启用后台调度'):'已启用媒体播放兼容模式';
}
function render(){
  const mine=live?.controllerId===id,mobile=['Android','iOS','iPadOS'].includes(deviceInfo.platform);
  const desktop=!mobile&&/Windows|Macintosh|Linux/.test(navigator.userAgent);
  const contextClass=window.AudioContext||window.webkitAudioContext;
  const canSource=isSecureContext&&desktop&&!!navigator.mediaDevices?.getUserMedia&&!!window.AudioWorkletNode&&typeof contextClass?.prototype?.setSinkId==='function';
  const lookup=who=>clients.find(c=>c.id===who)?.name||'未连接',self=clients.find(c=>c.id===id);
  $('controllerName').textContent=live?.controllerId?lookup(live.controllerId):'待接管';$('sourceName').textContent=live?.sourceId?lookup(live.sourceId):'未连接';
  $('sourceTitle').textContent=live?.sourceId?lookup(live.sourceId)+' 的系统声音':'等待连接音源';
  const labels={idle:'等待音源',preparing:'音源准备中',playing:'实时共听中',paused:'全体暂停',ended:'共享已结束'};
  $('roomStatus').textContent=labels[live?.status]||'连接中';$('roomStatus').dataset.status=live?.status||'idle';
  $('delayValue').textContent=live?Math.round(live.delayMs)+' 毫秒'+(live.adaptive?' · 自动':''):'等待连接';
  $('delayValue').title=live?.adaptive?live.adaptive.reason+'；目标 '+live.adaptive.targetMs+' 毫秒，估计下限 '+live.adaptive.floorMs+' 毫秒':'';
  $('adaptiveStatus').hidden=!live?.adaptive;
  if(live?.adaptive)$('adaptiveStatus').textContent=live.adaptive.reason+' · 当前目标 '+live.adaptive.targetMs+' 毫秒';
  $('sourceDescription').textContent=live?.sourceId?'声音由音源设备实时提供。更换主持，不会改变当前音源。':'Windows / Mac 连接 CABLE 后，大家按共同时间出声。';
  $('listenerCount').textContent=clients.filter(c=>c.enabled).length+' 人加入';
  if(self&&!nameEdited&&document.activeElement!==$('deviceName'))$('deviceName').value=self.name;
  $('deviceMeta').textContent=[deviceInfo.platform,deviceInfo.model,deviceInfo.browser].filter(Boolean).join(' · ')||'正在识别设备';
  $('deviceAvatar').textContent=(self?.name||fallbackName(deviceInfo)).slice(0,1).toUpperCase();
  $('deviceIdBtn').textContent=id?'ID '+id.slice(0,8).toUpperCase():'标识识别中';$('deviceIdBtn').disabled=!id;
  $('deviceIdBtn').title=id?'复制完整设备标识：'+id:'正在识别';
  $('nameHint').textContent=!persistentIdentity?'浏览器未允许保存，本次使用临时标识':self?.deviceInfo?.nameSource==='host'?'已读取本机系统名称，可修改显示名':self?.deviceInfo?.nameSource==='network'?'已读取局域网设备名称，可修改显示名':deviceInfo.model?'已识别设备型号，可修改显示名':'浏览器未提供系统名称，可设置显示名；标识在此浏览器中保留';
  $('joinBtn').disabled=enabled&&ctx?.state==='running';$('leaveBtn').disabled=!enabled;
  $('claimBtn').disabled=!enabled||mine;$('claimBtn').textContent=mine?'本机正在主持':'接管主持';
  $('systemShareBtn').disabled=!canSource||shareBusy||!!sharing||!enabled||(!mine&&!!live?.controllerId);$('devicesBtn').disabled=!canSource;
  $('pauseBtn').disabled=!mine||live?.status!=='playing';$('resumeBtn').disabled=!mine||live?.status!=='paused';$('endBtn').disabled=!live?.sourceId||(!mine&&!sharing);
  $('captureHelp').textContent=canSource?'供源端已支持音频设备选择。选择虚拟输入和实际扬声器，就能开始共享。':mobile?'本设备可以收听和接管主持，无需安装 CABLE。系统音源由 Windows / Mac 提供。':!isSecureContext?'收听可直接使用当前地址。供源需要可信 HTTPS，或服务器本机地址。':'本浏览器可以收听。供源需要音频输入、AudioWorklet 和独立回放设备选择，推荐新版 Chrome／Edge。';
  $('sourcePlatform').textContent=deviceInfo.platform==='macOS'?'macOS · VB-Cable':deviceInfo.platform==='Windows'?'Windows · VB-CABLE':'Windows / Mac';
  $('outputOptions').hidden=mobile||!isSecureContext||typeof contextClass?.prototype?.setSinkId!=='function';
  const setup=document.querySelector('.system-setup');setup.hidden=mobile;if(!setup.dataset.initialized&&deviceInfo.platform){setup.open=!mobile;setup.dataset.initialized='true';}
  $('routingHelp').textContent=deviceInfo.platform==='macOS'?'Mac：音乐 App 或系统输出选择 VB-Cable；下方输入选择 VB-Cable，回放选择 Mac 扬声器或耳机。不要用同时包含虚拟通道的多输出设备。':'Windows：音乐软件或系统输出选择 CABLE Input；下方输入选择 CABLE Output，回放选择真实扬声器。不要开启“侦听此设备”。';
  $('localState').textContent=!enabled?'尚未加入':recovering?'自动恢复中':ctx?.state!=='running'?'需要恢复声音':!clock.ready?'校时中':!audioConnected?'连接音频中':'已加入';
  $('connectionStatus').textContent=connected?'房间已连接':'连接中断';
  $('hostMixer').hidden=!mine;
  const roomVolume=pendingVolumes.get('*')??live?.masterVolume??100;
  if(document.activeElement!==$('roomVolume')&&!pendingVolumes.has('*'))$('roomVolume').value=roomVolume;
  $('roomVolumeValue').textContent=roomVolume+'%';renderRoster(mine);
  const lan=urls?.http?.find(u=>!u.includes('127.0.0.1'));if(lan){$('shareUrl').href=lan;$('shareUrl').textContent=lan;}
  const https=urls?.https?.find(u=>!u.includes('127.0.0.1'));
  $('secureHelp').hidden=isSecureContext||!https||mobile;
  if(!$('secureHelp').hidden){$('secureHelp').replaceChildren(document.createTextNode('供源设备首次设置：'));const cert=document.createElement('a');cert.href='/live/server.cer';cert.download='Tongpin-LAN.cer';cert.textContent='下载服务器证书';$('secureHelp').append(cert,document.createTextNode('，Windows 安装到当前用户受信任的根证书，Mac 在钥匙串中设置信任。重启浏览器后打开 '));const a=document.createElement('a');a.href=https;a.textContent=https;$('secureHelp').append(a);}
  renderMetrics();updateMediaSession();
}
$('claimBtn').onclick=()=>control('claim');$('pauseBtn').onclick=()=>control('pause');$('resumeBtn').onclick=()=>control('resume');$('endBtn').onclick=()=>control('end');$('systemShareBtn').onclick=share;$('devicesBtn').onclick=readDevices;
$('joinBtn').onclick=()=>join().catch(e=>notice(e.message,true));$('leaveBtn').onclick=()=>leave().catch(e=>notice(e.message,true));
$('volume').oninput=()=>{volume=Number($('volume').value);storage.setItem('live-volume',volume);if(master)master.gain.setTargetAtTime(volume/100,ctx.currentTime,.015);renderMetrics();};
$('roomVolume').oninput=()=>queueVolume($('roomVolume').value);
$('offset').onchange=()=>{advance=clamp(Number($('offset').value)||0,-500,500);$('offset').value=advance;storage.setItem('live-advance',advance);stopAt();cursor=null;scheduledSequence=-1;schedule();heartbeat();};
$('deviceName').oninput=()=>{nameEdited=true;customName=$('deviceName').value.trim();storage.setItem('tp-device-name-v1',customName);};
$('deviceName').onchange=async()=>{try{await hello();apply(await request('profile',{name:customName}));nameEdited=false;render();}catch(e){notice(e.message,true);}};
$('deviceIdBtn').onclick=()=>copyText(id,'设备标识');
$('outputDevicesBtn').onclick=readDevices;
async function chooseOutput(deviceId){
  try{
    if(sharing&&!deviceId)throw Error('供源期间请明确选择真实扬声器，避免回放进入虚拟通道');
    if(deviceId&&!audioDevices.some(d=>physicalOutput(d)&&d.deviceId===deviceId))throw Error('请选择实际扬声器或耳机');
    await ensureContext();if(typeof ctx.setSinkId!=='function')throw Error('本浏览器不能单独选择回放设备');
    await ctx.setSinkId(deviceId);storage.setItem('live-physical-output',deviceId);warmUntil=performance.now()+600;error='';
    $('listenOutput').value=deviceId;if(deviceId)$('systemOutput').value=deviceId;heartbeat();notice('本机回放设备已切换，正在确认同步状态');
  }catch(e){notice(e.message,true);}
}
$('listenOutput').onchange=()=>chooseOutput($('listenOutput').value);
$('systemOutput').onchange=()=>{if($('systemOutput').value)chooseOutput($('systemOutput').value);};
$('syncBtn').onclick=syncClock;
$('copyBtn').onclick=()=>copyText($('shareUrl').href,'加入地址');
document.addEventListener('visibilitychange',async()=>{
  if(!document.hidden){try{if(enabled&&ctx?.state!=='running'){await ctx.resume();if(ctx.state==='running')error='';}}catch{}syncClock();}
  retryAt=0;recoverConnection();heartbeat();updateMediaSession();renderMetrics();
});
window.addEventListener('offline',()=>markRecovery('网络已断开，正在自动重连'));
window.addEventListener('online',()=>{retryAt=0;recoverConnection();heartbeat();});
window.addEventListener('pagehide',()=>{closeCapture();stopAt();});
if('mediaSession'in navigator)for(const [action,handler]of Object.entries({
  play:async()=>{try{if(!enabled)await join();else if(live?.controllerId===id&&live.status==='paused')await control('resume');else{await ensureContext();error='';heartbeat();}}catch(e){notice(e.message,true);}},
  pause:()=>live?.controllerId===id?control('pause'):leave(),
  stop:()=>leave()
})){try{navigator.mediaSession.setActionHandler(action,handler);}catch{}}
function playbackPulse(){recoverConnection();schedule();renderMetrics();}
function fallbackPulses(){if(pulseFallback)return;pulseFallback=true;pulseWorker?.terminate();pulseWorker=null;setInterval(heartbeat,750);setInterval(syncClock,10000);setInterval(playbackPulse,200);}
try{pulseWorker=new Worker('/live/pulse-worker.mjs',{type:'module'});pulseWorker.onmessage=({data})=>{if(data.type==='heartbeat')heartbeat();else if(data.type==='clock')syncClock();else playbackPulse();};pulseWorker.onerror=fallbackPulses;}catch{fallbackPulses();}
window.liveDiagnostics=()=>({id,enabled,audioConnected,connected,recovering,retryCount,contextState:ctx?.state,deviceInfo,deviceName:clients.find(c=>c.id===id)?.name,persistentIdentity,clock:{ready:clock.ready,uncertaintyMs:clock.uncertaintyMs},driftMs,packets:packets.length,scheduled:nodes.length,sharing:!!sharing,sourceSequence:sharing?.sequence,sourceDropped:sharing?.dropped,metrics:playbackMetrics.snapshot(sharing?.dropped||0),localVolume:volume,remoteGain:remoteGain?.gain.value,backgroundWorker:!!pulseWorker,mediaSession:!!navigator.mediaSession,live});
hello().then(()=>{notice('房间已连接，请先点“加入共听”');render();}).catch(e=>notice('连接失败：'+e.message,true));render();
