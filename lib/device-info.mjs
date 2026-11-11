import os from 'node:os';
import dns from 'node:dns/promises';
const cache=new Map();
export function cleanDeviceInfo(input={}){
  const text=(value,n=64)=>String(value||'').replace(/[\x00-\x1f\x7f]/g,'').trim().slice(0,n);
  return {platform:text(input?.platform,24),model:text(input?.model),browser:text(input?.browser,40)};
}
export async function deviceHint(address=''){
  const ip=address.replace(/^::ffff:/,'');
  const local=new Set(['127.0.0.1','::1',...Object.values(os.networkInterfaces()).flat().filter(Boolean).map(x=>x.address)]);
  if(local.has(ip))return {realName:os.hostname(),nameSource:'host',address:ip};
  if(!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip))return {realName:'',nameSource:'browser',address:ip};
  if(cache.get(ip)?.expires>Date.now())return cache.get(ip).value;
  let timer;
  const names=await Promise.race([dns.reverse(ip).catch(()=>[]),new Promise(resolve=>{timer=setTimeout(()=>resolve([]),350);})]);
  clearTimeout(timer);
  const name=String(names[0]||'').replace(/\.local\.?$/i,'').slice(0,64);
  const value={realName:name,nameSource:name?'network':'browser',address:ip};
  if(cache.size>128)cache.clear();cache.set(ip,{value,expires:Date.now()+300000});return value;
}
