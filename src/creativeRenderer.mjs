import { creativeStoryboard } from './creativeEngine.mjs';

const js=(v)=>JSON.stringify(String(v??''));
const layoutConfig=(layout)=>({
  editorial:{accent:'#7c9cff',panel:'#101827',align:'left'},
  contrast:{accent:'#71e6b2',panel:'#111827',align:'left'},
  proof:{accent:'#f5c56b',panel:'#121722',align:'left'},
})[String(layout)]||{accent:'#7c9cff',panel:'#101827',align:'left'};

export function creativeHtml(spec){
  const cfg=layoutConfig(spec.layout),bg='#080b12',text='#f7f9fc',muted='#aab4c5';
  return `<!doctype html><html><body style="margin:0;background:${bg};overflow:hidden"><canvas id="c" width="${spec.width}" height="${spec.height}"></canvas><script>
  const c=document.getElementById('c'),x=c.getContext('2d'),W=c.width,H=c.height;
  const data={hook:${js(spec.hook)},body:${js(spec.body)},cta:${js(spec.cta)},site:${js(spec.site)},layout:${js(spec.layout)}};
  const story=${JSON.stringify(creativeStoryboard(spec))}; const accent=${js(cfg.accent)},panel=${js(cfg.panel)};
  const wrap=(t,max)=>{const a=t.split(/\\s+/),o=[];let l='';for(const w of a){const n=(l+' '+w).trim();if(x.measureText(n).width>max&&l){o.push(l);l=w}else l=n}if(l)o.push(l);return o.slice(0,6)};
  const alpha=(t,start,end)=>Math.max(0,Math.min(1,(t-start)/Math.max(1,end-start)));
  function sceneAt(t){return story.find(s=>t>=s.at_ms&&t<s.end_ms)||story[story.length-1]}
  function draw(t=0){const scene=sceneAt(t);x.globalAlpha=1;x.fillStyle='${bg}';x.fillRect(0,0,W,H);x.fillStyle=panel;x.roundRect(W*.07,H*.07,W*.86,H*.86,Math.max(28,W*.03));x.fill();
  x.fillStyle=accent;x.font='700 '+Math.round(W*.042)+'px Arial';x.fillText('ZEVANORY',W*.12,H*.16);
  const main=scene.role==='hook'?data.hook:scene.role==='value'?data.body:data.cta; x.globalAlpha=alpha(t,scene.at_ms,scene.at_ms+420);
  x.fillStyle='${text}';x.font=(scene.role==='value'?'650 ':'800 ')+Math.round(W*(scene.role==='value'?.052:.072))+'px Arial';let y=H*.33;for(const l of wrap(main,W*.74)){x.fillText(l,W*.12,y);y+=W*(scene.role==='value'?.064:.082)}
  x.globalAlpha=1;x.fillStyle=accent;x.fillRect(W*.12,H*.77,W*.22,Math.max(8,H*.008));x.fillStyle='${muted}';x.font='500 '+Math.round(W*.025)+'px Arial';x.fillText(data.site,W*.12,H*.87);
  x.fillStyle='rgba(255,255,255,.08)';x.beginPath();x.arc(W*.82,H*.20,W*.12+Math.sin(t/350)*W*.012,0,Math.PI*2);x.fill();}
  draw(0);window.__drawAt=draw;</script></body></html>`;
}

async function browser(){
  const [{chromium},mod]=await Promise.all([import('@playwright/test'),import('@sparticuz/chromium')]);
  const c=mod.default; return chromium.launch({headless:true,executablePath:await c.executablePath(),args:c.args});
}export async function renderCreativePng(spec){
  const b=await browser(); try{
    const p=await b.newPage({viewport:{width:spec.width,height:spec.height}}); await p.setContent(creativeHtml(spec),{waitUntil:'load'});
    try{return await p.locator('#c').screenshot({type:'png'});}catch{return await p.screenshot({type:'png',fullPage:false});}
  } finally { await b.close(); }
}

async function recordWebm(page,durationMs,fps=30){
  return page.evaluate(async({durationMs,fps})=>{
    const canvas=document.getElementById('c'),stream=canvas.captureStream(fps),chunks=[];
    const types=['video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm']; const mime=types.find(t=>MediaRecorder.isTypeSupported(t))||'';
    const rec=new MediaRecorder(stream,mime?{mimeType:mime}:undefined); rec.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};
    const started=performance.now(); rec.start(200); const timer=setInterval(()=>window.__drawAt(performance.now()-started),Math.round(1000/fps));
    await new Promise(resolve=>setTimeout(resolve,durationMs)); clearInterval(timer); rec.stop(); await new Promise(r=>rec.onstop=r);
    const blob=new Blob(chunks,{type:rec.mimeType||'video/webm'}); const bytes=new Uint8Array(await blob.arrayBuffer());
    let s=''; for(let i=0;i<bytes.length;i+=0x8000)s+=String.fromCharCode(...bytes.subarray(i,i+0x8000)); return btoa(s);
  },{durationMs,fps});
}

export async function renderCreativeWebm(spec,{durationMs=4200}={}){
  const b=await browser(); try{
    const p=await b.newPage({viewport:{width:spec.width,height:spec.height}}); await p.setContent(creativeHtml(spec),{waitUntil:'load'});
    try{return Buffer.from(await recordWebm(p,durationMs,30),'base64');}
    catch{return Buffer.from(await recordWebm(p,Math.min(durationMs,3600),20),'base64');}
  } finally { await b.close(); }
}

export async function renderCreativeAsset(spec,format='png',renderers={png:renderCreativePng,webm:renderCreativeWebm}){
  const key=String(format).toLowerCase(); const primary=renderers[key]; if(typeof primary!=='function')throw new Error('creative_renderer_unavailable');
  return primary(spec);
}
