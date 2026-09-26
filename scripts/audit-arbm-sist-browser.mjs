import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const axePath=require.resolve('axe-core/axe.min.js');
const contract=JSON.parse(fs.readFileSync('arbm-sist/ped-versal-contract.json','utf8'));
const base=process.env.ARBM_SIST_AUDIT_URL || 'http://127.0.0.1:4173/zevanory-public-mirror/arbm-sist/';
const browser=await chromium.launch({headless:true});
const evidence=[];
let failed=false;

function pushFail(row, code, detail){
  row.failures.push({code,detail});
  failed=true;
}

for(const viewport of contract.ui.viewports){
  for(const theme of contract.ui.themes){
    const context=await browser.newContext({
      viewport:{width:viewport.width,height:viewport.height},
      colorScheme:theme,
      reducedMotion:'reduce',
    });
    const page=await context.newPage();
    const consoleErrors=[];
    page.on('console',msg=>{if(msg.type()==='error')consoleErrors.push(msg.text())});
    page.on('pageerror',err=>consoleErrors.push(String(err)));
    await page.addInitScript(t=>{try{localStorage.setItem('zevanory-theme',t)}catch{}},theme);
    const response=await page.goto(base,{waitUntil:'networkidle',timeout:30000});
    const row={viewport,theme,httpStatus:response?.status()||0,failures:[],checks:{}};

    if(!response || !response.ok()) pushFail(row,'http_status',String(response?.status()));
    const title=await page.title();
    if(!title.includes('ARBM SIST')) pushFail(row,'title',title);

    const dom=await page.evaluate(()=>{
      const de=document.documentElement;
      const body=document.body;
      const visible=[...document.querySelectorAll('header *, main *, footer *')].filter(el=>{
        const s=getComputedStyle(el); const r=el.getBoundingClientRect();
        return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0;
      });
      const bad=visible.map(el=>{const r=el.getBoundingClientRect();return {tag:el.tagName,cls:String(el.className),left:r.left,right:r.right,width:r.width};})
        .filter(x=>x.left < -1 || x.right > de.clientWidth+1).slice(0,30);
      const hero=document.querySelector('.hero-copy');
      const h1=document.querySelector('.hero h1');
      const root=getComputedStyle(document.documentElement);
      const resources=performance.getEntriesByType('resource').map(x=>x.name);
      return {
        textLength:body.innerText.trim().length,
        overflowX:de.scrollWidth>de.clientWidth+1,
        scrollWidth:de.scrollWidth,
        clientWidth:de.clientWidth,
        bad,
        theme:document.documentElement.dataset.theme||'system',
        bg:root.getPropertyValue('--bg-primary').trim(),
        text:root.getPropertyValue('--text-primary').trim(),
        heroFont:hero?getComputedStyle(hero).fontSize:'',
        h1Font:h1?getComputedStyle(h1).fontSize:'',
        resources,
        cssLegacy:resources.some(x=>x.endsWith('/product.css')),
        cssDedicated:resources.some(x=>x.includes('/arbm-sist/arbm-sist.css')),
      };
    });
    row.checks.dom=dom;
    if(dom.textLength<1200) pushFail(row,'content_too_short',String(dom.textLength));
    if(dom.overflowX) pushFail(row,'horizontal_overflow',JSON.stringify({scrollWidth:dom.scrollWidth,clientWidth:dom.clientWidth}));
    if(dom.bad.length) pushFail(row,'element_outside_viewport',JSON.stringify(dom.bad));
    if(dom.cssLegacy) pushFail(row,'legacy_css_loaded','product.css');
    if(!dom.cssDedicated) pushFail(row,'dedicated_css_missing','arbm-sist.css');
    if(dom.theme!==theme) pushFail(row,'theme_not_applied',dom.theme);
    const expectedTokens=contract.ui.tokens[theme];
    if(dom.bg.toUpperCase()!==expectedTokens['bg-primary'].toUpperCase()) pushFail(row,'bg_token_runtime',dom.bg);
    if(dom.text.toUpperCase()!==expectedTokens['text-primary'].toUpperCase()) pushFail(row,'text_token_runtime',dom.text);
    if(dom.heroFont!=='16px') pushFail(row,'body_font_runtime',dom.heroFont);
    const expectedH1=viewport.width<=704?'28px':'37px';
    if(dom.h1Font!==expectedH1) pushFail(row,'h1_font_runtime',dom.h1Font);

    await page.addScriptTag({path:axePath});
    const axe=await page.evaluate(async()=>await axe.run(document,{
      runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag2aaa','wcag21aa','wcag22aa']}
    }));
    row.checks.axe={violations:axe.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.length,help:v.help}))};
    if(axe.violations.length) pushFail(row,'axe',JSON.stringify(row.checks.axe.violations));

    await page.keyboard.press('Tab');
    const focus=await page.evaluate(()=>{
      const el=document.activeElement; const s=getComputedStyle(el);
      const r=el.getBoundingClientRect();
      return {tag:el?.tagName,cls:String(el?.className||''),outlineWidth:s.outlineWidth,outlineStyle:s.outlineStyle,boxShadow:s.boxShadow,left:r.left,top:r.top,right:r.right,bottom:r.bottom};
    });
    row.checks.keyboardFocus=focus;
    if(!focus.cls.includes('skip-link')) pushFail(row,'skip_link_focus',JSON.stringify(focus));
    const hasOutline=parseFloat(focus.outlineWidth||'0')>=4 && focus.outlineStyle!=='none';
    const hasShadow=focus.boxShadow && focus.boxShadow!=='none';
    if(!hasOutline && !hasShadow) pushFail(row,'focus_ring_missing',JSON.stringify({outlineWidth:focus.outlineWidth,outlineStyle:focus.outlineStyle,boxShadow:focus.boxShadow}));

    const overlap=await page.evaluate(()=>{
      const a=document.querySelector('.skip-link')?.getBoundingClientRect();
      const b=document.querySelector('.theme-toggle')?.getBoundingClientRect();
      if(!a||!b)return {overlap:false};
      return {overlap:!(a.right<=b.left||b.right<=a.left||a.bottom<=b.top||b.bottom<=a.top),skip:{left:a.left,top:a.top,right:a.right,bottom:a.bottom},toggle:{left:b.left,top:b.top,right:b.right,bottom:b.bottom}};
    });
    row.checks.skipLinkOverlap=overlap;
    if(overlap.overlap) pushFail(row,'skip_link_overlaps_theme_toggle',JSON.stringify(overlap));
    await page.keyboard.press('Tab');

    const toggle=page.locator('.theme-toggle');
    await toggle.click();
    const toggled=await page.evaluate(()=>({theme:document.documentElement.dataset.theme,label:document.querySelector('.theme-toggle')?.getAttribute('aria-label')}));
    row.checks.themeToggle=toggled;
    if(toggled.theme===theme) pushFail(row,'theme_toggle_no_change',JSON.stringify(toggled));
    await toggle.click();

    const firstFaq=page.locator('.faq details').first();
    const openBefore=await firstFaq.getAttribute('open');
    await firstFaq.locator('summary').click();
    const isOpen=await firstFaq.evaluate(el=>el.open);
    row.checks.faq={openBefore,isOpen};
    if(!isOpen) pushFail(row,'faq_interaction','details did not open');

    if(consoleErrors.length) pushFail(row,'console_errors',JSON.stringify(consoleErrors));
    row.checks.consoleErrors=consoleErrors;

    const filename=`arbm-sist-${viewport.width}x${viewport.height}-${theme}.png`;
    await page.screenshot({path:filename,fullPage:true});
    row.screenshot=filename;
    evidence.push(row);
    await context.close();
  }
}
await browser.close();
fs.writeFileSync('arbm-sist-browser-evidence.json',JSON.stringify({
  schema:'zevanory.ped-versal.arbm-sist.browser.v1',
  exactSha:process.env.GITHUB_SHA||process.env.BUILDKITE_COMMIT||'local',
  url:base,
  evidence
},null,2));
console.log(JSON.stringify(evidence.map(x=>({viewport:x.viewport,theme:x.theme,failures:x.failures})),null,2));
if(failed) process.exit(1);
console.log('ARBM_SIST_BROWSER_MATRIX=PASS');
