import test from "node:test";
import assert from "node:assert/strict";
import {brandedEmailHtml,OFFICIAL_EMAIL_IMAGE,OFFICIAL_LEGAL_FOOTER} from "../worker/brand-email.mjs";
test("all customer email HTML shells use the approved Z brand and exact legal identity",()=>{
 const h=brandedEmailHtml("Olá!\nConheça a solução.",{unsubscribeUrl:"https://zevanory.api.br/material-gratuito/descadastrar?t=abc"});
 assert.match(h,/ZEVANORY · Menos improviso\. Mais execução\./);
 assert.ok(h.includes(OFFICIAL_EMAIL_IMAGE));
 assert.ok(h.includes("69.077.233/0001-99"));
 assert.ok(h.includes("99254-5413"));
 assert.ok(h.includes("suporte@zevanory.api.br"));
 assert.match(h,/Descadastrar-se/);
 assert.ok(OFFICIAL_LEGAL_FOOTER.includes("Rua Francisco de Freitas Neto, 96"));
});
test("brand email HTML does not allow injected HTML or URL attributes",()=>{
 const h=brandedEmailHtml('<img src=x onerror=alert(1)>',{unsubscribeUrl:'https://a.example/?x=" onmouseover="bad'});
 assert.ok(!h.includes('<img src=x onerror=alert(1)>'));
 assert.ok(!h.includes(' onmouseover="bad'));
 assert.match(h,/&lt;img/);
 assert.match(h,/&quot;/);
});
