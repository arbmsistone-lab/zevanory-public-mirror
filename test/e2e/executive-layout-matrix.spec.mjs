import { test, expect } from '@playwright/test';
const viewports=[{width:1280,height:720},{width:1366,height:768},{width:1440,height:900},{width:1536,height:864},{width:1920,height:1080}];
const selectors=['.topbar','.executive-strip','.decision-center','.business-center','.readiness-rail','.governance-bar','footer'];
for(const viewport of viewports){
  test(`executive layout has no clipping or collisions at ${viewport.width}x${viewport.height}`,async({page},testInfo)=>{
    await page.setViewportSize(viewport); const errors=[]; page.on('pageerror',e=>errors.push(String(e.message||e)));
    const response=await page.goto('/',{waitUntil:'domcontentloaded'}); expect(response?.status()).toBeLessThan(500);
    await expect(page.locator('#health-label')).toBeVisible(); await expect(page.locator('#health-label')).toContainText(/100% SENIOR ELITE|[0-5]\/5 PROVAS/,{timeout:10000});
    const result=await page.evaluate((selectors)=>{
      const box=(s)=>{const e=document.querySelector(s),r=e?.getBoundingClientRect();return r?{s,x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom}:null};
      const boxes=selectors.map(box).filter(Boolean), viewport={w:innerWidth,h:innerHeight};
      const outside=boxes.filter(r=>r.x<-1||r.y<-1||r.right>viewport.w+1||r.bottom>viewport.h+1);
      const header=['.brand-link','.mission','.portfolio-link','#health-label','.whatsapp-header-cta'].map(box).filter(Boolean);
      const intersects=(a,b)=>Math.min(a.right,b.right)-Math.max(a.x,b.x)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y)>1;
      const overlaps=[]; for(let i=0;i<header.length;i++)for(let j=i+1;j<header.length;j++)if(intersects(header[i],header[j]))overlaps.push([header[i].s,header[j].s]);
      const textSelectors=['.eyebrow','.decision-copy h1','.decision-copy p','.priority-callout','.executive-summary','.signal-grid article','.readiness-card','.details-button','.governance-bar'];
      const clipped=textSelectors.flatMap(s=>[...document.querySelectorAll(s)].filter(e=>e.scrollWidth>e.clientWidth+2||e.scrollHeight>e.clientHeight+2).map(e=>s+':'+e.textContent.trim().slice(0,60)));
      return {outside,overlaps,clipped,doc:{sw:document.documentElement.scrollWidth,sh:document.documentElement.scrollHeight},viewport};
    },selectors);
    expect(result.doc.sw).toBeLessThanOrEqual(result.viewport.w+2); expect(result.doc.sh).toBeLessThanOrEqual(result.viewport.h+8);
    expect(result.outside).toEqual([]); expect(result.overlaps).toEqual([]); expect(result.clipped).toEqual([]); expect(errors).toEqual([]);
    await page.screenshot({path:testInfo.outputPath(`executive-${viewport.width}x${viewport.height}.png`),fullPage:true});
  });
}
