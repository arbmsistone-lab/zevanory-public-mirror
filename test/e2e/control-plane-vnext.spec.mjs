import { test, expect } from '@playwright/test';

const viewports=[
  {width:1280,height:720},
  {width:1366,height:768},
  {width:1600,height:900},
  {width:1920,height:1080},
];

for(const viewport of viewports){
  test(`control plane vNext is single-screen and collision-free at ${viewport.width}x${viewport.height}`,async({page},testInfo)=>{
    await page.setViewportSize(viewport);
    const errors=[];
    page.on('pageerror',e=>errors.push(String(e.message||e)));
    const response=await page.goto('/',{waitUntil:'domcontentloaded'});
    expect(response?.status()).toBeLessThan(500);

    const shell=page.locator('.cpv2-shell');
    await expect(shell).toBeVisible({timeout:10000});
    await expect(page.locator('.cpv2-card')).toHaveCount(6);
    await expect(page.locator('.cpv2-proofbar')).toBeVisible();
    await expect(page.locator('#cpv2-global')).toContainText(/OPERACIONAL \/ COMERCIAL (BLOQUEADO|LIBERADO)/);
    await expect(page.locator('#cpv2-ten')).toContainText(/\d+ PROVADOS · \d+ PARCIAIS · \d+ BLOQUEADOS/,{timeout:10000});

    const geometry=await page.evaluate(()=>{
      const visible=e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0;};
      const boxes=[...document.querySelectorAll('.cpv2-state,.cpv2-conformity,.cpv2-card,.cpv2-proofbar')].filter(visible).map(e=>{
        const r=e.getBoundingClientRect();
        return {cls:e.className,x:r.x,y:r.y,right:r.right,bottom:r.bottom,w:r.width,h:r.height,sw:e.scrollWidth,cw:e.clientWidth,sh:e.scrollHeight,ch:e.clientHeight};
      });
      const outside=boxes.filter(r=>r.x<-1||r.y<-1||r.right>innerWidth+1||r.bottom>innerHeight+1);
      const clipped=boxes.filter(r=>r.sw>r.cw+2||r.sh>r.ch+2);
      const cards=[...document.querySelectorAll('.cpv2-card')].map(e=>e.getBoundingClientRect());
      const overlaps=[];
      for(let i=0;i<cards.length;i++)for(let j=i+1;j<cards.length;j++){
        const a=cards[i],b=cards[j];
        if(Math.min(a.right,b.right)-Math.max(a.left,b.left)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1)overlaps.push([i,j]);
      }
      return {outside,clipped,overlaps,doc:{sw:document.documentElement.scrollWidth,sh:document.documentElement.scrollHeight},viewport:{w:innerWidth,h:innerHeight}};
    });

    expect(geometry.doc.sw).toBeLessThanOrEqual(geometry.viewport.w+2);
    expect(geometry.doc.sh).toBeLessThanOrEqual(geometry.viewport.h+8);
    expect(geometry.outside).toEqual([]);
    expect(geometry.clipped).toEqual([]);
    expect(geometry.overlaps).toEqual([]);
    expect(errors).toEqual([]);
    await page.screenshot({path:testInfo.outputPath(`control-plane-vnext-${viewport.width}x${viewport.height}.png`),fullPage:true});
  });
}

test('ZEA-10 drilldown renders ten evidence-bound pillars without page overflow',async({page},testInfo)=>{
  await page.setViewportSize({width:1440,height:900});
  await page.goto('/',{waitUntil:'domcontentloaded'});
  await expect(page.locator('#cpv2-ten')).toContainText(/PROVADOS/,{timeout:10000});
  await page.locator('.cpv2-conformity').click();
  const dialog=page.locator('#cpv2-policy-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.cpv2-pillar')).toHaveCount(10);
  await expect(dialog.locator('.cpv2-pillar-state')).toHaveCount(10);
  const metrics=await dialog.evaluate(e=>{
    const r=e.getBoundingClientRect();
    return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,w:innerWidth,h:innerHeight,sw:document.documentElement.scrollWidth};
  });
  expect(metrics.left).toBeGreaterThanOrEqual(0);
  expect(metrics.top).toBeGreaterThanOrEqual(0);
  expect(metrics.right).toBeLessThanOrEqual(metrics.w);
  expect(metrics.bottom).toBeLessThanOrEqual(metrics.h);
  expect(metrics.sw).toBeLessThanOrEqual(metrics.w+2);
  await page.screenshot({path:testInfo.outputPath('zea10-drilldown.png'),fullPage:true});
});


const adaptiveViewports=[
  {width:1024,height:768,label:'tablet-landscape'},
  {width:768,height:1024,label:'tablet-portrait'},
  {width:430,height:932,label:'mobile-large'},
  {width:390,height:844,label:'mobile-standard'},
];

