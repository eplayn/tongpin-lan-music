import {LiveRoom} from './live-room.mjs';
import {deviceHint} from './device-info.mjs';

export function createLiveRelay({now,bootId,urls,bufferMode='stable'}) {
  const audio=new Map(),events=new Map();
  const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  const snapshot=()=>({...room.snapshot(),bootId,urls:urls()});
  const broadcast=()=>{const data=`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`;for(const [id,res]of events){if(res.destroyed||res.writableLength>65536){res.destroy();events.delete(id);}else res.write(data);}};
  const room=new LiveRoom({now,bufferMode,onState:broadcast,onAudio:bytes=>{
    for(const [id,res]of audio) {
      // Slow clients disconnect instead of retaining seconds of unbounded audio.
      if(res.destroyed||res.writableLength>512*1024){res.destroy();continue;}
      res.write(bytes);
    }
  }});
  async function read(req,binary=false) {
    const chunks=[];let n=0;const max=binary?70000:4096;
    for await(const b of req){n+=b.length;if(n>max)throw Error('请求过大');chunks.push(b);}
    const bytes=Buffer.concat(chunks);
    if(binary)return bytes;
    const data=JSON.parse(bytes.toString('utf8')||'{}');
    if(!data||typeof data!=='object'||Array.isArray(data))throw Error('请求内容无效');return data;
  }
  const authenticate=req=>room.auth(req.headers['x-live-id'],req.headers['x-live-token']);
  async function handle(req,res,url) {
    const route=url.pathname;
    if(!route.startsWith('/api/live/'))return false;
    try {
      if(route==='/api/live/status'&&req.method==='GET'){json(res,200,snapshot());return true;}
      if(route==='/api/live/hello'&&req.method==='POST'){
        const input=await read(req),hint=await deviceHint(req.socket.remoteAddress);
        const result=room.hello(input,hint);
        // A browser identity owns one live page, never two simultaneous echoes.
        audio.get(result.id)?.destroy();events.get(result.id)?.end();
        json(res,200,{...result,...snapshot()});return true;
      }
      const c=authenticate(req);
      if(route==='/api/live/heartbeat'&&req.method==='POST'){json(res,200,{...room.heartbeat(c,await read(req)),bootId});return true;}
      if(route==='/api/live/profile'&&req.method==='POST'){room.profile(c,await read(req));json(res,200,snapshot());return true;}
      if(route==='/api/live/events'&&req.method==='GET') {
        events.get(c.id)?.end();events.set(c.id,res);
        res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();
        res.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
        res.on('close',()=>{if(events.get(c.id)===res)events.delete(c.id);});return true;
      }
      if(route==='/api/live/audio'&&req.method==='GET') {
        audio.get(c.id)?.destroy();audio.set(c.id,res);
        res.writeHead(200,{'Content-Type':'application/octet-stream','Cache-Control':'no-store, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();
        room.stream(c,true);
        for(const p of room.history)res.write(p.bytes);
        res.on('close',()=>{if(audio.get(c.id)===res){audio.delete(c.id);room.stream(c,false);}});return true;
      }
      if(req.method==='POST'&&route==='/api/live/pcm') {
        try {room.receive(c,await read(req,true));json(res,200,{ok:true});}
        catch(e){if(room.sourceId===c.id)room.endSource(e.message);throw e;}return true;
      }
      if(req.method==='POST'&&route==='/api/live/control') {
        const input=await read(req);
        if(input.action==='claim')room.takeControl(c);
        else if(input.action==='volume')room.volume(c,input);
        else if(input.action==='source')room.beginSource(c,input);
        else if(input.action==='pause'){room.requireControl(c);room.pause();}
        else if(input.action==='resume')room.resume(c);
        else if(input.action==='end'){
          if(c.id!==room.sourceId)room.requireControl(c);room.endSource();
        } else throw Error('操作无效');
        json(res,200,snapshot());return true;
      }
      json(res,404,{error:'未找到实时接口'});return true;
    }catch(e){if(!res.headersSent&&!res.destroyed)json(res,e.status||400,{error:e.message,...(e.code?{code:e.code}:{})});else res.destroy();return true;}
  }
  let last=0;
  const timer=setInterval(()=>{room.tick();if(now()-last>=1000){broadcast();last=now();}},100);timer.unref();
  return {handle,room,close(){clearInterval(timer);for(const res of [...audio.values(),...events.values()])res.destroy();audio.clear();events.clear();}};
}
