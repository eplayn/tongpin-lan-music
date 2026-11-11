import crypto from 'node:crypto';
import {readPacket,HEADER_BYTES,withPlayout} from '../public/live/protocol.mjs';
import {cleanDeviceInfo} from './device-info.mjs';
import {AdaptiveBuffer} from './adaptive-buffer.mjs';

export const LIVE_LEASE_MS=6500;
export class LiveRoom {
  constructor({now,onState=()=>{},onAudio=()=>{},bufferMode='stable'}) {
    this.bufferMode=['minimum','100ms','adaptive'].includes(bufferMode)?bufferMode:'stable';
    Object.assign(this,{now,onState,onAudio,clients:new Map(),controllerId:null,generation:0,revision:0,sourceId:null,status:'idle',delayMs:2000,playFromMs:null,stopAtMs:null,transitionAtMs:null,format:null,sequence:-1,lastCaptureEnd:null,lastPacketAt:0,history:[],historyBytes:0,masterVolume:100,volumeRevision:0,message:'等待 Windows / Mac 连接音源'});
    if(this.bufferMode==='100ms')this.delayMs=100;
    if(this.bufferMode==='adaptive'){this.adaptive=new AdaptiveBuffer(now());this.delayMs=1000;}
  }
  hello({id,name,token,deviceKey,deviceInfo},hint={}) {
    const persistent=typeof deviceKey==='string'&&/^[a-f0-9]{64}$/.test(deviceKey);
    if(deviceKey&&!persistent)throw Error('设备密钥无效');
    if(persistent)id=crypto.createHash('sha256').update(deviceKey).digest('hex').slice(0,32);
    if(typeof id!=='string'||!/^[a-f0-9-]{16,64}$/.test(id)) throw Error('设备标识无效');
    let c=this.clients.get(id);
    if(c){
      if(!persistent&&token!==c.token)throw Error('设备凭据已过期，请刷新页面');
      if(persistent){
        if(this.sourceId===id)this.endSource('音源页面已切换，请在新页面重新共享');
        c.token=crypto.randomBytes(24).toString('hex');c.enabled=false;c.wantsAudio=false;c.ready=false;c.stream=false;
      }
    }
    else {if(this.clients.size>=48)throw Error('房间人数已满');c={id,token:crypto.randomBytes(24).toString('hex'),enabled:false,ready:false,stream:false,lastSeen:this.now(),remoteVolume:100};this.clients.set(id,c);}
    c.deviceInfo={...cleanDeviceInfo(deviceInfo),realName:String(hint.realName||'').slice(0,64),nameSource:hint.nameSource||'browser'};
    c.autoName=c.deviceInfo.realName||c.deviceInfo.model||({Windows:'Windows 电脑',macOS:'Mac',iOS:'iPhone',iPadOS:'iPad',Android:'安卓设备',Linux:'Linux 电脑'}[c.deviceInfo.platform])||'网页设备';
    c.name=String(name||c.autoName).trim().slice(0,64)||c.autoName;c.lastSeen=this.now();
    return {id:c.id,token:c.token};
  }
  auth(id,token) {
    const c=this.clients.get(id);
    if(!c||typeof token!=='string'||Buffer.byteLength(token)!==Buffer.byteLength(c.token)||!crypto.timingSafeEqual(Buffer.from(token),Buffer.from(c.token))){const error=Error(c?'本机已在另一页面连接，请在需要的页面重新加入':'连接已过期，正在自动重新连接');error.status=401;error.code=c?'SESSION_REPLACED':'SESSION_EXPIRED';throw error;}
    return c;
  }
  ready(c) {return c.enabled&&c.stream&&c.ready&&!c.error&&c.contextState==='running'&&Number.isFinite(c.uncertaintyMs)&&c.uncertaintyMs<=25&&Number.isFinite(c.outputLatencyMs)&&c.outputLatencyMs+Math.max(0,c.advanceMs)+(this.adaptive?20:this.delayMs<=100?2:600)<this.delayMs&&this.now()-c.lastSeen<LIVE_LEASE_MS;}
  heartbeat(c,input) {
    c.lastSeen=this.now();c.enabled=!!input.enabled;c.wantsAudio=c.enabled;c.contextState=String(input.contextState||'suspended');
    c.uncertaintyMs=Number.isFinite(input.uncertaintyMs)?input.uncertaintyMs:Infinity;
    c.outputLatencyMs=Number.isFinite(input.outputLatencyMs)?Math.max(0,input.outputLatencyMs):Infinity;
    c.advanceMs=Number.isFinite(input.advanceMs)?Math.max(-500,Math.min(500,input.advanceMs)):0;
    c.ready=!!input.ready;c.error=String(input.error||'').slice(0,180);
    c.bufferGeneration=Number.isSafeInteger(input.bufferGeneration)?input.bufferGeneration:-1;
    c.bufferedPackets=Number.isSafeInteger(input.bufferedPackets)?Math.max(0,Math.min(80,input.bufferedPackets)):0;
    c.driftMs=Number.isFinite(input.driftMs)?input.driftMs:null;
    c.visibility=input.visibility==='hidden'?'hidden':'visible';
    const m=input.metrics;
    if(m&&m.generation===this.generation){c.metrics={generation:this.generation};for(const key of ['serial','samples','lastSampleAgoMs','arrivalP98Ms','arrivalMedianMs','phaseP98Ms','late','underruns','sourceDrops'])c.metrics[key]=Number.isFinite(m[key])?Math.max(0,Math.min(1e9,m[key])):key==='lastSampleAgoMs'?1e9:0;}
    else c.metrics=null;
    if(!c.enabled&&this.sourceId===c.id)this.endSource('音源设备退出共听');
    this.maybeStart();return {leaseUntilMs:c.lastSeen+LIVE_LEASE_MS,...this.snapshot()};
  }
  stream(c,connected) {
    c.stream=connected;
    this.changed();
  }
  takeControl(c) {if(!c.enabled)throw Error('请先加入共听');this.controllerId=c.id;this.message=`${c.name} 正在主持，音源保持独立`;this.changed();}
  requireControl(c) {if(this.controllerId!==c.id)throw Error('请先接管主持');}
  selectDelay() {
    if(this.adaptive){this.delayMs=this.adaptive.valueAt(this.lastCaptureEnd??this.now());return;}
    if(this.bufferMode==='100ms'){this.delayMs=100;return;}
    if(this.bufferMode!=='minimum'){this.delayMs=2000;return;}
    const outputs=[...this.clients.values()].filter(c=>c.enabled&&Number.isFinite(c.outputLatencyMs)).map(c=>c.outputLatencyMs+Math.max(0,c.advanceMs||0));
    // Keep the strict readiness guard, with no extra jitter margin. Never move
    // the playing timeline when a listener arrives or changes output device.
    this.delayMs=Math.min(2000,Math.floor(600+Math.max(0,...outputs))+1);
  }
  profile(c,{name}){c.name=String(name||'').trim().slice(0,64)||c.autoName||'网页设备';this.changed();}
  volume(c,{value,clientId}){
    this.requireControl(c);
    if(!Number.isFinite(value)||value<0||value>100)throw Error('音量须在 0 到 100 之间');
    if(clientId){const target=this.clients.get(clientId);if(!target)throw Error('设备已离开房间');target.remoteVolume=Math.round(value);}
    else this.masterVolume=Math.round(value);
    this.volumeRevision++;this.changed();
  }
  beginSource(c,options={}) {
    this.requireControl(c);
    if(options.kind&&options.kind!=='system')throw Error('当前仅支持 CABLE 系统音源');
    if(!this.ready(c))throw Error('请先加入共听，等待校时和音频连接就绪');
    if(this.adaptive){this.adaptive.reset(this.now());this.delayMs=1000;}
    this.selectDelay();
    const transition=this.now()+this.noticeMs();
    this.generation++;this.revision++;this.sourceId=c.id;this.status='preparing';this.playFromMs=null;this.stopAtMs=null;this.transitionAtMs=transition;
    this.kind='system';
    this.history=[];this.historyBytes=0;this.format=null;this.sequence=-1;this.lastCaptureEnd=null;this.lastPlayoutEnd=null;this.lastPacketAt=this.now();
    this.message=`${c.name} 正在共享，设备就绪后独立加入`;this.changed();
    return this.snapshot();
  }
  noticeMs(){return Math.max(1400,...[...this.clients.values()].filter(c=>c.enabled).map(c=>Math.min(3400,(Number.isFinite(c.outputLatencyMs)?c.outputLatencyMs:0)+Math.max(0,c.advanceMs||0)+1100)));}
  pause(message='主持人已安排全体暂停') {
    if(!this.sourceId)return;
    this.status='paused';this.stopAtMs=this.now()+this.noticeMs();this.revision++;this.message=message;this.changed();
  }
  resume(c) {
    this.requireControl(c);if(!this.sourceId)throw Error('尚未共享音源');
    this.selectDelay();
    this.status='preparing';this.transitionAtMs=this.now()+this.noticeMs();this.playFromMs=null;this.revision++;this.message='等待音源就绪，各设备重新同步加入实时声音';this.changed();this.maybeStart();
  }
  endSource(message='共享已结束，正在播完共同缓冲') {
    if(!this.sourceId)return;
    this.status='ended';this.stopAtMs=this.lastCaptureEnd===null?this.now()+this.noticeMs():this.lastPlayoutEnd??this.lastCaptureEnd+this.delayMs;
    this.sourceId=null;this.revision++;this.message=message;this.changed();
  }
  receive(c,bytes) {
    if(c.id!==this.sourceId)throw Error('当前音源已更换');
    const p=readPacket(bytes),now=this.now();
    if(p.headerBytes!==HEADER_BYTES||p.generation!==this.generation||p.byteLength!==bytes.byteLength||(this.adaptive?p.sequence<=this.sequence:p.sequence!==this.sequence+1))throw Error('音频顺序或共享会话不匹配');
    // The 100 ms trial drops missed deadlines at each listener; a transient
    // late block must not terminate the whole publisher.
    if(Math.abs(p.captureMs-now)>(this.adaptive?4000:1200)||(!this.adaptive&&this.delayMs>100&&p.captureMs+p.durationMs+this.delayMs<now+600))throw Error('音源上传落后，请检查网络后重新共享');
    if(this.format&&(p.sampleRate!==this.format.sampleRate||p.channels!==this.format.channels))throw Error('音源格式改变，请重新共享');
    if(this.lastCaptureEnd!==null&&(this.adaptive?p.captureMs<this.lastCaptureEnd-1||p.captureMs-this.lastCaptureEnd>4000:Math.abs(p.captureMs-this.lastCaptureEnd)>80))throw Error('音源时钟发生跳变，请重新共享');
    const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    for(let i=HEADER_BYTES;i<bytes.length;i+=4)if(!Number.isFinite(v.getFloat32(i,true)))throw Error('音频样本无效');
    if(this.adaptive)this.adaptive.observeUpload(now,now-p.captureMs,p.sequence>this.sequence+1);
    this.sequence=p.sequence;this.format={sampleRate:p.sampleRate,channels:p.channels};this.lastCaptureEnd=p.captureMs+p.durationMs;this.lastPacketAt=now;
    const outgoing=this.adaptive?withPlayout(bytes,this.adaptive.playoutAt(p.captureMs),this.adaptive.playoutAt(this.lastCaptureEnd)):bytes;
    this.lastPlayoutEnd=this.adaptive?this.adaptive.playoutAt(this.lastCaptureEnd):this.lastCaptureEnd+this.delayMs;
    if(this.adaptive)this.delayMs=this.adaptive.valueAt(this.lastCaptureEnd);
    this.history.push({captureMs:p.captureMs,bytes:Buffer.from(outgoing)});this.historyBytes+=outgoing.length;
    while(this.history.length&&(this.history[0].captureMs<now-3500||this.historyBytes>4*1024*1024))this.historyBytes-=this.history.shift().bytes.length;
    this.onAudio(outgoing);this.maybeStart();return p;
  }
  maybeStart() {
    if(this.status!=='preparing'||!this.sourceId||this.history.length<3||this.now()-this.lastPacketAt>500)return;
    const source=this.clients.get(this.sourceId);
    if(!source||!this.ready(source)||source.bufferGeneration!==this.generation||source.bufferedPackets<3)return;
    this.playFromMs=Math.max(this.lastCaptureEnd+80,this.transitionAtMs-this.delayMs+120);this.stopAtMs=null;this.status='playing';this.revision++;
    this.message='实时共听中 · 所有设备使用共同播放时间';this.changed();
  }
  tick() {
    const now=this.now();
    if(this.sourceId&&now-this.lastPacketAt>(this.adaptive?5000:1200))this.endSource('音源连接中断，正在播完共同缓冲');
    if(this.adaptive&&this.status==='playing'){
      this.adaptive.step(now,this.lastCaptureEnd??now,[...this.clients.values()]);
      this.delayMs=this.adaptive.valueAt(this.lastCaptureEnd??now);
    }
    for(const [id,c]of this.clients) {
      if(now-c.lastSeen>LIVE_LEASE_MS){c.enabled=false;c.ready=false;if(this.controllerId===id)this.controllerId=null;}
      if(now-c.lastSeen>60000&&!c.stream&&id!==this.sourceId)this.clients.delete(id);
    }
    this.maybeStart();
  }
  changed(){this.onState(this.snapshot());}
  snapshot() {
    return {serverTimeMs:this.now(),live:{generation:this.generation,revision:this.revision,status:this.status,kind:this.kind||'system',controllerId:this.controllerId,sourceId:this.sourceId,bufferMode:this.bufferMode,adaptive:this.adaptive?.snapshot(this.lastCaptureEnd??this.now())??null,delayMs:this.delayMs,playFromMs:this.playFromMs,stopAtMs:this.stopAtMs,transitionAtMs:this.transitionAtMs,format:this.format,masterVolume:this.masterVolume,volumeRevision:this.volumeRevision,message:this.message},clients:[...this.clients.values()].map(c=>({id:c.id,name:c.name,autoName:c.autoName||c.name,deviceInfo:c.deviceInfo||{},remoteVolume:c.remoteVolume??100,visibility:c.visibility||'visible',enabled:c.enabled,ready:this.ready(c),reconnecting:!!c.wantsAudio&&!this.ready(c),contextState:c.contextState,uncertaintyMs:Number.isFinite(c.uncertaintyMs)?c.uncertaintyMs:null,driftMs:c.driftMs,error:c.error||'',stream:c.stream,source:c.id===this.sourceId,controller:c.id===this.controllerId}))};
  }
}
