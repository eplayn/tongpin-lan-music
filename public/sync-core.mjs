export function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
export function effectiveState(room, nowMs) {
  if (room?.previous && nowMs < room.anchorMs) return room.previous;
  return room;
}
export function positionAt(room, nowMs) {
  const r = effectiveState(room, nowMs);
  if (!r) return 0;
  const p = (Number(r.position) || 0) + (r.status === 'playing' ? Math.max(0, nowMs - r.anchorMs) / 1000 : 0);
  return clamp(p, 0, Number(r.duration) || 86400);
}
const median = a => { const b = [...a].sort((x,y)=>x-y); return b.length % 2 ? b[(b.length-1)/2] : (b[b.length/2-1]+b[b.length/2])/2; };
export class ClockEstimator {
  samples = []; offsetMs = 0; uncertaintyMs = Infinity; rttMs = Infinity;
  add(c0, s1, s2, c3) {
    if (![c0,s1,s2,c3].every(Number.isFinite) || c3<c0 || s2<s1) return false;
    const rtt = Math.max(0, (c3-c0)-(s2-s1));
    if (rtt > 1500) return false;
    this.samples.push({offset:((s1-c0)+(s2-c3))/2,rtt});
    this.samples = this.samples.slice(-30);
    const best = [...this.samples].sort((a,b)=>a.rtt-b.rtt).slice(0,Math.min(6,Math.max(1,Math.ceil(this.samples.length/3))));
    this.offsetMs = median(best.map(s=>s.offset));
    this.rttMs = best[0].rtt;
    this.uncertaintyMs = best[0].rtt/2 + Math.max(...best.map(s=>Math.abs(s.offset-this.offsetMs)));
    return true;
  }
  get ready() { return this.samples.length >= 5 && this.uncertaintyMs <= 25; }
}
export function outputMap(ctx, perfNow) {
  if (typeof ctx.getOutputTimestamp === 'function') {
    const ts = ctx.getOutputTimestamp();
    if (ts.contextTime > 0 && ts.performanceTime > 0 && Math.abs(perfNow-ts.performanceTime)<2000)
      return {...ts, mode:'timestamp'};
  }
  return {contextTime:ctx.currentTime-(Number(ctx.baseLatency)||0)-(Number(ctx.outputLatency)||0), performanceTime:perfNow, mode:'estimated'};
}
export function targetContextTime(serverMs, offsetMs, advanceMs, ctx, perfNow) {
  const map = outputMap(ctx, perfNow);
  return map.contextTime + (serverMs-offsetMs-advanceMs-map.performanceTime)/1000;
}
export function serverAtContextTime(contextTime, offsetMs, advanceMs, ctx, perfNow) {
  const map = outputMap(ctx, perfNow);
  return map.performanceTime+offsetMs+advanceMs+(contextTime-map.contextTime)*1000;
}
export function segmentPosition(segments, contextTime) {
  let segment = segments[0];
  for (const s of segments) { if (s.ctx<=contextTime) segment=s; else break; }
  return segment.position+(contextTime-segment.ctx)*segment.rate;
}
