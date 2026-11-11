import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Room, LEASE_MS } from './lib/room.mjs';
import { createLiveRelay } from './lib/live-http.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, 'data');
const MAX_INPUT = 64 * 1024 ** 2;
const MAX_DURATION = 720;
const FF = process.env.MUSIC_FFMPEG || 'ffmpeg';
const PROBE = path.join(path.dirname(FF), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
const EXTENSIONS = new Set(['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.aiff', '.webm']);
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
function command(exe, args, timeout = 45000) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('音频准备超时，请检查文件')); }, timeout);
    child.stdout.on('data', b => { if (output.length < 1048576) output += b; });
    child.stderr.on('data', b => { if (error.length < 8192) error += b; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(error.trim() || `音频工具退出：${code}`)); });
  });
}
async function probe(filename) {
  const data = JSON.parse(await command(PROBE, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,sample_rate,channels', '-of', 'json', filename], 15000));
  const duration = Number(data.format?.duration);
  if (!data.streams?.some(s => s.codec_type === 'audio') || !Number.isFinite(duration) || duration <= 0 || duration > MAX_DURATION) throw new HttpError(400, '音频必须包含可读取音轨，且时长不超过 12 分钟');
  return duration;
}
async function loadLibrary() {
  await fsp.mkdir(DATA, { recursive: true });
  let list = [];
  try { list = JSON.parse(await fsp.readFile(path.join(DATA, 'library.json'), 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw new Error('音乐库索引损坏，请保留原文件并检查 data/library.json'); }
  if (!Array.isArray(list)) throw new Error('音乐库格式错误');
  const good = [];
  for (const t of list) if (/^[a-f0-9]{24}$/.test(t.id) && t.fileName === `${t.id}.wav` && Number.isFinite(t.duration)) {
    try { await fsp.access(path.join(DATA, t.fileName)); good.push(t); } catch { /* missing data is not served */ }
  }
  return good;
}
async function importFile(source, library, givenName = '') {
  const info = await fsp.stat(source);
  if (!info.isFile() || info.size > MAX_INPUT || info.size <= 0) throw new HttpError(400, '音乐文件大小须在 0 到 64 MiB 之间');
  const name = givenName || path.basename(source);
  if (!EXTENSIONS.has(path.extname(name).toLowerCase())) throw new HttpError(400, '暂不支持这种音频格式');
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(source)) hash.update(chunk);
  const id = hash.digest('hex').slice(0, 24);
  const existing = library.find(t => t.id === id);
  if (existing) return existing;
  await probe(source);
  const temporary = path.join(DATA, `${id}-${crypto.randomBytes(4).toString('hex')}.tmp.wav`);
  const destination = path.join(DATA, `${id}.wav`);
  try {
    await command(FF, ['-nostdin', '-v', 'error', '-threads', '1', '-i', source, '-map', '0:a:0', '-vn', '-t', '720.01', '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', '-bitexact', '-y', temporary]);
    const duration = await probe(temporary);
    await fsp.rename(temporary, destination);
    const sizeBytes = (await fsp.stat(destination)).size;
    const t = { id, title: name.replace(/\.[^.]+$/, '').slice(0, 200), originalName: name.slice(0, 220), duration,
      sampleRate: 44100, channels: 2, fileName: `${id}.wav`, sizeBytes, createdAt: new Date().toISOString() };
    library.push(t);
    const indexTmp = path.join(DATA, 'library.next.json');
    await fsp.writeFile(indexTmp, JSON.stringify(library, null, 2));
    await fsp.rename(indexTmp, path.join(DATA, 'library.json'));
    console.log(`Imported: ${t.title} (${duration.toFixed(2)}s, ${(sizeBytes / 1048576).toFixed(1)} MiB PCM)`);
    return t;
  } finally { await fsp.unlink(temporary).catch(() => {}); }
}
function localAddresses() {
  return ['127.0.0.1', '::1', ...Object.values(os.networkInterfaces()).flat().filter(Boolean).filter(x => !x.internal).map(x => x.address)];
}
function normalizeIp(ip = '') { return ip.replace(/^::ffff:/, '').replace(/^\[|\]$/g, ''); }
function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); }
async function body(req, limit = 8192) {
  let size = 0; const pieces = [];
  for await (const p of req) { size += p.length; if (size > limit) throw new HttpError(413, '请求太大'); pieces.push(p); }
  try { return JSON.parse(Buffer.concat(pieces).toString('utf8') || '{}'); } catch { throw new HttpError(400, '请求内容不是 JSON'); }
}
async function sendFile(req, res, file, type, cache = false) {
  const st = await fsp.stat(file);
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': cache ? 'private, max-age=86400, immutable' : 'no-cache' };
  let start = 0, end = st.size - 1, status = 200;
  if (req.headers.range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!m || (!m[1] && !m[2])) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); res.end(); return; }
    if (!m[1]) { start = Math.max(0, st.size - Number(m[2])); } else { start = Number(m[1]); if (m[2]) end = Math.min(end, Number(m[2])); }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); res.end(); return; }
    status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  }
  headers['Content-Length'] = end - start + 1; res.writeHead(status, headers);
  if (req.method === 'HEAD') { res.end(); return; }
  await pipeline(fs.createReadStream(file, { start, end }), res);
}

