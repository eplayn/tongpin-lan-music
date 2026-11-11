const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
const round=n=>Math.ceil(n/10)*10;
function quantile(values,p){if(!values.length)return 0;const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.min(sorted.length-1,Math.floor((sorted.length-1)*p))];}

// A single server-owned time mapping. Each outgoing audio packet carries its
// mapped start AND end, so a late heartbeat cannot desynchronise a listener.
export class AdaptiveBuffer {
  constructor(now=0){this.reset(now);}
  reset(now){
    this.plan={start:now,end:now,from:1000,to:1000};this.target=1000;this.revision=0;
    this.started=now;this.lastCheck=now;this.holdUntil=now+3000;this.lastBad=now;this.lastDecay=now;
    this.learnedFloor=100;this.estimatedFloor=100;this.upload=[];this.reports=new Map();this.sourceGaps=0;this.seenGaps=0;
    this.stableSince=null;this.stabilityFloor=100;
    this.state='warming';this.reason='从 1000 毫秒起步，正在测量各设备';
  }
  valueAt(captureMs){const p=this.plan;if(captureMs<=p.start)return p.from;if(captureMs>=p.end)return p.to;return p.from+(p.to-p.from)*(captureMs-p.start)/(p.end-p.start);}
  playoutAt(captureMs){return captureMs+this.valueAt(captureMs);}
  observeUpload(now,ageMs,gap=false){
    this.upload.push({at:now,age:clamp(ageMs,0,4000)});
    while(this.upload.length&&(this.upload[0].at<now-6000||this.upload.length>256))this.upload.shift();
    if(gap)this.sourceGaps++;
  }
  setTarget(target,now,captureMs,reason){
    target=clamp(round(target),100,2000);if(target===this.target)return false;
    const current=this.valueAt(captureMs),speed=target<current?(current-this.estimatedFloor>150?.02:.01):.03;
    const duration=Math.max(500,Math.abs(target-current)/speed);
    this.stableSince=null;
    this.plan={start:captureMs,end:captureMs+duration,from:current,to:target};this.target=target;this.revision++;
    this.state=target<current?'probing':'recovering';this.reason=reason;return true;
  }
  step(now,captureMs,clients){
    if(now-this.lastCheck<1000)return false;this.lastCheck=now;
    const upload=this.upload.filter(x=>x.at>=now-6000).map(x=>x.age);
    // A live HTTP response is not proof that a listener is still receiving audio.
    // Age the last audio sample on the server too, rather than replaying a stale heartbeat.
    const active=clients.filter(c=>c.enabled&&c.stream&&c.ready&&!c.error&&c.contextState==='running'
      &&now-c.lastSeen<1500&&Number.isFinite(c.outputLatencyMs)&&c.uncertaintyMs<=25
      &&c.metrics?.samples>=12&&c.metrics.lastSampleAgoMs+Math.max(0,now-c.lastSeen)<1000);
    let removed=false;
    for(const id of this.reports.keys())if(!active.some(c=>c.id===id)){this.reports.delete(id);removed=true;}
    let healthy=active.length>0&&upload.length>=20,bad=this.sourceGaps>this.seenGaps;
    this.seenGaps=this.sourceGaps;
    let floor=100,quiet=true,stabilityFloor=100;
    for(const c of active){
      const hardware=c.outputLatencyMs+Math.max(0,c.advanceMs||0),uncertainty=clamp(c.uncertaintyMs||0,0,25)*2;
      const m=c.metrics,keys=['serial','late','underruns','sourceDrops'];
      let r=this.reports.get(c.id);
      const reset=r&&keys.some(key=>m[key]<r[key]);
      if(!r||reset){
        r={...m,since:now,acceptedFloor:100,learnedFloor:100,lastBad:now,lastDecay:now,pendingSince:null,faultSince:null,lastFault:0,floors:[]};
        this.reports.set(c.id,r);
      }
      // Only new audio-bearing reports can confirm pressure. Two seconds of
      // continued reception separate a weak link from a dying connection.
      const advanced=m.serial>r.serial;
      const late=advanced&&m.late>r.late;
      const fault=advanced&&(late||m.underruns>r.underruns||m.sourceDrops>r.sourceDrops);
      if(!advanced||fault)quiet=false;
      if(fault){
        if(r.faultSince===null||now-r.lastFault>1500)r.faultSince=now;
        r.lastFault=now;
      }else if(now-r.lastFault>1500)r.faultSince=null;
      const confirmed=fault&&now-r.since>=2000&&now-r.faultSince>=2000;
      if(confirmed){
        bad=true;r.lastBad=now;
        if(late)r.learnedFloor=Math.max(r.learnedFloor,round(this.valueAt(captureMs)+50));
      }
      const reserve=clamp((m.arrivalP98Ms-m.arrivalMedianMs)*2,35,150);
      const measured=round(Math.max(quantile(upload,.98)+hardware+uncertainty+60,m.arrivalP98Ms+hardware+uncertainty+12+reserve));
      if(measured>r.acceptedFloor+10){
        if(r.pendingSince===null)r.pendingSince=now;
        if(advanced&&now-r.pendingSince>=2000&&now-r.since>=2000){r.acceptedFloor=measured;r.pendingSince=null;}
      }else{r.acceptedFloor=measured;r.pendingSince=null;}
      const lowLatency=this.target<=500;
      if(advanced&&!fault&&now-r.lastBad>=(lowLatency?120000:10000)&&now-r.lastDecay>=(lowLatency?30000:4000)){r.learnedFloor=Math.max(100,r.learnedFloor-(lowLatency?10:50));r.lastDecay=now;}
      if(advanced&&now-r.since>=2000)r.floors.push({at:now,value:r.acceptedFloor});
      r.floors=r.floors.filter(x=>now-x.at<=60000);
      stabilityFloor=Math.max(stabilityFloor,...r.floors.map(x=>x.value));
      floor=Math.max(floor,r.acceptedFloor);
      if(now-r.since<2000||m.phaseP98Ms>15)healthy=false;
      for(const key of keys)r[key]=m[key];
    }
    // Learned deadline floors belong to the device that produced them. An
    // offline/recovering listener must not leave a room-wide penalty behind.
    this.learnedFloor=Math.max(100,...[...this.reports.values()].map(r=>r.learnedFloor));
    this.stabilityFloor=clamp(round(Math.max(stabilityFloor,this.learnedFloor)),100,2000);
    const current=this.valueAt(captureMs);
    if(!healthy||!quiet||bad||captureMs<this.plan.end)this.stableSince=null;
    else if(this.stableSince===null)this.stableSince=now;
    if(bad){this.lastBad=now;this.holdUntil=now+8000;}
    floor=clamp(round(Math.max(floor,this.learnedFloor)),100,2000);this.estimatedFloor=floor;
    const raising=this.target>current+1;
    if(removed&&raising&&!bad&&floor<this.target-10){
      return this.setTarget(Math.max(current,floor),now,captureMs,'已移除掉线设备的反馈，停止增加共同缓冲');
    }
    if(floor>this.target+10||bad&&!raising){
      this.holdUntil=Math.max(this.holdUntil,now+8000);
      return this.setTarget(Math.max(floor,bad?current+150:floor),now,captureMs,bad?'检测到迟到或断音，增加播放余量':'设备或网络需要更多播放余量');
    }
    if(captureMs<this.plan.end)return false;
    if(this.target<=500){
      // Below half a second, preserve a measured safety cushion instead of
      // chasing the short-window minimum. Offline devices lose this history too.
      const safeFloor=Math.min(2000,this.stabilityFloor+60);
      if(healthy&&quiet&&now>=this.holdUntil&&this.stableSince!==null&&now-this.stableSince>=30000&&this.target-safeFloor>=20){
        return this.setTarget(Math.max(safeFloor,this.target-20),now,captureMs,'持续稳定且余量充足，小幅调整收敛值');
      }
      this.state=healthy?'settled':'warming';
      this.reason=healthy?'低延迟稳定优先，保持当前收敛值':'等待在线设备的有效测量';return false;
    }
    if(healthy&&now>=this.holdUntil&&this.target-floor>=20){
      const step=clamp(round((this.target-floor)/2),20,200);
      return this.setTarget(Math.max(500,floor,this.target-step),now,captureMs,'运行稳定，正在降低共同缓冲');
    }
    this.state=now<this.holdUntil?'holding':healthy?'settled':'warming';
    this.reason=now<this.holdUntil?'保留余量，等待稳定':healthy?'保持当前可用缓冲':'等待在线设备的有效测量';return false;
  }
  snapshot(captureMs){return{revision:this.revision,targetMs:this.target,currentMs:this.valueAt(captureMs),floorMs:this.estimatedFloor,stabilityFloorMs:this.stabilityFloor,stableSinceMs:this.stableSince,state:this.state,reason:this.reason,plan:{...this.plan},uploadP98Ms:quantile(this.upload.map(x=>x.age),.98)};}
}
