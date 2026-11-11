const q=(values,p)=>{if(!values.length)return 0;const a=[...values].sort((a,b)=>a-b);return a[Math.min(a.length-1,Math.floor((a.length-1)*p))];};
export class PlaybackMetrics {
  constructor(now=()=>performance.now()){this.now=now;this.reset(0);}
  reset(generation,graceMs=2000){this.generation=generation;this.after=this.now()+graceMs;this.arrivals=[];this.phases=[];this.serial=0;this.late=0;this.underruns=0;}
  arrival(p,serverNow){if(this.now()<this.after)return;this.arrivals.push({at:this.now(),value:Math.max(0,serverNow-p.captureMs)});this.serial++;this.trim();}
  miss(){if(this.now()>=this.after)this.late++;}
  gap(){if(this.now()>=this.after)this.underruns++;}
  phase(value){if(this.now()<this.after)return;this.phases.push({at:this.now(),value:Math.abs(value)});if(value < -15)this.underruns++;this.trim();}
  trim(){const since=this.now()-3000;this.arrivals=this.arrivals.filter(x=>x.at>=since).slice(-150);this.phases=this.phases.filter(x=>x.at>=since).slice(-150);}
  snapshot(sourceDrops=0){this.trim();const a=this.arrivals.map(x=>x.value);return{generation:this.generation,serial:this.serial,samples:a.length,lastSampleAgoMs:this.arrivals.length?this.now()-this.arrivals.at(-1).at:1e9,arrivalP98Ms:q(a,.98),arrivalMedianMs:q(a,.5),phaseP98Ms:q(this.phases.map(x=>x.value),.98),late:this.late,underruns:this.underruns,sourceDrops};}
}
