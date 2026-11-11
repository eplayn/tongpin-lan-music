import test from 'node:test';
import assert from 'node:assert/strict';
import { Room, positionAt, LEASE_MS } from '../lib/room.mjs';

const tracks = [{ id: 'song-a', title: 'A', duration: 100 }, { id: 'song-b', title: 'B', duration: 80 }];
function fixture() {
  let time = 10000;
  const room = new Room({ now: () => time, tracks });
  const send = (id, extra = {}) => room.updateClient({ id, name: id, enabled: true, readyTrackId: room.state.trackId,
    duration: room.state.duration, contextState: 'running', clockUncertaintyMs: 2, ...extra });
  return { room, send, at(value) { time = value; room.tick(); }, now: () => time };
}
test('first track is selected without autoplay; clock readiness is mandatory', () => {
  const f = fixture(); assert.equal(f.room.state.status, 'paused'); assert.equal(f.room.state.trackId, 'song-a');
  f.send('client-a', { clockUncertaintyMs: undefined }); f.room.control('play'); f.at(11200);
  assert.equal(f.room.state.status, 'preparing');
});
test('all enabled devices must buffer; start is future dated and previous stays one level', () => {
  const f = fixture(); f.send('client-a'); f.send('client-b', { readyTrackId: null }); f.room.control('play');
  f.at(11200); assert.equal(f.room.state.status, 'preparing');
  f.send('client-b'); assert.equal(f.room.state.status, 'playing'); assert.equal(f.room.state.anchorMs, 13700);
  assert.equal(f.room.state.previous.status, 'preparing'); assert.equal(f.room.state.previous.previous, null);
  assert.equal(positionAt(f.room.state, 13000), 0); assert.equal(positionAt(f.room.state, 14700), 1);
});
test('pause is scheduled for everyone, not applied immediately', () => {
  const f = fixture(); f.send('client-a'); f.room.control('play'); f.at(11200); f.at(14200);
  f.send('client-a'); f.room.control('pause'); const s = f.room.state;
  assert.equal(s.status, 'paused'); assert.equal(s.anchorMs, 15400);
  assert.ok(Math.abs(positionAt(s, 15000) - 1.3) < 1e-9);
  assert.ok(Math.abs(positionAt(s, 16000) - 1.7) < 1e-9);
});
test('seek returns through readiness barrier and seeks to the same position', () => {
  const f = fixture(); f.send('client-a'); f.room.control('seek', { position: 42 });
  assert.equal(f.room.state.status, 'preparing'); assert.equal(f.room.state.position, 42);
  f.at(11200); assert.equal(f.room.state.anchorMs, 13700); f.at(13700);
  assert.equal(positionAt(f.room.state, f.now()), 42);
});
test('a missing device pauses at its audio lease deadline', () => {
  const f = fixture(); f.send('client-a'); f.send('client-b'); f.room.control('play'); f.at(11200);
  f.at(13000); f.send('client-a'); f.send('client-b');
  f.at(17500); f.send('client-a'); f.at(17800);
  assert.equal(f.room.state.status, 'paused'); assert.equal(f.room.state.anchorMs, 13000 + LEASE_MS);
  assert.match(f.room.state.message, /client-b/);
});
test('expiry during preparation does not silently drop the device and autoplay', () => {
  const f = fixture(); f.send('client-a'); f.send('client-b', { readyTrackId: null }); f.room.control('play');
  f.at(15000); f.send('client-a'); f.at(16000);
  assert.equal(f.room.state.status, 'paused');
  assert.match(f.room.state.message, /准备期间离线/);
  f.at(20000); f.send('client-a'); assert.equal(f.room.state.status, 'paused');
});
test('late join is allowed without pausing, but an already playing device interruption pauses all', () => {
  const f = fixture(); f.send('client-a'); f.room.control('play'); f.at(11200); f.at(14000); f.send('client-a');
  f.send('client-b', { readyTrackId: null, contextState: 'running' }); assert.equal(f.room.state.status, 'playing');
  f.send('client-b'); assert.equal(f.room.state.status, 'playing');
  f.send('client-b', { contextState: 'interrupted' }); assert.equal(f.room.state.status, 'paused');
});
test('explicit leave does not pause the other devices', () => {
  const f = fixture(); f.send('client-a'); f.send('client-b'); f.room.control('play'); f.at(11200);
  f.send('client-b', { enabled: false }); assert.equal(f.room.state.status, 'playing');
});
test('host can exclude a buffering participant; heartbeat cannot undo the exclusion', () => {
  const f = fixture(); f.send('client-a'); f.send('client-b', { readyTrackId: null }); f.room.control('play'); f.at(11200);
  f.room.control('exclude', { clientId: 'client-b' }); assert.equal(f.room.state.status, 'playing');
  f.send('client-b'); assert.equal(f.room.clients.get('client-b').enabled, false);
  f.send('client-b', { enabled: false }); f.send('client-b'); assert.equal(f.room.clients.get('client-b').enabled, true);
});
test('end-of-track advances through a new preparation barrier', () => {
  const f = fixture(); f.send('client-a'); f.room.control('play'); f.at(11200);
  for (let t = 14000; t < 113000; t += 1000) { f.at(t); f.send('client-a'); }
  f.at(113700); assert.equal(f.room.state.trackId, 'song-b'); assert.equal(f.room.state.status, 'preparing');
  f.at(114900); assert.equal(f.room.state.status, 'preparing');
  f.send('client-a'); assert.equal(f.room.state.status, 'playing'); assert.equal(f.room.state.position, 0);
});
test('malformed durations, audio errors, and imprecise clocks do not pass readiness', () => {
  for (const bad of [{ duration: 99.8 }, { duration: NaN }, { duration: null }, { clockUncertaintyMs: null }, { clockUncertaintyMs: '0' }, { clockUncertaintyMs: 35 }, { error: 'decode failed' }, { contextState: 'suspended' }]) {
    const f = fixture(); f.send('client-a', bad); f.room.control('play'); f.at(11200); assert.equal(f.room.state.status, 'preparing');
  }
});
test('large output latency and advance extend preparation, start and pause notice', () => {
  const f = fixture(); const high = { outputLatencyMs: 800, advanceMs: 1800 };
  f.send('client-a', high); f.room.control('play');
  assert.equal(f.room.state.anchorMs, 12950);
  f.at(12950); assert.equal(f.room.state.status, 'playing'); assert.equal(f.room.state.anchorMs, 15900);
  f.send('client-a', high); f.at(14500); f.send('client-a', high); f.at(16000); f.send('client-a', high);
  f.room.control('pause'); assert.equal(f.room.state.anchorMs, 18950);
  assert.equal(f.room.snapshot().clients[0].advanceMs, 1800);
});
test('large compensation announces lost-heartbeat pause early enough but keeps lease deadline', () => {
  const f = fixture(); const high = { outputLatencyMs: 800, advanceMs: 1800 };
  f.send('client-a', high); f.send('client-b'); f.room.control('play'); f.at(12950);
  f.at(13000); f.send('client-a', high); f.send('client-b');
  f.at(15950); f.send('client-b'); assert.equal(f.room.state.status, 'playing');
  f.at(16050); assert.equal(f.room.state.status, 'paused'); assert.equal(f.room.state.anchorMs, 19000);
  assert.equal(f.room.state.anchorMs-f.now(), 2950);
});
test('advance is bounded; negative advance never increases notice', () => {
  const f = fixture(); f.send('client-a', { outputLatencyMs: 800, advanceMs: -9999 });
  assert.equal(f.room.snapshot().clients[0].advanceMs, -1000); assert.equal(f.room.lead(1200), 1200);
  f.send('client-a', { outputLatencyMs: 800, advanceMs: 9999 });
  assert.equal(f.room.snapshot().clients[0].advanceMs, 2000); assert.equal(f.room.lead(1200), 3150);
});
test('devices needing more than 4 seconds cannot pass readiness or stretch room notice beyond safety bound', () => {
  const f = fixture(); f.send('client-a', { outputLatencyMs: 4000, advanceMs: 1000 });
  const c = f.room.snapshot().clients[0]; assert.equal(c.ready, false); assert.match(c.error, /输出延迟/);
  assert.equal(f.room.lead(1200), 4000); f.room.control('play'); f.at(14000);
  assert.equal(f.room.state.status, 'preparing');
});
