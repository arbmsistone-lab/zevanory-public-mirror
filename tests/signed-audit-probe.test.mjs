import test from "node:test";
import assert from "node:assert/strict";
import {verifySignedAuditProbe} from "../worker/signed-audit-probe.mjs";
const secret="a-private-test-only-string-not-a-production-secret-value".repeat(2);
async function signed(path,when){
 const ts=String(Math.floor(when/1000));
 const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 const bytes=await crypto.subtle.sign("HMAC",key,new TextEncoder().encode("GET\n"+path+"\n"+ts));
 const hex=[...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,"0")).join("");
 return new Request("https://zevanory.api.br"+path,{headers:{"x-zevanory-audit-ts":ts,"x-zevanory-audit-signature":hex}});
}
test("signed read only probe accepted for status and 2 audit endpoints",async()=>{
 const t=Date.parse("2026-10-08T18:20:00Z");
 for(const path of ["/api/status","/api/internal/audit/runtime-identity","/api/internal/audit/financial-classification"]){
  assert.equal(await verifySignedAuditProbe(await signed(path,t),{CERTIFICATION_E2E_TOKEN:secret},{now:t}),true,path);
 }
});
test("HMAC fails closed on wrong path, 5-minute expiry, bad key, modified route",async()=>{
 const t=Date.parse("2026-10-08T18:20:00Z");
 assert.equal(await verifySignedAuditProbe(await signed("/api/events/operator",t),{CERTIFICATION_E2E_TOKEN:secret},{now:t}),false);
 assert.equal(await verifySignedAuditProbe(await signed("/api/status",t-301000),{CERTIFICATION_E2E_TOKEN:secret},{now:t}),false);
 assert.equal(await verifySignedAuditProbe(await signed("/api/status",t),{CERTIFICATION_E2E_TOKEN:"b".repeat(64)},{now:t}),false);
 const req=await signed("/api/status",t);
 const post=new Request(req,{method:"POST"});
 assert.equal(await verifySignedAuditProbe(post,{CERTIFICATION_E2E_TOKEN:secret},{now:t}),false);
});
