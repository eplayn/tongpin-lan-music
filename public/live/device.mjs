const text=value=>String(value||'').trim();
export function devicePlatform(ua,platform='',touch=0){
  if(/iPad/.test(ua)||/Mac/.test(platform)&&touch>1)return 'iPadOS';
  if(/iPhone|iPod/.test(ua))return 'iOS';
  if(/Android/.test(ua))return 'Android';
  if(/Win/.test(platform)||/Windows/.test(ua))return 'Windows';
  if(/Mac/.test(platform)||/Macintosh/.test(ua))return 'macOS';
  if(/Linux/.test(ua))return 'Linux';return '其他设备';
}
export function fallbackName(info){return info.model||({Windows:'Windows 电脑',macOS:'Mac',iOS:'iPhone',iPadOS:'iPad',Android:'安卓设备',Linux:'Linux 电脑'}[info.platform])||'网页设备';}
export async function getDeviceInfo(nav=navigator){
  const ua=nav.userAgent||'';let model='';
  try{if(nav.userAgentData?.getHighEntropyValues){const extra=await nav.userAgentData.getHighEntropyValues(['model']);model=text(extra.model);}}catch{}
  if(!model&&/Android/.test(ua)){const match=ua.match(/Android[^;)]*;\s*(?:[a-z]{2}[-_][A-Z]{2};\s*)?([^;)]+?)(?:\s+Build\/|\))/);if(match&&!/^(K|wv)$/i.test(match[1]))model=match[1].trim();}
  const platform=devicePlatform(ua,nav.userAgentData?.platform||nav.platform||'',nav.maxTouchPoints||0);
  const browser=/Edg\//.test(ua)?'Edge':/Firefox|FxiOS/.test(ua)?'Firefox':/Chrome|CriOS/.test(ua)?'Chrome':/Safari/.test(ua)?'Safari':'浏览器';
  return {platform,model,browser};
}
export function isCableInput(device){
  if(device.kind!=='audioinput'||['default','communications'].includes(device.deviceId))return false;
  return /^(?:CABLE(?:[- ]?[A-D])? Output\b|VB[- ]?CABLE(?:[- ]?[A-D])?(?:\s|\(|$))/i.test(device.label);
}
export function isPhysicalOutput(device){return device.kind==='audiooutput'&&!['default','communications'].includes(device.deviceId)&&!/(CABLE|VB[- ]?Audio|VoiceMeeter|Virtual|BlackHole|Loopback|Multi.Output|Aggregate|多输出|聚集)/i.test(device.label);}
export function makeDeviceKey(cryptoApi=crypto){return Array.from(cryptoApi.getRandomValues(new Uint8Array(32)),n=>n.toString(16).padStart(2,'0')).join('');}
