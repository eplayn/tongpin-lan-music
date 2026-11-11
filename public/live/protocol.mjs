export const HEADER_BYTES = 32;
export const MAGIC = 0x31504654;
export const TIMED_MAGIC = 0x32504654;
export const TIMED_HEADER_BYTES = 48;
export const MAX_FRAMES = 8192;
export class CaptureClock {
  originMs=null; frames=0; sampleRate=null;
  stamp(frames,sampleRate,observedMs) {
    if(this.sampleRate!==null&&this.sampleRate!==sampleRate)throw Error('采样率改变，请重新共享');
    this.sampleRate=sampleRate;
    const elapsed=this.frames/sampleRate*1000;
    if(this.originMs===null)this.originMs=observedMs;
    else this.originMs+=Math.max(-.04,Math.min(.04,(observedMs-this.originMs-elapsed)*.02));
    const stamp=this.originMs+elapsed;this.frames+=frames;return stamp;
  }
}
export function readPacket(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.byteLength < HEADER_BYTES) throw Error('音频包不完整');
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const magic=v.getUint32(0,true);if(magic!==MAGIC&&magic!==TIMED_MAGIC)throw Error('音频包格式错误');
  const headerBytes=magic===TIMED_MAGIC?TIMED_HEADER_BYTES:HEADER_BYTES;
  if(b.byteLength<headerBytes)throw Error('音频包不完整');
  const p = {generation:v.getUint32(4,true), sequence:v.getUint32(8,true), sampleRate:v.getUint32(12,true), channels:v.getUint32(16,true), frames:v.getUint32(20,true), captureMs:v.getFloat64(24,true)};
  if (![32000,44100,48000,88200,96000].includes(p.sampleRate) || p.channels<1 || p.channels>2 || p.frames<1 || p.frames>MAX_FRAMES || !Number.isFinite(p.captureMs)) throw Error('音频参数无效');
  p.headerBytes=headerBytes;p.byteLength = headerBytes + p.frames*p.channels*4;
  p.durationMs = p.frames/p.sampleRate*1000;
  if(magic===TIMED_MAGIC){p.playoutMs=v.getFloat64(32,true);p.playoutEndMs=v.getFloat64(40,true);if(!Number.isFinite(p.playoutMs)||!Number.isFinite(p.playoutEndMs)||p.playoutEndMs<=p.playoutMs||p.playoutMs<p.captureMs||p.playoutEndMs-p.playoutMs<p.durationMs*.9||p.playoutEndMs-p.playoutMs>p.durationMs*1.1)throw Error('播放时间无效');}
  return p;
}
export function makePacket(p, samples) {
  const bytes = new Uint8Array(HEADER_BYTES+samples.byteLength), v = new DataView(bytes.buffer);
  [MAGIC,p.generation,p.sequence,p.sampleRate,p.channels,p.frames].forEach((n,i)=>v.setUint32(i*4,n,true));
  v.setFloat64(24,p.captureMs,true);
  // The wire format is explicitly little endian, independently of the host.
  for (let i=0;i<samples.length;i++) v.setFloat32(HEADER_BYTES+i*4,samples[i],true);
  return bytes;
}
export function withPlayout(bytes,startMs,endMs){
  const p=readPacket(bytes),out=new Uint8Array(TIMED_HEADER_BYTES+p.frames*p.channels*4),v=new DataView(out.buffer);
  out.set(bytes.subarray(0,HEADER_BYTES));v.setUint32(0,TIMED_MAGIC,true);v.setFloat64(32,startMs,true);v.setFloat64(40,endMs,true);out.set(bytes.subarray(p.headerBytes),TIMED_HEADER_BYTES);return out;
}
export class PacketReader {
  pending = new Uint8Array();
  push(part) {
    if (this.pending.length+part.length > 6*1024*1024) throw Error('音频接收缓冲超限');
    const bytes = new Uint8Array(this.pending.length+part.length);
    bytes.set(this.pending);bytes.set(part,this.pending.length);
    const packets=[]; let at=0;
    while (bytes.length-at>=HEADER_BYTES) {
      const magic=new DataView(bytes.buffer,bytes.byteOffset+at,4).getUint32(0,true);if(magic===TIMED_MAGIC&&bytes.length-at<TIMED_HEADER_BYTES)break;
      const p=readPacket(bytes.subarray(at));
      if (bytes.length-at<p.byteLength) break;
      packets.push({ ...p, bytes:bytes.slice(at,at+p.byteLength) }); at+=p.byteLength;
    }
    this.pending=bytes.slice(at);return packets;
  }
}