export async function createMusicServer({ host = '0.0.0.0', port = 8877, imports = [], tlsPort = null, tlsPfx = null, bufferMode = 'stable' } = {}) {
  const library = await loadLibrary();
  for (const source of imports) await importFile(path.resolve(source), library);
  const bootId = crypto.randomUUID(), token = crypto.randomBytes(32).toString('hex');
  const epoch = Date.now(), monotonic = performance.now();
  const now = () => epoch + performance.now() - monotonic;
  let tlsServer=null;
  const live=createLiveRelay({now,bootId,bufferMode,urls:()=>({http:localAddresses().filter(x=>/^\d+\./.test(x)).map(ip=>`http://${ip}:${server.address()?.port}/live/`),https:tlsServer?.listening?localAddresses().filter(x=>/^\d+\./.test(x)).map(ip=>`https://${ip}:${tlsServer.address().port}/live/`):[]})});
  const streams = new Map(); let lastSse = 0, importBusy = false;
  const room = new Room({ now, tracks: library, onChange: () => broadcast() });
  const snapshot = () => ({ ...room.snapshot(), serverTimeMs: now(), bootId });
  function broadcast() {
    if (!streams.size) return;
    const message = `event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`;
    for (const [id, res] of streams) { if (res.writableLength > 262144 || res.destroyed) { res.destroy(); streams.delete(id); } else res.write(message); }
    lastSse = now();
  }
  function checkHost(req) {
    let hostname;
    try { hostname = normalizeIp(new URL(`http://${req.headers.host}`).hostname); } catch { throw new HttpError(400, 'Host 无效'); }
    if (hostname !== 'localhost' && !localAddresses().map(normalizeIp).includes(hostname)) throw new HttpError(403, '只接受本机及局域网服务器地址');
    if (req.method === 'POST' && req.headers.origin) {
      let origin; try { origin = new URL(req.headers.origin); } catch { throw new HttpError(403, '来源无效'); }
      if (origin.host !== req.headers.host || origin.protocol !== (req.socket.encrypted?'https:':'http:')) throw new HttpError(403, '拒绝跨站操作');
    }
  }
  const isLocal = req => localAddresses().map(normalizeIp).includes(normalizeIp(req.socket.remoteAddress));
  function control(req) {
    const value = req.headers['x-control-token'];
    if (!isLocal(req) || typeof value !== 'string' || value.length !== token.length || !crypto.timingSafeEqual(Buffer.from(value), Buffer.from(token))) throw new HttpError(403, '只有服务器本机可以管理播放和音乐库');
  }
  const handler = async (req, res) => {
    const received = now();
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; media-src 'self' blob:; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'");
    try {
      checkHost(req);
      const url = new URL(req.url, `http://${req.headers.host}`), route = url.pathname;
      if (route === '/') {res.writeHead(302,{Location:'/live/'});res.end();return;}
      if (route === '/api/upload' || route === '/api/import') throw new HttpError(400,'便携版仅提供实时系统音源共享，不提供旧版文件转码');
      if(await live.handle(req,res,url))return;
      if (route === '/api/clock' && req.method === 'GET') return json(res, 200, { receiveMs: received, sendMs: now(), bootId });
      if (route === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true, realtime: true, version: '3.2.3', bootId, tracks: library.length, memoryMiB: Math.round(process.memoryUsage().rss / 1048576), uptimeSeconds: Math.floor(process.uptime()) });
      if (route === '/api/session' && req.method === 'GET') return json(res, 200, { ...snapshot(), canControl: isLocal(req), ...(isLocal(req) ? { controlToken: token } : {}), urls: localAddresses().filter(x => /^\d+\./.test(x)).map(ip => `http://${ip}:${server.address().port}/`) });
      if (route === '/events' && req.method === 'GET') {
        const id = url.searchParams.get('id');
        if (!id || !/^[a-zA-Z0-9_-]{8,80}$/.test(id)) throw new HttpError(400, '设备标识无效');
        if (!streams.has(id) && streams.size >= 64) throw new HttpError(429, '连接数已满');
        streams.get(id)?.end(); streams.set(id, res);
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write(`retry: 1000\nevent: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
        res.on('close', () => { if (streams.get(id) === res) streams.delete(id); }); return;
      }
      if (route === '/api/client' && req.method === 'POST') {
        const lease = room.updateClient(await body(req)); return json(res, 200, { ...snapshot(), ...lease });
      }
      if (route === '/api/control' && req.method === 'POST') {
        control(req); const input = await body(req); room.control(input.action, input); return json(res, 200, snapshot());
      }
      if ((route === '/api/import' || route === '/api/upload') && req.method === 'POST') {
        control(req); if (importBusy) throw new HttpError(409, '已有音乐正在准备，请稍后再试'); importBusy = true;
        let upload;
        try {
          let source, name;
          if (route === '/api/import') { const input = await body(req); if (typeof input.path !== 'string' || !path.isAbsolute(input.path)) throw new HttpError(400, '请提供完整本机路径'); source = input.path; }
          else {
            name = path.basename(url.searchParams.get('name') || '');
            const ext = path.extname(name).toLowerCase();
            if (!EXTENSIONS.has(ext)) throw new HttpError(400, '不支持此格式');
            if (Number(req.headers['content-length']) > MAX_INPUT) throw new HttpError(413, '上传上限为 64 MiB');
            upload = path.join(DATA, `incoming-${crypto.randomBytes(12).toString('hex')}${ext}`); source = upload;
            let count = 0;
            const limit = new Transform({ transform(chunk, enc, cb) { count += chunk.length; cb(count > MAX_INPUT ? new HttpError(413, '上传上限为 64 MiB') : null, chunk); } });
            await pipeline(req, limit, fs.createWriteStream(upload, { flags: 'wx' }));
          }
          const track = await importFile(source, library, name); room.setTracks(library); return json(res, 200, { track, ...snapshot() });
        } finally { importBusy = false; if (upload) await fsp.unlink(upload).catch(() => {}); }
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && /^\/media\/[a-f0-9]{24}\.wav$/.test(route)) {
        const id = route.slice('/media/'.length, -4), t = library.find(x => x.id === id);
        if (!t) throw new HttpError(404, '音乐不存在');
        return await sendFile(req, res, path.join(DATA, t.fileName), 'audio/wav', true);
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        if(route==='/live/server.cer'){
          res.setHeader('Content-Disposition','attachment; filename="Tongpin-LAN.cer"');
          return await sendFile(req,res,path.join(ROOT,'Tongpin-LAN.cer'),'application/pkix-cert');
        }
        if(route==='/live'){res.writeHead(302,{Location:'/live/'});res.end();return;}
        if(route==='/live/'||/^\/live\/(index\.html|live\.css|app\.mjs|device\.mjs|playback-metrics\.mjs|pulse-worker\.mjs|protocol\.mjs|capture-worklet\.mjs)$/.test(route)) {
          const name=route==='/live/'?'index.html':route.slice('/live/'.length);
          return await sendFile(req,res,path.join(ROOT,'public','live',name),TYPES[path.extname(name)]||'application/octet-stream');
        }
        const filename = route === '/' ? 'index.html' : route.slice(1);
        if (['index.html', 'style.css', 'app.mjs', 'sync-core.mjs', 'favicon.svg'].includes(filename)) return await sendFile(req, res, path.join(ROOT, 'public', filename), TYPES[path.extname(filename)] || 'application/octet-stream');
      }
      throw new HttpError(404, '未找到页面');
    } catch (e) {
      if (res.headersSent || res.destroyed) { res.destroy(); return; }
      const status = e.status || (e.code === 'ENOENT' ? 404 : 400);
      json(res, status, { error: e.message || '请求失败' });
    }
  };
  const server = http.createServer(handler);
  server.requestTimeout = 120000; server.headersTimeout = 15000; server.keepAliveTimeout = 5000;
  const timer = setInterval(() => { room.tick(); if (now() - lastSse >= 2000) broadcast(); }, 100);
  timer.unref();
  server.on('close', () => { clearInterval(timer);live.close(); for (const res of streams.values()) res.end(); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  if(tlsPort!==null&&tlsPfx){
    tlsServer=https.createServer({pfx:await fsp.readFile(tlsPfx)},handler);
    tlsServer.requestTimeout=120000;tlsServer.headersTimeout=15000;
    try {await new Promise((resolve,reject)=>{tlsServer.once('error',reject);tlsServer.listen(tlsPort,host,resolve);});}
    catch(e){live.close();server.close();throw e;}
  }
  return { server, tlsServer, room, live:live.room, now, bootId, close: async () => {live.close();for(const res of streams.values())res.end();await Promise.all([server,tlsServer].filter(Boolean).map(s=>new Promise(resolve=>{s.close(resolve);s.closeAllConnections();})));} };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2); let port = 8877, host = '0.0.0.0'; const imports = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port') port = Number(args[++i]);
    else if (args[i] === '--host') host = args[++i];
    else if (args[i] === '--import') imports.push(args[++i]);
    else throw new Error(`Unknown argument: ${args[i]}`);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be 1..65535');
  const tlsPfx=path.join(DATA,'https.pfx');
  const bufferFile=path.join(DATA,'live-buffer.json');
  const bufferMode=fs.existsSync(bufferFile)?JSON.parse(fs.readFileSync(bufferFile,'utf8').replace(/^\uFEFF/,'')).mode:'adaptive';
  if(!['stable','minimum','100ms','adaptive'].includes(bufferMode))throw Error('Invalid live buffer mode');
  const app = await createMusicServer({ host, port, imports, bufferMode, ...(fs.existsSync(tlsPfx)?{tlsPfx,tlsPort:port+1}:{}) });
  console.log('Live buffer mode: '+bufferMode);
  console.log(`Shared music server: http://127.0.0.1:${app.server.address().port}/`);
  console.log(`Live sharing: http://127.0.0.1:${app.server.address().port}/live/`);
  if(app.tlsServer)console.log(`HTTPS live sharing: https://127.0.0.1:${app.tlsServer.address().port}/live/`);
  console.log('LAN: ' + localAddresses().filter(x => /^\d+\./.test(x) && x !== '127.0.0.1').map(ip => `http://${ip}:${app.server.address().port}/`).join(' '));
  const stop = () => app.close().then(() => process.exit(0)); process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
