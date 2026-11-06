import test from "node:test";
import assert from "node:assert/strict";
import {handleR120PublicChat} from "../worker/r120-chat-public.mjs";
const req=(host,path,method,origin,headers={})=>new Request("https://"+host+path,{method,headers:{"origin":origin,...headers},body:method==="POST"?"{}":undefined});
test("R120 central API cannot be hosted on unrelated domain or arbitrary path",async()=>{
 assert.equal(await handleR120PublicChat(req("evil.example","/api/chat","GET","https://evil.example")),null);
 assert.equal(await handleR120PublicChat(req("zevanory.api.br","/api/chat/admin","GET","https://zevanory.api.br")),null);
});
test("R120 CORS preflight only permits two owned origins",async()=>{
 for(const origin of ["https://zevanory.api.br","https://vendas.zevanory.api.br"]){
  const res=await handleR120PublicChat(req("zevanory.api.br","/api/chat","OPTIONS",origin));
  assert.equal(res.status,204);
  assert.equal(res.headers.get("access-control-allow-origin"),origin);
 }
 const blocked=await handleR120PublicChat(req("zevanory.api.br","/api/chat","OPTIONS","https://evil.example"));
 assert.equal(blocked.status,403);
 assert.equal(blocked.headers.get("access-control-allow-origin"),null);
});
test("R120 POST without owned Origin or valid JSON content type is denied",async()=>{
 const noOrigin=await handleR120PublicChat(req("zevanory.api.br","/api/chat","POST",""));
 assert.equal(noOrigin.status,403);
 const wrong=await handleR120PublicChat(req("zevanory.api.br","/api/chat","POST","https://zevanory.api.br",{"content-type":"text/plain"}));
 assert.equal(wrong.status,415);
});
test("R120 API rejects unsupported methods and oversized input before touching database",async()=>{
 const method=await handleR120PublicChat(req("zevanory.api.br","/api/chat/status","POST","https://zevanory.api.br"));
 assert.equal(method.status,405);
 const size=await handleR120PublicChat(req("zevanory.api.br","/api/chat","POST","https://zevanory.api.br",{"content-type":"application/json","content-length":"5000"}));
 assert.equal(size.status,413);
});
