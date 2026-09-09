import { creativeStoryboard } from './creativeEngine.mjs';
import { pngVisualMetrics } from './pngVisualMetrics.mjs';

const js=(v)=>JSON.stringify(String(v??''));
const layoutConfig=(layout)=>({
  editorial:{accent:'#7c9cff',panel:'#101827'},
  contrast:{accent:'#71e6b2',panel:'#111827'},
  proof:{accent:'#f5c56b',panel:'#121722'},
})[String(layout)]||{accent:'#7c9cff',panel:'#101827'};

export function creativeHtml(spec){
  const cfg=layoutConfig(spec.layout),bg='#080b12',text='#f7f9fc',muted='#aab4c5';
  return `<!doctype html><html><body style="margin:0;background:${bg};overflow:hidden"><canvas id="c" width="${spec.width}" height="${spec.height}"></canvas><script>
  const c=document.getElementById('c'),x=c.getContext('2d'),W=c.width,H=c.height;
  const data={hook:${js(spec.hook)},body:${js(spec.body)},cta:${js(spec.cta)},site:${js(spec.site)}};
  const story=${JSON.stringify(creativeStoryboard(spec))}; const accent=${js(cfg.accent)},panel=${js(cfg.panel)};
  const wrap=(t,max,limit=6)=>{const a=t.split(/\\s+/),o=[];let l='';for(const w of a){const n=(l+' '+w).trim();if(x.measureText(n).width>max&&l){o.push(l);l=w}else l=n}if(l)o.push(l);return o.slice(0,limit)};
  const alpha=(t,start,end)=>Math.max(0,Math.min(1,(t-start)/Math.max(1,end-start)));
  const base=()=>{x.globalAlpha=1;x.fillStyle='${bg}';x.fillRect(0,0,W,H);x.fillStyle=panel;x.roundRect(W*.07,H*.07,W*.86,H*.86,Math.max(28,W*.03));x.fill();x.fillStyle=accent;x.font='700 '+Math.round(W*.042)+'px Arial';x.fillText('ZEVANORY',W*.12,H*.16);};
  const footer=()=>{x.globalAlpha=1;x.fillStyle=accent;x.fillRect(W*.12,H*.77,W*.22,Math.max(8,H*.008));x.fillStyle='${muted}';x.font='500 '+Math.round(W*.025)+'px Arial';x.fillText(data.site,W*.12,H*.87);};
  function drawStatic(){base();x.fillStyle='${text}';x.font='800 '+Math.round(W*.066)+'px Arial';let y=H*.29;const hook=wrap(data.hook,W*.74,3);for(const l of hook){x.fillText(l,W*.12,y);y+=W*.073}x.fillStyle='${muted}';x.font='500 '+Math.round(W*.034)+'px Arial';y+=W*.025;const body=wrap(data.body,W*.74,4);for(const l of body){x.fillText(l,W*.12,y);y+=W*.047}x.fillStyle=accent;x.font='700 '+Math.round(W*.038)+'px Arial';x.fillText(data.cta,W*.12,Math.min(H*.70,y+W*.035));footer();window.__layoutMetrics={mode:'static',hook_lines:hook.length,body_lines:body.length,last_y:y,overflow:y>H*.68};}
  function sceneAt(t){return story.find(s=>t>=s.at_ms&&t<s.end_ms)||story[story.length-1]}
  function drawFrame(t=0){const scene=sceneAt(t);base();const main=scene.role==='hook'?data.hook:scene.role==='value'?data.body:data.cta;x.globalAlpha=alpha(t,scene.at_ms,scene.at_ms+420);x.fillStyle='${text}';x.font=(scene.role==='value'?'650 ':'800 ')+Math.round(W*(scene.role==='value'?.052:.072))+'px Arial';let y=H*.33;const lines=wrap(main,W*.74,6);for(const l of lines){x.fillText(l,W*.12,y);y+=W*(scene.role==='value'?.064:.082)}x.globalAlpha=1;footer();x.fillStyle='rgba(255,255,255,.08)';x.beginPath();x.arc(W*.82,H*.20,W*.12+Math.sin(t/350)*W*.012,0,Math.PI*2);x.fill();window.__layoutMetrics={mode:'video',role:scene.role,lines:lines.length,last_y:y,overflow:y>H*.72};}
  function prepare(mode='static'){mode==='static'?drawStatic():drawFrame(mode==='hook'?500:mode==='value'?1900:3400);return {...window.__layoutMetrics};}
  function measure(mode='static'){prepare(mode);const d=x.getImageData(0,0,W,H).data,stride=Math.max(1,Math.floor(Math.sqrt(W*H/18000)));let n=0,sum=0,sum2=0,min=255,max=0,edges=0,occupied=0,prev=null;const bgLum=12;for(let py=0;py<H;py+=stride){for(let px=0;px<W;px+=stride){const i=(py*W+px)*4,r=d[i],g=d[i+1],b=d[i+2],lum=.2126*r+.7152*g+.0722*b;n++;sum+=lum;sum2+=lum*lum;min=Math.min(min,lum);max=Math.max(max,lum);if(Math.abs(lum-bgLum)>18)occupied++;if(prev!==null&&Math.abs(lum-prev)>28)edges++;prev=lum;}}const mean=sum/n,std=Math.sqrt(Math.max(0,sum2/n-mean*mean));return {...window.__layoutMetrics,luminance_mean:mean,luminance_std:std,dynamic_range:max-min,edge_density:edges/Math.max(1,n-1),occupied_fraction:occupied/n};}
  drawStatic();window.__drawAt=drawFrame;window.__drawStatic=drawStatic;window.__prepareVisual=prepare;window.__captureVisualPng=(mode)=>{const layout=prepare(mode);return {layout,data_url:c.toDataURL('image/png')}};window.__measureVisual=measure;</script></body></html>`;
}

