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
