#!/usr/bin/env node
// NC-011 N1. Read-only CP production KV census, requires independently approved
// execution in an authenticated owner's terminal. This script is NOT run in CI.
// No key values fetched, no KV writes, no account IDs/tokens logged.
const BASE="https://api.cloudflare.com/client/v4";
const PREFIXES=["zpc:cp:sub:","zpc:cp:txn:","zpc:cp:token:","zpc:cp:pkg:"];
const account=process.env.CF_ACCOUNT_ID,namespace=process.env.CF_KV_NAMESPACE_ID,token=process.env.CLOUDFLARE_API_TOKEN;
if(process.argv.slice(2).join(" ")!=="--read-only")throw Error("PASS_EXPLICIT_READ_ONLY_FLAG");
if(!account||!namespace||!token)throw Error("MISSING_READ_ONLY_CLOUDFLARE_ENV");
if(!/^[a-f0-9]{32}$/i.test(account)||!/^[a-f0-9]{32}$/i.test(namespace))throw Error("INVALID_ACCOUNT_OR_NAMESPACE_ID");
const counts={};
for(const prefix of PREFIXES){
 let total=0,cursor="",pages=0;
 const seen=new Set();
 do{
  const u=new URL(BASE+"/accounts/"+account+"/storage/kv/namespaces/"+namespace+"/keys");
  u.searchParams.set("prefix",prefix);u.searchParams.set("limit","1000");
  if(cursor)u.searchParams.set("cursor",cursor);
  const r=await fetch(u,{method:"GET",headers:{Authorization:"Bearer "+token,Accept:"application/json"},redirect:"error",signal:AbortSignal.timeout(20000)});
  if(!r.ok)throw Error("CLOUDFLARE_READ_FAILED_"+r.status+"_PREFIX_"+prefix);
  const body=await r.json();
  if(body.success!==true||!Array.isArray(body.result))throw Error("CLOUDFLARE_RESPONSE_UNVERIFIED_"+prefix);
  for(const item of body.result){
   if(typeof item.name!=="string"||!item.name.startsWith(prefix))throw Error("CLOUDFLARE_PREFIX_MISMATCH_"+prefix);
   total++;
  }
  const next=body.result_info?.cursor||"";
  if(next&&seen.has(next))throw Error("CLOUDFLARE_CURSOR_LOOP_"+prefix);
  if(next)seen.add(next);cursor=next;
  pages++;
  if(pages>100000)throw Error("CLOUDFLARE_PAGE_LIMIT_"+prefix);
 }while(cursor);
 counts[prefix]=total;
 console.log("CP_KV_READ_ONLY "+JSON.stringify({prefix,count:total,pages}));
}
const zero=Object.values(counts).every(v=>v===0);
console.log("NC011_CP_PREFIXES="+JSON.stringify(counts));
console.log("NC011_ZERO_SUBSCRIBERS_AND_LEGACY_KEYS="+(zero?"CONFIRMED_AT_READ_TIME":"NOT_CONFIRMED"));
if(!zero)process.exitCode=2;