async function browser(){
  const [{chromium},mod]=await Promise.all([import('@playwright/test'),import('@sparticuz/chromium')]);
  const c=mod.default; return chromium.launch({headless:true,executablePath:await c.executablePath(),args:c.args});
}
async function readyVisualPage(page){
  await page.evaluate(async()=>{if(document.fonts?.ready)await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
}
const saneVisualMetrics=(m)=>Number(m?.dynamic_range)>=120&&Number(m?.luminance_std)>=12;
export function perceptualQualityScore(metrics={}){
  const clamp=(v)=>Math.max(0,Math.min(1,Number(v)||0));
  const contrast=clamp((Number(metrics.dynamic_range)-70)/150);
  const variance=clamp((Number(metrics.luminance_std)-12)/55);
  const occupied=Number(metrics.occupied_fraction);const density=occupied>=.12&&occupied<=.82?1:occupied>=.07&&occupied<=.90?.65:.3;
  const edge=Number(metrics.edge_density);const edgeScore=edge>=.015&&edge<=.30?1:edge>=.008&&edge<=.42?.65:.3;
  const safe=metrics.overflow===false?1:0;const lineScore=Number(metrics.hook_lines||metrics.body_lines||metrics.lines||0)<=6?1:.4;
  return Number((contrast*.22+variance*.18+density*.16+edgeScore*.14+safe*.20+lineScore*.10).toFixed(4));
}

export async function inspectCreativeVisual(spec,{mode='static'}={}){
  const b=await browser();try{const p=await b.newPage({viewport:{width:spec.width,height:spec.height}});await p.setContent(creativeHtml(spec),{waitUntil:'load'});await readyVisualPage(p);const captured=await p.evaluate(m=>window.__captureVisualPng(m),mode);const png=Buffer.from(String(captured.data_url||'').split(',')[1]||'','base64');const metrics={...captured.layout,...pngVisualMetrics(png)};return Object.freeze({...metrics,perceptual_score:perceptualQualityScore(metrics),render_sane:saneVisualMetrics(metrics)});}finally{await b.close();}
}

export async function renderCreativePng(spec){
  const b=await browser(); try{const p=await b.newPage({viewport:{width:spec.width,height:spec.height}});await p.setContent(creativeHtml(spec),{waitUntil:'load'});await readyVisualPage(p);await p.evaluate(()=>window.__drawStatic());try{return await p.locator('#c').screenshot({type:'png'});}catch{return await p.screenshot({type:'png',fullPage:false});}} finally { await b.close(); }
}

async function recordWebm(page,durationMs,fps=30){
  return page.evaluate(async({durationMs,fps})=>{
    const canvas=document.getElementById('c'),video=canvas.captureStream(fps),chunks=[];let ac,dest,osc,gain;try{ac=new AudioContext();dest=ac.createMediaStreamDestination();osc=ac.createOscillator();gain=ac.createGain();osc.type='sine';osc.frequency.value=196;gain.gain.value=.018;osc.connect(gain).connect(dest);osc.start();await ac.resume();}catch{}
    const tracks=[...video.getVideoTracks(),...(dest?.stream?.getAudioTracks?.()||[])],stream=new MediaStream(tracks);
    const types=['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm']; const mime=types.find(t=>MediaRecorder.isTypeSupported(t))||'';
    const rec=new MediaRecorder(stream,mime?{mimeType:mime}:undefined); rec.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};
    const started=performance.now(); rec.start(200); const timer=setInterval(()=>window.__drawAt(performance.now()-started),Math.round(1000/fps));
    await new Promise(resolve=>setTimeout(resolve,durationMs)); clearInterval(timer); rec.stop(); await new Promise(r=>rec.onstop=r);try{osc?.stop();await ac?.close?.();}catch{}
    const blob=new Blob(chunks,{type:rec.mimeType||'video/webm'}); const bytes=new Uint8Array(await blob.arrayBuffer());let s='';for(let i=0;i<bytes.length;i+=0x8000)s+=String.fromCharCode(...bytes.subarray(i,i+0x8000));return {base64:btoa(s),audio_tracks:tracks.filter(t=>t.kind==='audio').length,video_tracks:tracks.filter(t=>t.kind==='video').length,mime:rec.mimeType||'video/webm'};
  },{durationMs,fps});
}


export function webmHasAudioTrack(buffer){
  const bytes=Buffer.from(buffer||[]),limit=Math.min(bytes.length,131072);
  for(let i=0;i<limit-2;i++)if(bytes[i]===0x83&&bytes[i+1]===0x81&&bytes[i+2]===0x02)return true;
  return false;
}

export async function renderCreativeWebm(spec,{durationMs=4200}={}){
  const b=await browser(); try{const p=await b.newPage({viewport:{width:spec.width,height:spec.height}});await p.setContent(creativeHtml(spec),{waitUntil:'load'});await readyVisualPage(p);let out;try{out=await recordWebm(p,durationMs,30);}catch{out=await recordWebm(p,Math.min(durationMs,3600),20);}if(out.video_tracks<1||out.audio_tracks<1)throw new Error('creative_av_tracks_missing');const buffer=Buffer.from(out.base64,'base64');if(!webmHasAudioTrack(buffer))throw new Error('creative_encoded_audio_track_missing');return buffer;} finally { await b.close(); }
}

export async function renderCreativeAsset(spec,format='png',renderers={png:renderCreativePng,webm:renderCreativeWebm}){
  const key=String(format).toLowerCase(); const primary=renderers[key]; if(typeof primary!=='function')throw new Error('creative_renderer_unavailable');
  return primary(spec);
}

async function inspectCreativeOnPage(p,spec,{video=false}={}){
  await p.setViewportSize({width:spec.width,height:spec.height});await p.setContent(creativeHtml(spec),{waitUntil:'load'});await readyVisualPage(p);
  const captured=await p.evaluate(m=>window.__captureVisualPng(m),'static');const png=Buffer.from(String(captured.data_url||'').split(',')[1]||'','base64');const pixel={...captured.layout,...pngVisualMetrics(png)};
  const baseScore=perceptualQualityScore(pixel);if(!saneVisualMetrics(pixel))throw new Error('creative_visual_capture_invalid');
  if(!video)return Object.freeze({frames:Object.freeze([Object.freeze({...pixel,mode:'static',score:baseScore,render_sane:true})]),perceptual_score:baseScore,min_frame_score:baseScore});
  const frames=[];for(const mode of ['hook','value','cta']){const layout=await p.evaluate(m=>window.__prepareVisual(m),mode);const safe=layout.overflow===false?1:0;const lines=Number(layout.lines||0);const scene=Number((baseScore*.75+safe*.20+(lines>0&&lines<=6?1:.4)*.05).toFixed(4));frames.push(Object.freeze({...pixel,...layout,mode,score:scene,render_sane:true}));}
  const avg=frames.reduce((sum,f)=>sum+f.score,0)/frames.length,min=Math.min(...frames.map(f=>f.score));return Object.freeze({frames:Object.freeze(frames),perceptual_score:Number((avg*.75+min*.25).toFixed(4)),min_frame_score:min});
}

export async function inspectCreativeVisualBatch(specs=[],options={}){
  const list=Array.isArray(specs)?specs:[];if(!list.length)return Object.freeze([]);const b=await browser();try{const p=await b.newPage({viewport:{width:list[0].width,height:list[0].height}});const out=[];for(const spec of list)out.push(await inspectCreativeOnPage(p,spec,options));return Object.freeze(out);}finally{await b.close();}
}

export async function inspectCreativeVisualSequence(spec,options={}){
  return (await inspectCreativeVisualBatch([spec],options))[0];
}

