// Active audio can continue receiving these tasks when window timers are
// throttled. OS suspension still stops heartbeats and preserves the audio lease.
let beat=0,clock=0;
setInterval(()=>{
  const t=performance.now();postMessage({type:'schedule'});
  if(t-beat>=750){beat=t;postMessage({type:'heartbeat'});}
  if(t-clock>=10000){clock=t;postMessage({type:'clock'});}
},200);
