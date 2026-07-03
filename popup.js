const DEFAULTS = {
  enabled: true,
  delayMs: 80,
  endThreshold: 1.15,
  showMiniPanel: true,
  pauseWhenInteracting: true,
  skipMutedAds: true,
  aggressiveBackground: true,
  smoothMode: true
};
const $ = id => document.getElementById(id);
const controls = {
  enabled: $('enabled'), delayMs: $('delayMs'), endThreshold: $('endThreshold'),
  showMiniPanel: $('showMiniPanel'), pauseWhenInteracting: $('pauseWhenInteracting'),
  aggressiveBackground: $('aggressiveBackground'), smoothMode: $('smoothMode')
};
function status(text){ $('status').textContent=text; clearTimeout(status.t); status.t=setTimeout(()=>$('status').textContent='Ready',1200); }
function renderValues(){ $('delayValue').textContent=`${controls.delayMs.value} ms`; $('thresholdValue').textContent=`${Number(controls.endThreshold.value).toFixed(2)} s before end`; }
async function save(key,value){ await chrome.storage.sync.set({[key]:value}); status('Saved'); }
async function load(){ const s=await chrome.storage.sync.get(DEFAULTS); for(const k of Object.keys(controls)){ if(controls[k].type==='checkbox') controls[k].checked=!!s[k]; else controls[k].value=s[k]; } renderValues(); }
for(const k of ['enabled','showMiniPanel','pauseWhenInteracting','aggressiveBackground','smoothMode']) controls[k].addEventListener('change',()=>save(k,controls[k].checked));
controls.delayMs.addEventListener('input',renderValues); controls.endThreshold.addEventListener('input',renderValues);
controls.delayMs.addEventListener('change',()=>save('delayMs',Number(controls.delayMs.value))); controls.endThreshold.addEventListener('change',()=>save('endThreshold',Number(controls.endThreshold.value)));
async function preset(obj){ await chrome.storage.sync.set(obj); await load(); status('Preset saved'); }
$('presetSmooth').addEventListener('click',()=>preset({smoothMode:true,delayMs:80,endThreshold:1.15,aggressiveBackground:true}));
$('presetFast').addEventListener('click',()=>preset({smoothMode:false,delayMs:0,endThreshold:0.65,aggressiveBackground:true}));
$('presetSafe').addEventListener('click',()=>preset({smoothMode:true,delayMs:0,endThreshold:1.75,aggressiveBackground:true}));
$('reset').addEventListener('click',async()=>{ await chrome.storage.sync.set(DEFAULTS); await load(); status('Reset'); });
load();