for(const viewport of adaptiveViewports){
  test(`UI-12 preserves hierarchy and avoids horizontal overflow at ${viewport.label}`,async({page},testInfo)=>{
    await page.setViewportSize(viewport);
    const response=await page.goto('/',{waitUntil:'domcontentloaded'});
    expect(response?.status()).toBeLessThan(500);
    await expect(page.locator('.cpv2-shell')).toBeVisible({timeout:10000});
    await expect(page.locator('.cpv2-card')).toHaveCount(6);
    const geometry=await page.evaluate(()=>{
      const doc=document.documentElement;
      const cards=[...document.querySelectorAll('.cpv2-card')].map(e=>e.getBoundingClientRect());
      const outside=cards.filter(r=>r.left<-1||r.right>innerWidth+1);
      return {sw:doc.scrollWidth,w:innerWidth,outside};
    });
    expect(geometry.sw).toBeLessThanOrEqual(geometry.w+2);
    expect(geometry.outside).toEqual([]);
    await page.screenshot({path:testInfo.outputPath(`ui12-${viewport.label}.png`),fullPage:true});
  });
}

test('UI-12 keyboard focus is visible and core interactive targets meet 44px minimum',async({page})=>{
  await page.setViewportSize({width:1440,height:900});
  await page.goto('/',{waitUntil:'domcontentloaded'});
  const conformity=page.locator('.cpv2-conformity');
  await conformity.focus();
  const focus=await conformity.evaluate(e=>{const s=getComputedStyle(e);return {outline:s.outlineStyle,width:parseFloat(s.outlineWidth||'0')};});
  expect(focus.outline).not.toBe('none');
  expect(focus.width).toBeGreaterThanOrEqual(2);

  const targetViolations=await page.evaluate(()=>{
    const selectors=['.cpv2-conformity','.cpv2-link','.cpv2-policy-close'];
    return selectors.flatMap(selector=>[...document.querySelectorAll(selector)].filter(e=>{
      const s=getComputedStyle(e),r=e.getBoundingClientRect();
      return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0&&(r.height<44||r.width<44);
    }).map(e=>({selector,tag:e.tagName,w:e.getBoundingClientRect().width,h:e.getBoundingClientRect().height})));
  });
  expect(targetViolations).toEqual([]);
});

test('UI-12 core text contrast meets WCAG AA for representative semantic tokens',async({page})=>{
  await page.setViewportSize({width:1440,height:900});
  await page.goto('/',{waitUntil:'domcontentloaded'});
  const results=await page.evaluate(()=>{
    const rgb=value=>{const m=value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);return m?[+m[1],+m[2],+m[3]]:null;};
    const lum=rgbv=>rgbv.map(v=>{v/=255;return v<=.03928?v/12.92:((v+.055)/1.055)**2.4}).reduce((a,v,i)=>a+v*[.2126,.7152,.0722][i],0);
    const ratio=(fg,bg)=>{const a=lum(fg),b=lum(bg),hi=Math.max(a,b),lo=Math.min(a,b);return (hi+.05)/(lo+.05);};
    const nodes=['.cpv2-state h1','.cpv2-state p','.cpv2-card-head h2','.cpv2-copy','.cpv2-proofbar b','.cpv2-policy-head h2'];
    return nodes.map(selector=>{
      const e=document.querySelector(selector);if(!e)return {selector,missing:true};
      const s=getComputedStyle(e);
      let bg=e.parentElement;
      while(bg&&getComputedStyle(bg).backgroundColor==='rgba(0, 0, 0, 0)')bg=bg.parentElement;
      const fg=rgb(s.color),background=rgb(getComputedStyle(bg||document.body).backgroundColor)||[5,8,13];
      return {selector,contrast:fg?ratio(fg,background):0,fontSize:parseFloat(s.fontSize),fontWeight:parseInt(s.fontWeight)||400};
    });
  });
  for(const result of results){
    expect(result.missing).not.toBe(true);
    const large=result.fontSize>=24||(result.fontSize>=18.66&&result.fontWeight>=700);
    expect(result.contrast).toBeGreaterThanOrEqual(large?3:4.5);
  }
});

test('UI-12 reduced-motion preference disables decorative transforms',async({page})=>{
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.setViewportSize({width:1440,height:900});
  await page.goto('/',{waitUntil:'domcontentloaded'});
  const card=page.locator('.cpv2-card').first();
  const style=await card.evaluate(e=>({duration:getComputedStyle(e).transitionDuration,transform:getComputedStyle(e).transform}));
  expect(style.duration).toMatch(/0s/);
  expect(style.transform).toBe('none');
});
