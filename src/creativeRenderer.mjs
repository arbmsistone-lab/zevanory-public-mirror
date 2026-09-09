import { creativeStoryboard } from './creativeEngine.mjs';

const js=(v)=>JSON.stringify(String(v??''));
export function creativeHtml(spec){
  const bg='#080b12',panel='#101827',text='#f7f9fc',muted='#aab4c5',accent='#7c9cff';
  return `<!doctype html><html><body style="margin:0;background:${bg};overflow:hidden"><canvas id="c" width="${spec.width}" height="${spec.height}"></canvas><script>
  const c=document.getElementById('c'),x=c.getContext('2d'); const W=c.width,H=c.height;
  const data={hook:${js(spec.hook)},body:${js(spec.body)},cta:${js(spec.cta)},product:${js(spec.product)},site:${js(spec.site)}};
  const wrap=(t,max)=>{const a=t.split(/\\s+/),o=[];let l='';for(const w of a){const n=(l+' '+w).trim();if(x.measureText(n).width>max&&l){o.push(l);l=w}else l=n}if(l)o.push(l);return o.slice(0,5)};
  function draw(p=1){x.fillStyle='${bg}';x.fillRect(0,0,W,H);x.fillStyle='${panel}';x.roundRect(W*.07,H*.07,W*.86,H*.86,Math.max(28,W*.03));x.fill();
  x.fillStyle='${accent}';x.font='700 '+Math.round(W*.042)+'px Arial';x.fillText('ZEVANORY',W*.12,H*.16);
  x.fillStyle='${text}';x.font='800 '+Math.round(W*.074)+'px Arial';let y=H*.30;for(const l of wrap(data.hook,W*.74)){x.fillText(l,W*.12,y);y+=W*.082}
  x.fillStyle='${muted}';x.font='500 '+Math.round(W*.035)+'px Arial';y+=W*.03;for(const l of wrap(data.body,W*.74)){x.fillText(l,W*.12,y);y+=W*.05}
  x.fillStyle='${accent}';x.font='700 '+Math.round(W*.04)+'px Arial';x.fillText(data.cta,W*.12,H*.78);x.fillStyle='${muted}';x.font='500 '+Math.round(W*.025)+'px Arial';x.fillText(data.site,W*.12,H*.86);
  x.globalAlpha=Math.min(1,p);x.fillStyle='rgba(124,156,255,.12)';x.beginPath();x.arc(W*.82,H*.20,W*.12,0,Math.PI*2);x.fill();x.globalAlpha=1}
  draw(1);window.__draw=draw;</script></body></html>`;
}

async function browser(){
  const [{chromium},mod]=await Promise.all([import('@playwright/test'),import('@sparticuz/chromium')]);
  const c=mod.default; return chromium.launch({headless:true,executablePath:await c.executablePath(),args:c.args});
}

export async function renderCreativePng(spec){
  const b=await browser(); try{
    const p=await b.newPage({viewport:{width:spec.width,height:spec.height}}); await p.setContent(creativeHtml(spec),{waitUntil:'load'});
    return await p.locator('#c').screenshot({type:'png'});
  } finally { await b.close(); }
}

export async function renderCreativeWebm(spec,{durationMs=4200}={}){
  const b=await browser(); try{
    const p=await b.newPage({viewport:{width:spec.width,height:spec.height}}); await p.setContent(creativeHtml(spec),{waitUntil:'load'});
    const story=creativeStoryboard(spec);
    const base64=await p.evaluate(async({durationMs,story})=>{
      const canvas=document.getElementById('c'),stream=canvas.captureStream(30),chunks=[];
      const types=['video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm']; const mime=types.find(t=>MediaRecorder.isTypeSupported(t))||'';
      const rec=new MediaRecorder(stream,mime?{mimeType:mime}:undefined); rec.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};
      const started=performance.now(); rec.start(200);
      const timer=setInterval(()=>{const t=performance.now()-started; window.__draw(Math.min(1,t/700));},33);
      await new Promise(resolve=>setTimeout(resolve,durationMs)); clearInterval(timer); rec.stop(); await new Promise(r=>rec.onstop=r);
      const blob=new Blob(chunks,{type:rec.mimeType||'video/webm'}); const bytes=new Uint8Array(await blob.arrayBuffer());
      let s=''; for(let i=0;i<bytes.length;i+=0x8000)s+=String.fromCharCode(...bytes.subarray(i,i+0x8000)); return btoa(s);
    },{durationMs,story});
    return Buffer.from(base64,'base64');
  } finally { await b.close(); }
}
