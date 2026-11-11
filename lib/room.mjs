export const LEASE_MS = 6000;
export const TRANSITION_MS = 1200;
export const START_LEAD_MS = 2500;

const finite = (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, finite(v)));
export function effectiveState(room, at) {
  return room.previous && at < room.anchorMs ? room.previous : room;
}
export function positionAt(room, at) {
  const state = effectiveState(room, at);
  return clamp(state.position + (state.status === 'playing' ? Math.max(0, at - state.anchorMs) / 1000 : 0), 0, state.duration || Infinity);
}
function flatState(room, at) {
  const s = effectiveState(room, at);
  return { ...s, previous: null };
}

export class Room {
  constructor({ now = () => Date.now(), tracks = [], onChange = () => {} } = {}) {
    this.now = now; this.tracks = tracks; this.onChange = onChange;
    this.clients = new Map(); this.protectedClients = new Set(); this.barrierClients = new Set();
    const first = tracks[0];
    this.state = { revision: 0, trackId: first?.id || null, status: first ? 'paused' : 'idle', position: 0,
      anchorMs: now(), previous: null, duration: first?.duration || 0, message: '等待加入共听' };
  }
  track(id) { return this.tracks.find(t => t.id === id); }
  active(at = this.now()) { return [...this.clients.values()].filter(c => c.enabled && !c.excluded && at - c.lastSeenMs < LEASE_MS); }
  requiredLead(c) { return c.outputLatencyMs + Math.max(c.advanceMs || 0, 0) + 350; }
  lead(minimum) { return Math.max(minimum, ...this.active().map(c => Math.min(4000, this.requiredLead(c)))); }
  ready(c) { return c.readyTrackId === this.state.trackId && !c.error && c.contextState === 'running' && c.clockUncertaintyMs <= 25 && Number.isFinite(c.duration) && Math.abs(c.duration - this.state.duration) <= 0.05 && this.requiredLead(c) <= 4000; }
  emit() { this.onChange(); }
  setTracks(tracks) {
    this.tracks = tracks;
    if (!this.state.trackId && tracks.length) this.state = { ...this.state, revision: this.state.revision + 1, trackId: tracks[0].id, duration: tracks[0].duration, status: 'paused', message: '音乐已就绪，等待加入' };
    this.emit();
  }
  snapshot() {
    const now = this.now();
    return { room: structuredClone(this.state), tracks: this.tracks.map(t => ({ ...t })), clients: [...this.clients.values()].map(c => ({
      id: c.id, name: c.name, enabled: c.enabled, excluded: c.excluded, online: now - c.lastSeenMs < LEASE_MS,
      ready: this.ready(c), readyTrackId: c.readyTrackId, contextState: c.contextState,
      error: c.error, clockUncertaintyMs: c.clockUncertaintyMs, driftMs: c.driftMs,
      outputLatencyMs: c.outputLatencyMs, advanceMs: c.advanceMs,
      lastSeenMs: c.lastSeenMs, leaseUntilMs: c.lastSeenMs + LEASE_MS
    })) };
  }
  updateClient(input) {
    if (typeof input.id !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(input.id)) throw new Error('设备标识无效');
    const prior = this.clients.get(input.id);
    if (!prior && this.clients.size >= 32) throw new Error('房间最多保留 32 台设备，请先移除离线设备');
    let excluded = prior?.excluded || false;
    if (input.enabled === false) excluded = false;
    const c = {
      id: input.id, name: String(input.name || prior?.name || '听众').slice(0, 40),
      enabled: input.enabled === true && !excluded, excluded,
      readyTrackId: typeof input.readyTrackId === 'string' ? input.readyTrackId.slice(0, 80) : null,
      duration: typeof input.duration === 'number' && Number.isFinite(input.duration) ? input.duration : NaN,
      error: String(input.error || '').slice(0, 180),
      contextState: String(input.contextState || 'suspended').slice(0, 30),
      clockUncertaintyMs: clamp(input.clockUncertaintyMs ?? Infinity, 0, 1e9),
      driftMs: Number.isFinite(input.driftMs) ? input.driftMs : null,
      outputLatencyMs: clamp(input.outputLatencyMs, 0, 10000), advanceMs: clamp(input.advanceMs, -1000, 2000), lastSeenMs: this.now()
    };
    // Missing uncertainty is never considered clock-ready.
    if (typeof input.clockUncertaintyMs !== 'number' || !Number.isFinite(input.clockUncertaintyMs)) c.clockUncertaintyMs = 1e9;
    if (this.requiredLead(c) > 4000 && !c.error) c.error = '设备输出延迟与提前补偿合计过大，请降低补偿或更换音频输出';
    this.clients.set(c.id, c);
    if (!c.enabled) { this.protectedClients.delete(c.id); this.barrierClients.delete(c.id); }
    else if (this.state.status === 'preparing') this.barrierClients.add(c.id);
    if (this.state.status === 'playing' && c.enabled && this.protectedClients.has(c.id)) {
      if (c.contextState !== 'running' || c.error) this.pause(`${c.name} 的音频中断，统一暂停`);
      else if (c.readyTrackId !== this.state.trackId || c.clockUncertaintyMs > 80) this.pause(`${c.name} 的同步状态异常，统一暂停`);
    }
    if (this.state.status === 'playing' && c.enabled && this.ready(c)) this.protectedClients.add(c.id);
    this.tick(); this.emit();
    return { leaseUntilMs: c.lastSeenMs + LEASE_MS };
  }
  prepare(trackId, position = 0, message = '等待全部已加入设备缓冲完成') {
    const track = this.track(trackId);
    if (!track) throw new Error('音乐不存在');
    const now = this.now();
    const previous = flatState(this.state, now);
    this.state = { revision: this.state.revision + 1, trackId, status: 'preparing', position: clamp(position, 0, Math.max(0, track.duration - 0.02)),
      anchorMs: now + this.lead(TRANSITION_MS), previous, duration: track.duration, message };
    this.protectedClients.clear(); this.barrierClients = new Set(this.active(now).map(c => c.id)); this.emit();
  }
  pause(message = '主持人已暂停', at = this.now() + this.lead(TRANSITION_MS)) {
    const now = this.now();
    if (this.state.status === 'paused' && now < this.state.anchorMs) return;
    const previous = flatState(this.state, now);
    this.state = { revision: this.state.revision + 1, trackId: this.state.trackId, status: 'paused',
      position: this.state.status === 'preparing' ? this.state.position : positionAt(this.state, at),
      anchorMs: Math.max(now + 30, at), previous, duration: this.state.duration, message };
    this.protectedClients.clear(); this.barrierClients.clear(); this.emit();
  }
  control(action, data = {}) {
    switch (action) {
      case 'select': case 'play': this.prepare(data.trackId || this.state.trackId || this.tracks[0]?.id, data.position ?? (data.trackId && data.trackId !== this.state.trackId ? 0 : positionAt(this.state, this.now()))); break;
      case 'pause': this.pause(); break;
      case 'seek': this.prepare(this.state.trackId, data.position); break;
      case 'next': {
        if (!this.tracks.length) throw new Error('请先添加音乐');
        const index = this.tracks.findIndex(t => t.id === this.state.trackId);
        this.prepare(this.tracks[(index + 1) % this.tracks.length].id, 0); break;
      }
      case 'exclude': {
        const c = this.clients.get(data.clientId);
        if (c) { c.enabled = false; c.excluded = true; this.protectedClients.delete(c.id); this.barrierClients.delete(c.id); this.tick(); this.emit(); }
        break;
      }
      default: throw new Error('未知房间操作');
    }
  }
  tick() {
    const now = this.now();
    if (this.state.status === 'playing') {
      for (const id of this.protectedClients) {
        const c = this.clients.get(id);
        if (c?.enabled && now >= c.lastSeenMs + LEASE_MS - this.lead(TRANSITION_MS)) {
          this.pause(`${c.name} 心跳中断，统一暂停`, c.lastSeenMs + LEASE_MS); break;
        }
      }
      if (this.state.status === 'playing' && now >= this.state.anchorMs && positionAt(this.state, now) >= this.state.duration) {
        this.control('next');
      }
    }
    if (this.state.status === 'preparing' && now >= this.state.anchorMs) {
      for (const id of this.barrierClients) {
        const c = this.clients.get(id);
        if (c?.enabled && now - c.lastSeenMs >= LEASE_MS) {
          this.pause(`${c.name} 在准备期间离线，请确认设备后重新播放`); break;
        }
      }
    }
    if (this.state.status === 'preparing' && now >= this.state.anchorMs) {
      const participants = this.active(now);
      if (participants.length && participants.every(c => this.ready(c))) {
        const previous = { ...this.state, previous: null };
        this.state = { ...this.state, revision: this.state.revision + 1, status: 'playing',
          anchorMs: now + this.lead(START_LEAD_MS), previous, message: '全体就绪，按统一时间起播' };
        this.protectedClients = new Set(participants.map(c => c.id)); this.emit();
      }
    }
    for (const [id, c] of this.clients) if (!this.protectedClients.has(id) && now - c.lastSeenMs > 300000) this.clients.delete(id);
  }
}
