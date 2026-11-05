// R123 candidate browser audit. Requires locally installed playwright + axe-core.
// No external network, only an in-memory HTTP route and local first-party asset files.
import {readFileSync} from "node:fs";
import assert from "node:assert/strict";
import {createRequire} from "node:module";
const require=createRequire(import.meta.url);
const {chromium}=require("playwright");
const axe=readFileSync(require.resolve("axe-core/axe.min.js"),"utf8");
const js=readFileSync(new URL("../sales-overlay/site-chat.js",import.meta.url),"utf8");
const css=readFileSync(new URL("../sales-overlay/site-chat.css",import.meta.url),"utf8");
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage({viewport:{width:360,height:740},deviceScaleFactor:1});
 await page.addInitScript(()=>{window.turnstile={render(_container,args){queueMicrotask(()=>args.callback("synthetic-turnstile-token"));return "mock-id"}}});
 await page.route("https://zevanory.api.br/**",async(route)=>{
  const u=new URL(route.request().url());
  if(u.pathname==="/api/chat/status")return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({notice:{who_answers:"Você está falando com um assistente virtual.",privacy_href:"/privacidade"},idle_minutes:30,message_max_chars:600,turnstile_sitekey:"test_R123_key"})});
  if(u.pathname==="/api/chat/session")return route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({session:"sbx_"+ "a".repeat(43),idle_minutes:30})});
  return route.fulfill({status:200,contentType:"text/html",body:'<!doctype html><html lang="pt-BR"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main><h1>Atendimento ZEVANORY</h1></main><footer>Contato</footer></body></html>'});
 });
 await page.goto("https://zevanory.api.br/__r123__/browser",{waitUntil:"domcontentloaded"});
 await page.addStyleTag({content:css});await page.addScriptTag({content:js});
 const open=page.getByRole("button",{name:"Fale com a ZEVANORY"});
 await open.click();
 await page.getByText("Você está falando com um assistente virtual.").waitFor();
 await page.getByRole("button",{name:"Começar conversa"}).waitFor({state:"visible"});
 await page.getByRole("button",{name:"Começar conversa"}).click();
 await page.getByRole("button",{name:"Falar com uma pessoa"}).click();
 assert.equal(await page.locator("#zc-privacy-ack").isChecked(),false);
 const width=await page.evaluate(()=>document.documentElement.scrollWidth);
 assert.ok(width<=360,"horizontal overflow at 360 px:"+width);
 await page.evaluate(axe);
 const issues=await page.evaluate(async()=>{const r=await window.axe.run(document,{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21aa","wcag22aa"]}});return r.violations.filter(x=>["serious","critical"].includes(x.impact)).map(x=>x.id)});
 assert.deepEqual(issues,[],"axe serious/critical violations");
 await page.keyboard.press("Escape");
 assert.equal(await page.locator("#zc-panel").isVisible(),false);
 console.log("R123_BROWSER_360_AXE=PASS; major issues=0; button, consent, Escape=PASS");
}finally{await browser.close()}
