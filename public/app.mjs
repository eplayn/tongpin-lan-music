import {ClockEstimator, clamp, effectiveState, positionAt, outputMap, targetContextTime, serverAtContextTime, segmentPosition} from './sync-core.mjs';
const $=id=>document.getElementById(id);
const id=sessionStorage.getItem('shared-music-id')||Array.from(crypto.getRandomValues(new Uint32Array(4)),n=>n.toString(16).padStart(8,'0')).join('');
sessionStorage.setItem('shared-music-id',id);
let clock=new ClockEstimator(),ctx=null,master=null,buffer=null,bufferId=null,loadingId=null,loadToken=0;
let room=null,tracks=[],clients=[],token=null,bootId=null,enabled=false,connected=false,source=null,lease=0;
let clientError='',driftMs=null,scheduledRevision=null,lastReschedule=0,heartbeatBusy=false,syncBusy=false,needsGesture=false;
let advance=Number(localStorage.getItem('shared-music-advance-ms'))||0;
let volume=Number(localStorage.getItem('shared-music-volume')??70);
let pendingSeek=null;
const defaultName=/iPhone|iPad/.test(navigator.userAgent)?'iPhone / iPad':/Android/.test(navigator.userAgent)?'安卓手机':'电脑';
$('deviceName').value=localStorage.getItem('shared-music-name')||defaultName;
$('offset').value=advance;$('volume').value=volume;
const now=()=>performance.now()+clock.offsetMs;
const fmt=s=>{s=Math.max(0,Number(s)||0);return Math.floor(s/60)+':'+String(Math.floor(s%60)).padStart(2,'0');};
function notice(text,error=false){$('notice').textContent=text;$('notice').dataset.kind=error?'error':'info';}
function contextAt(t){return targetContextTime(t,clock.offsetMs,advance,ctx,performance.now());}
function audibleContextNow(){return contextAt(now());}
function stopCurrent(at=null){
  if(!source)return;
  if(at!==null){source.plannedStop=Math.min(source.plannedStop,at);renewLease();return;}
  try{source.node.stop();source.gain.disconnect();}catch{}
  source=null;scheduledRevision=null;driftMs=null;
}
function renewLease(){
  if(!source||!ctx||!lease)return;
  try{source.node.stop(Math.max(ctx.currentTime+.01,contextAt(Math.min(lease,source.plannedStop))));}catch{}
}
function schedulePlayback(force=false){
  if(!enabled||!connected||!clock.ready||ctx?.state!=='running'||needsGesture||!room||room.status!=='playing'||bufferId!==room.trackId||!buffer)return;
  if(!force&&source&&scheduledRevision===room.revision)return;
  let start=Math.max(room.anchorMs,now()+650);
  let when=contextAt(start);
  if(when<ctx.currentTime+.12){when=ctx.currentTime+.12;start=serverAtContextTime(when,clock.offsetMs,advance,ctx,performance.now());}
  const offset=positionAt({...room,previous:null},start);
  if(offset>=buffer.duration-.02){stopCurrent();return;}
  const old=source,node=ctx.createBufferSource(),gain=ctx.createGain();node.buffer=buffer;node.connect(gain);gain.connect(master);
  gain.gain.setValueAtTime(old?0:1,when);if(old)gain.gain.linearRampToValueAtTime(1,when+.025);
  if(old){try{old.gain.gain.setValueAtTime(1,when);old.gain.gain.linearRampToValueAtTime(0,when+.025);old.node.stop(when+.03);}catch{}}
  const next={node,gain,when,offset,segments:[{ctx:when,position:offset,rate:1}],rate:1,plannedStop:Infinity,revision:room.revision};
  source=next;scheduledRevision=room.revision;
  node.onended=()=>{try{gain.disconnect();}catch{}if(source===next){source=null;scheduledRevision=null;}};
  node.start(when,offset);renewLease();
}
async function prepare(){
  const trackId=room?.trackId;
  if(!enabled||!ctx||!trackId||bufferId===trackId||loadingId===trackId)return;
  const attempt=++loadToken;loadingId=trackId;buffer=null;bufferId=null;clientError='';
  notice('正在完整缓冲音乐，完成后按统一时间加入…');
  try{
    const response=await fetch(`/media/${encodeURIComponent(trackId)}.wav`);if(!response.ok)throw Error('音乐下载失败');
    const bytes=await response.arrayBuffer();
    const decoded=await ctx.decodeAudioData(bytes);
    if(attempt!==loadToken||!enabled)return;
    if(decoded.duration>12*60+.5||decoded.length*decoded.numberOfChannels*4>270*1024*1024)throw Error('歌曲过长，当前版本仅支持十二分钟以内曲目');
    buffer=decoded;bufferId=trackId;loadingId=null;clientError='';
    await heartbeat();applyRoom();notice('缓冲完成，等待统一起播或加入当前进度');
  }catch(e){if(attempt===loadToken){loadingId=null;clientError=e.message;notice(e.message,true);heartbeat();}}
}
function applyRoom(){
  if(!enabled||!room||!ctx)return;
  if(room.status==='preparing'||room.status==='paused'){
    if(source)stopCurrent(room.anchorMs);
  }else if(room.status==='idle')stopCurrent();
  prepare();
  if(room.status==='playing')schedulePlayback();
}
function snapshot(data){
  const previousRevision=room?.revision;
  if(bootId&&data.bootId&&bootId!==data.bootId){stopCurrent();clock=new ClockEstimator();lease=0;clientError='服务器已重启，正在重新校时';syncClock();}
  bootId=data.bootId||bootId;
  if(data.room&&(!room||data.room.revision>=room.revision))room=data.room;
  tracks=data.tracks||tracks;clients=data.clients||clients;
  const self=clients.find(c=>c.id===id);
  if(enabled&&self?.excluded){enabled=false;++loadToken;loadingId=null;stopCurrent();notice('主持人已将本机移出共听，再次加入需手动操作',true);}
  if(Number.isFinite(data.leaseUntilMs)){lease=data.leaseUntilMs;renewLease();}
  renderLibrary();renderClients();applyRoom();
  if(room?.revision!==previousRevision&&room?.message)notice(room.message);
}
async function syncClock(){
  if(syncBusy)return;syncBusy=true;
  try{
    const count=clock.samples.length?4:9;
    for(let i=0;i<count;i++){
      const a=performance.now();const response=await fetch('/api/clock',{cache:'no-store'});const c=await response.json();const b=performance.now();
      if(bootId&&c.bootId!==bootId){clock=new ClockEstimator();stopCurrent();}bootId=c.bootId;
      clock.add(a,c.receiveMs,c.sendMs,b);await new Promise(r=>setTimeout(r,25));
    }
    if(clock.ready&&clientError==='服务器已重启，正在重新校时')clientError='';
    applyRoom();
  }catch(e){notice('校时失败：'+e.message,true);}finally{syncBusy=false;}
}
async function heartbeat(){
  if(heartbeatBusy)return;heartbeatBusy=true;
  try{
    const outputLatencyMs=ctx?((Number(ctx.baseLatency)||0)+(Number(ctx.outputLatency)||0))*1000:0;
    const tooSlow=outputLatencyMs+Math.max(0,advance)+350>4000;
    const ready=enabled&&bufferId===room?.trackId&&clock.ready&&ctx?.state==='running'&&!needsGesture&&!clientError&&!tooSlow;
    const response=await fetch('/api/client',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,name:$('deviceName').value.slice(0,40),enabled,readyTrackId:ready?bufferId:null,duration:ready?buffer.duration:null,error:clientError||(enabled&&tooSlow?'设备输出延迟过大，超出当前同步保护窗口':!clock.ready&&enabled?'校时尚未完成':needsGesture?'请点击加入共听恢复声音':''),clockUncertaintyMs:Number.isFinite(clock.uncertaintyMs)?clock.uncertaintyMs:null,driftMs,contextState:ctx?.state||'closed',outputLatencyMs,advanceMs:advance})});
    if(!response.ok)throw Error((await response.json()).error||'心跳失败');
    snapshot(await response.json());
  }catch(e){if(enabled){notice('连接中断，本机将停止播放：'+e.message,true);stopCurrent();}}finally{heartbeatBusy=false;}
}
async function join(){
  try{
    if(!ctx){const Audio=window.AudioContext||window.webkitAudioContext;if(!Audio)throw Error('此浏览器不支持 Web Audio');ctx=new Audio({latencyHint:'interactive',sampleRate:44100});master=ctx.createGain();master.gain.value=volume/100;master.connect(ctx.destination);
      ctx.onstatechange=()=>{if(enabled&&ctx.state!=='running'){needsGesture=true;clientError='设备音频被系统暂停，请点击加入共听恢复';stopCurrent();notice(clientError,true);heartbeat();}};
    }
    await ctx.resume();if(ctx.state!=='running')throw Error('请再次点加入共听，允许浏览器播放声音');
    needsGesture=false;clientError='';enabled=true;localStorage.setItem('shared-music-name',$('deviceName').value);
    await syncClock();await heartbeat();prepare();notice('已加入，正在准备同步音频');
  }catch(e){notice(e.message,true);}
}
async function control(action,extra={}){
  if(!token)return;
  try{if(['play','select','seek','next'].includes(action)&&(!enabled||needsGesture))await join();
    const response=await fetch('/api/control',{method:'POST',headers:{'Content-Type':'application/json','X-Control-Token':token},body:JSON.stringify({action,...extra})});const data=await response.json();if(!response.ok)throw Error(data.error||'操作失败');pendingSeek=null;snapshot(data);
  }catch(e){notice(e.message,true);}
}
function renderLibrary(){
  const key=JSON.stringify([tracks.map(t=>[t.id,t.title,t.duration]),room?.trackId,Boolean(token)]);
  if($('library').dataset.key===key)return;$('library').dataset.key=key;$('library').replaceChildren();
  for(const track of tracks){const b=document.createElement('button');b.type='button';b.className='track-row'+(track.id===room?.trackId?' active':'');b.disabled=!token;b.dataset.trackId=track.id;
    const name=document.createElement('span');name.className='track-name';name.textContent=track.title;
    const meta=document.createElement('span');meta.className='track-detail';meta.textContent=fmt(track.duration)+' · 同步音源';b.append(name,meta);b.onclick=()=>control('select',{trackId:track.id});$('library').append(b);}
  if(!tracks.length)$('library').textContent='音乐库为空，请由本机上传音乐。';
}
function renderClients(){
  $('clients').replaceChildren();
  for(const c of clients){const tr=document.createElement('tr');const fields=[c.name+(c.id===id?'（本机）':''),c.error||(!c.enabled?'未加入':c.readyTrackId===room?.trackId?'已就绪':'缓冲 / 校时中'),Number.isFinite(c.clockUncertaintyMs)?'±'+c.clockUncertaintyMs.toFixed(1)+' ms':'—',Number.isFinite(c.driftMs)?c.driftMs.toFixed(1)+' ms':'—'];
    for(const value of fields){const td=document.createElement('td');td.textContent=value;tr.append(td);}const td=document.createElement('td');if(token&&c.id!==id&&c.enabled){const b=document.createElement('button');b.type='button';b.className='button button-quiet';b.textContent='移出共听';b.onclick=()=>control('exclude',{clientId:c.id});td.append(b);}tr.append(td);$('clients').append(tr);
  }
}
function correctDrift(){
  if(!enabled||!source||!ctx||ctx.state!=='running'||!clock.ready||effectiveState(room,now())?.status!=='playing')return;
  const audible=audibleContextNow();if(audible<source.when+.1)return;
  const actual=segmentPosition(source.segments,audible),wanted=positionAt(room,now());driftMs=(actual-wanted)*1000;
  if(Math.abs(driftMs)>70&&now()-lastReschedule>5000){lastReschedule=now();schedulePlayback(true);return;}
  const rate=clamp(1-driftMs/8000,.997,1.003);
  if(Math.abs(rate-source.rate)>.00002){const at=ctx.currentTime;const p=segmentPosition(source.segments,at);source.segments.push({ctx:at,position:p,rate});if(source.segments.length>80)source.segments.splice(0,40);source.node.playbackRate.setValueAtTime(rate,at);source.rate=rate;}
}
function tick(){
  if(room){const playing=effectiveState(room,now());const track=tracks.find(t=>t.id===room.trackId);
    $('trackTitle').textContent=track?.title||'等待音乐';$('trackMeta').textContent=track?'共同的音乐，同一条时间线':'由本机添加音乐后开始共听';
    $('roomStatus').textContent=room.status==='preparing'?'等待所有设备缓冲':(playing?.status==='playing'?(room.status==='paused'?'即将统一暂停':'正在共听'):(room.status==='playing'?'统一起播倒计时 '+Math.max(0,(room.anchorMs-now())/1000).toFixed(1)+'s':'已暂停'));
    const duration=track?.duration||room.duration||0,p=positionAt(room,now());$('elapsed').textContent=fmt(p);$('duration').textContent=fmt(duration);
    if(pendingSeek===null&&document.activeElement!==$('progress'))$('progress').value=duration?Math.round(p/duration*1000):0;
    if(room.message)$('roomStatus').dataset.message=room.message;
  }
  $('connectionStatus').textContent=connected?'局域网已连接':'正在连接';
  $('clockValue').textContent=clock.ready?'±'+clock.uncertaintyMs.toFixed(1)+' ms':'校时中';
  $('driftValue').textContent=enabled&&Number.isFinite(driftMs)?(driftMs>=0?'+':'')+driftMs.toFixed(1)+' ms':'—';
  $('outputValue').textContent='—';
  if(ctx){const lag=((Number(ctx.baseLatency)||0)+(Number(ctx.outputLatency)||0))*1000;$('outputValue').textContent=lag.toFixed(1)+' ms · '+(outputMap(ctx,performance.now()).mode==='timestamp'?'输出时钟':'估计值');}
  $('joinBtn').textContent=!enabled?'加入共听':needsGesture?'恢复共听':'已加入 · 重新校时';$('leaveBtn').disabled=!enabled;
  if(enabled&&lease&&now()>lease){stopCurrent();notice('连接租约过期，已停止本机音频，等待重新连接',true);}
  correctDrift();
}
$('joinBtn').onclick=join;$('leaveBtn').onclick=()=>{enabled=false;needsGesture=false;clientError='';++loadToken;loadingId=null;buffer=null;bufferId=null;stopCurrent();heartbeat();notice('已退出共听');};
$('playBtn').onclick=()=>control('play');$('pauseBtn').onclick=()=>control('pause');$('nextBtn').onclick=()=>control('next');
$('progress').oninput=()=>{if(token)pendingSeek=Number($('progress').value);};
$('seekBtn').onclick=()=>control('seek',{position:(pendingSeek??Number($('progress').value))/1000*(tracks.find(t=>t.id===room?.trackId)?.duration||room?.duration||0)});
$('volume').oninput=()=>{volume=Number($('volume').value);localStorage.setItem('shared-music-volume',volume);if(master)master.gain.setTargetAtTime(volume/100,ctx.currentTime,.02);};
$('offset').onchange=()=>{advance=clamp(Number($('offset').value)||0,-1000,2000);$('offset').value=advance;localStorage.setItem('shared-music-advance-ms',advance);if(source)schedulePlayback(true);};
$('syncBtn').onclick=async()=>{await syncClock();if(enabled)heartbeat();};
$('copyLinkBtn').onclick=async()=>{try{if(navigator.clipboard)await navigator.clipboard.writeText($('shareUrl').href);else throw Error();notice('共听地址已复制');}catch{notice('共听地址：'+$('shareUrl').href);}};
$('upload').onchange=async()=>{const file=$('upload').files[0];if(!file||!token)return;try{notice('正在上传并准备统一音源…');const r=await fetch('/api/upload?name='+encodeURIComponent(file.name),{method:'POST',headers:{'X-Control-Token':token,'Content-Type':'application/octet-stream'},body:file});const data=await r.json();if(!r.ok)throw Error(data.error||'上传失败');snapshot(data);notice('音乐已添加');}catch(e){notice(e.message,true);}finally{$('upload').value='';}};
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&enabled){syncClock();heartbeat();}});
async function init(){
  try{const r=await fetch('/api/session');if(!r.ok)throw Error('服务器连接失败');const s=await r.json();token=s.controlToken||null;document.body.dataset.role=token?'host':'listener';document.querySelectorAll('.host-only').forEach(e=>e.hidden=!token);
    const url=s.urls?.find(u=>!u.includes('127.0.0.1'))||s.urls?.[0]||location.origin;$('shareUrl').href=url;$('shareUrl').textContent=url;snapshot(s);
    const stream=new EventSource('/events?id='+encodeURIComponent(id));stream.addEventListener('snapshot',event=>{connected=true;snapshot(JSON.parse(event.data));});stream.onopen=()=>{connected=true;if(clientError==='信令连接中断')clientError='';heartbeat();};stream.onerror=()=>{connected=false;if(enabled){stopCurrent();clientError='信令连接中断';notice(clientError,true);}};
    await syncClock();setInterval(heartbeat,1500);setInterval(syncClock,10000);setInterval(tick,250);heartbeat();
  }catch(e){notice(e.message+'，请刷新重试',true);}
}
window.musicDiagnostics=()=>({id,enabled,connected,clock:{ready:clock.ready,uncertaintyMs:clock.uncertaintyMs,rttMs:clock.rttMs},driftMs,bufferId,bufferDuration:buffer?.duration,contextState:ctx?.state,room,scheduled:source?{when:source.when,offset:source.offset,rate:source.rate}:null});
init();
