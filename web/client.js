'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const clamp = (x,a,b) => Math.max(a,Math.min(b,x));
  let ctx, gain, ws, wanted=false, generation=0, reconnect=200, retryTimer;
  let queue=[], sources=new Set(), lastEnd=0, lastSequence=null;
  let clocks=[], offset=0, clockReady=false, rtt=0, uncertainty=0;
  let late=0, dropped=0, arrivalAge=0, jitter=0, previousAge=0, output=0, calibration=0;
  let hello=false, synthetic=false, status={}, stateText='尚未开始', clockTimer, reportTimer;
  let requiredSamples=[], observed=0, lastReportLate=0, healthySince=0;
  let hostMonitor=false;
  async function readHostStatus() {
    const response=await fetch('/status',{cache:'no-store'});
    if(!response.ok)throw new Error('无法读取主机状态，请检查 Windows 程序是否正在运行。');
    const m=await response.json();
    if(m.localHost&&!m.test){
      hostMonitor=true;status=m;$('start').hidden=true;
      state(m.capturing&&m.rendering?'本机由 Windows 程序同步播放':'主机音频正在恢复…',!!(m.capturing&&m.rendering));
      $('latency').textContent=Math.round(m.latency);$('rtt').textContent='本机';
      $('listeners').textContent=m.listeners;
      $('level').style.width=`${clamp(m.peak*300,0,100)}%`;
      $('diagnostics').textContent=`本机输出补偿 ${(m.hostCalibrationMs||0).toFixed(1)} ms；${m.hostCalibrated?'已取得可辨识声音的回环校准结果':'等待可辨识声音完成回环校准'}。本页仅监测，避免声音回到 CABLE 形成回声；其他设备可正常点击开始收听。回环时序不等同于实测声学误差。`;
    }
    return m;
  }
  const roleReady=readHostStatus().catch(e=>{$('error').textContent=e.message;});
  setInterval(()=>{if(hostMonitor)readHostStatus().catch(()=>state('等待主机服务恢复…'));},1000);
  function state(text,good=false) {stateText=text;$('state').textContent=text;$('dot').style.background=good?'#c2efb0':'#d2bd86';}
  function clearAudio() {
    queue=[]; lastEnd=0; lastSequence=null;
    for(const s of sources) {try{s.stop();}catch{} s.disconnect();} sources.clear();
  }
  function send(m) {if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify(m));}
  function outputDelay() {return ((ctx?.baseLatency||0)+(ctx?.outputLatency||0))*1000;}
  function audioAt(localTime) {
    const ts=ctx.getOutputTimestamp?.();
    if(ts && ts.performanceTime>0 && ts.contextTime>0 && Math.abs(ts.performanceTime-performance.now())<2000)
      return ts.contextTime+(localTime-ts.performanceTime)/1000;
    return ctx.currentTime+(localTime-performance.now()-outputDelay())/1000;
  }
  function clock(m) {
    const now=performance.now(), delay=(now-m.t0)-(m.t2-m.t1);
    if(!Number.isFinite(delay)||delay<0||delay>2000||m.t2<m.t1)return;
    const value=((m.t1-m.t0)+(m.t2-now))/2;
    clocks.push({at:now,rtt:delay,offset:value});clocks=clocks.filter(x=>now-x.at<30000).slice(-48);
    const best=clocks.slice().sort((a,b)=>a.rtt-b.rtt).slice(0,5);
    const values=best.map(x=>x.offset).sort((a,b)=>a-b);
    const estimate=values[Math.floor(values.length/2)];
    rtt=best[0].rtt;uncertainty=rtt/2+Math.max(...values)-Math.min(...values);
    if(!clockReady)offset=estimate;
    else if(Math.abs(estimate-offset)>40){clearAudio();offset=estimate;healthySince=now;}
    else offset+=clamp(estimate-offset,-.25,.25);
    clockReady=clocks.length>=6;
    $('rtt').textContent=rtt.toFixed(1);
  }
  function packet(data) {
    if(!(data instanceof ArrayBuffer)||data.byteLength<40)return;
    const v=new DataView(data);
    if(v.getUint32(0,true)!==0x3141534c||v.getUint32(32,true)!==48000||v.getUint8(38)!==2||v.getUint8(39)!==1)return;
    const frames=v.getUint16(36,true),seq=v.getUint32(4,true);
    if(!frames||frames>480||data.byteLength!==40+frames*4)return;
    const captured=v.getFloat64(8,true),play=v.getFloat64(16,true),duration=v.getFloat64(24,true);
    if(!Number.isFinite(captured)||!Number.isFinite(play)||!Number.isFinite(duration)||Math.abs(duration-frames/48)>1e-6)return;
    if(!clockReady||ctx?.state!=='running')return;
    const age=performance.now()+offset-captured;
    if(age< -100||age>5000)return;
    if(observed){jitter=jitter*.97+Math.abs(age-previousAge)*.03;}
    previousAge=age;arrivalAge=age;observed++;
    output=outputDelay();requiredSamples.push({t:performance.now(),v:Math.max(0,age)+output+35});
    requiredSamples=requiredSamples.filter(x=>performance.now()-x.t<12000).slice(-1200);
    if(queue.length>=700){clearAudio();dropped++;healthySince=performance.now();}
    queue.push({seq,captured,play,duration,frames,v});pump();
  }
  function pump() {
    if(!ctx||ctx.state!=='running'||!clockReady)return;
    let budget=64;
    while(queue.length&&budget-->0) {
      const p=queue[0],desired=audioAt(p.play-offset+calibration);
      if(desired-ctx.currentTime>.22)break;
      queue.shift();
      if(desired<ctx.currentTime+.012){late++;lastEnd=0;continue;}
      if(lastSequence!==null&&p.seq!==((lastSequence+1)>>>0)){lastEnd=0;dropped++;}
      lastSequence=p.seq;
      let at=desired;const span=p.frames/48000;
      const error=lastEnd?desired-lastEnd:0;
      /* Keep consecutive samples at their original rate. A larger clock error
         creates a gap or drops a late packet instead of changing playbackRate. */
      if(lastEnd&&Math.abs(error)<.002)at=lastEnd;
      else if(lastEnd&&at<lastEnd){late++;continue;}
      if(at<ctx.currentTime+.006){late++;lastEnd=0;continue;}
      const buffer=ctx.createBuffer(2,p.frames,48000);
      for(let c=0;c<2;c++){const dst=buffer.getChannelData(c);for(let i=0;i<p.frames;i++)dst[i]=p.v.getInt16(40+(i*2+c)*2,true)/32768;}
      const s=ctx.createBufferSource();s.buffer=buffer;s.playbackRate.value=1;
      s.connect(gain);sources.add(s);s.onended=()=>{sources.delete(s);s.disconnect();};
      s.start(at);lastEnd=at+span;
      state(synthetic?'测试音正在同步播放':'正在同步收听',true);
    }
  }
  function report() {
    const now=performance.now();
    const sorted=requiredSamples.map(x=>x.v).sort((a,b)=>a-b);
    const required=sorted.length?sorted[Math.floor((sorted.length-1)*.99)]:600;
    const newLate=late-lastReportLate;lastReportLate=late;
    const ready=!document.hidden&&clockReady&&ctx?.state==='running'&&observed>50&&now-healthySince>3000;
    send({type:'report',ready:ready?1:0,required:required+(newLate?Math.min(300,newLate*4):0),rtt,jitter,output,late});
    $('diagnostics').textContent=`固定缓冲，始终原速。${required>status.latency?'当前固定值可能不足，请在主机手动增大；程序不会自动调整。':''}时钟估计不确定度 ±${uncertainty.toFixed(1)} ms；输出缓冲估计 ${output.toFixed(1)} ms；数据到达 ${arrivalAge.toFixed(1)} ms；迟到 ${late} 包；丢失/重同步 ${dropped} 次。${ctx?.getOutputTimestamp?'使用输出时钟映射。':'浏览器未提供输出时钟，使用延迟估计。'}这些数值不等同于实测声学误差。`;
  }
  function connect() {
    if(!wanted)return;
    const mine=++generation;hello=false;clockReady=false;clocks=[];observed=0;requiredSamples=[];healthySince=performance.now();clearAudio();
    state('连接主机…');
    ws=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/audio`);ws.binaryType='arraybuffer';
    ws.onopen=()=>{
      if(mine!==generation)return;
      reconnect=200;state('正在校准统一时钟…');
      for(let i=0;i<10;i++)setTimeout(()=>{if(mine===generation)send({type:'sync',t0:performance.now()});},i*90);
      clearInterval(clockTimer);clearInterval(reportTimer);
      clockTimer=setInterval(()=>send({type:'sync',t0:performance.now()}),1000);
      reportTimer=setInterval(report,1000);
    };
    ws.onmessage=e=>{
      if(mine!==generation)return;
      if(typeof e.data!=='string'){packet(e.data);return;}
      let m;try{m=JSON.parse(e.data);}catch{return;}
      if(m.type==='hello'){hello=true;synthetic=m.test;}
      if(m.type==='reset'){
        clearAudio();healthySince=performance.now();requiredSamples=[];
        status.latency=m.latency;$('latency').textContent=m.latency;
        state('固定缓冲已更新，正在重新缓冲…');
      }
      if(m.type==='sync')clock(m);
      if(m.type==='status'){
        status=m;$('latency').textContent=Math.round(m.latency);$('listeners').textContent=m.listeners;
        $('level').style.width=`${clamp(m.peak*300,0,100)}%`;
        if(!m.capturing)state('主机采集正在恢复…');
        else if(clockReady&&!queue.length&&!sources.size)state('已同步，等待主机声音…',true);
      }
    };
    ws.onerror=()=>{};
    ws.onclose=()=>{
      if(mine!==generation)return;
      clearAudio();clockReady=false;clearInterval(clockTimer);clearInterval(reportTimer);
      state('连接断开，正在自动重连…');
      if(wanted){clearTimeout(retryTimer);retryTimer=setTimeout(connect,reconnect+Math.random()*150);reconnect=Math.min(5000,reconnect*1.7);}
    };
  }
  async function start() {
    $('error').textContent='';$('start').disabled=true;
    try {
      await roleReady;if(hostMonitor)return;
      if(!ctx){
        const Constructor=window.AudioContext||window.webkitAudioContext;
        if(!Constructor)throw new Error('此浏览器不支持 Web Audio，请使用新版 Chrome、Edge、Firefox 或 Safari。');
        ctx=new Constructor({latencyHint:'interactive',sampleRate:48000});gain=ctx.createGain();gain.gain.value=.8;gain.connect(ctx.destination);
        ctx.onstatechange=()=>{
          if(ctx.state!=='running'){clearAudio();send({type:'report',ready:0});state('播放被系统暂停，请点继续收听');$('start').textContent='继续收听';$('start').hidden=false;}
        };
      }
      await ctx.resume();if(ctx.state!=='running')throw new Error('浏览器尚未允许音频播放，请再次点击。');
      wanted=true;$('start').hidden=true;if(!ws||ws.readyState>1)connect();else{clearAudio();healthySince=performance.now();}
    }catch(e){$('error').textContent=e.message;state('暂时无法播放');}
    finally{$('start').disabled=false;}
  }
  $('start').addEventListener('click',start);
  $('volume').addEventListener('input',e=>{if(gain)gain.gain.setTargetAtTime(Number(e.target.value)/100,ctx.currentTime,.02);});
  $('calibration').addEventListener('input',e=>{calibration=Number(e.target.value);$('calibrationValue').textContent=calibration;clearAudio();healthySince=performance.now();});
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden){send({type:'report',ready:0});healthySince=performance.now();}
    else if(wanted){clearAudio();healthySince=performance.now();if(ctx?.state==='running'&&(!ws||ws.readyState>1))connect();}
  });
  window.addEventListener('online',()=>{if(wanted&&(!ws||ws.readyState>1)){clearTimeout(retryTimer);connect();}});
  window.addEventListener('pagehide',()=>{wanted=false;generation++;ws?.close();clearAudio();});
  setInterval(pump,10);
  /* Read-only diagnostics for local QA; never grants control of the host. */
  window.lanSyncDiagnostics=()=>({state:stateText,clockReady,offset,rtt,uncertainty,late,dropped,queued:queue.length,
    scheduled:sources.size,audioState:ctx?.state,output,arrivalAge,lastEnd,currentTime:ctx?.currentTime,status,hello,synthetic});
})();
