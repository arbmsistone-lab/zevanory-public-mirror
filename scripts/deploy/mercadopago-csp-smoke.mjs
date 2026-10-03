import { chromium } from 'playwright';
const checkout='https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=3670768257-f4236a66-96f6-49fc-ba1c-2587780b36e2';
const browser=await chromium.launch({headless:true});
const page=await browser.newPage();
const csp=[];
page.on('console',m=>{const t=m.text();if(/content security policy|refused to (load|connect|frame|execute)|csp/i.test(t))csp.push(t)});
await page.goto('https://zevanory.api.br/solucoes',{waitUntil:'domcontentloaded',timeout:30000});
await Promise.all([
  page.waitForURL(u=>/mercadopago\.com(?:\.br)?$/i.test(new URL(u).hostname),{waitUntil:'domcontentloaded',timeout:45000}),
  page.evaluate(url=>{location.href=url},checkout),
]);
if(!/mercadopago\.com(?:\.br)?$/i.test(new URL(page.url()).hostname)) throw new Error('mercadopago_navigation_failed:'+page.url());
if(/\/fatal(?:\?|$)/i.test(new URL(page.url()).pathname)) throw new Error('mercadopago_fatal:'+page.url());
if(csp.length) throw new Error('csp_console_block:'+JSON.stringify(csp.slice(0,10)));
console.log('MERCADOPAGO_CHECKOUT_CSP_SMOKE=PASS '+page.url());
await browser.close();
