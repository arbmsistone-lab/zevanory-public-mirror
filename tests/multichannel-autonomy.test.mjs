import { readFileSync } from "node:fs";
import { BLOG_CSS_PATH } from "../worker/blog-layout.mjs";
import test from "node:test";import assert from "node:assert/strict";
import {channelChecklist,ensureWeeklyBlog,ensureDailyBlog,BLOG_OWNER_APPROVAL_PREFIX,localContentDay,INDEXNOW_PUBLIC_KEY,publishTelegram,publishPinterest,renderBlogArticle,renderBlogIndex,longFormDailyArticle,renderChannelsPage,resolveChannelCredentials,runMultichannelAutonomy,brandPinterestCreative,PINTEREST_APPROVED_BRAND_PIN_URL} from "../worker/multichannel-autonomy.mjs";
const brandResponse=name=>new Response(readFileSync(new URL("../assets/brand/export/"+name,import.meta.url)),{status:200,headers:{"content-type":"image/png"}});
const kv=()=>{const m=new Map();return{m,get:async k=>m.get(k)||null,put:async(k,v)=>m.set(k,v)}};
async function approveDaily(env,at){
 const first=await ensureDailyBlog(env,at);
 if(first.latest)return first;
 assert.equal(first.reason,"awaiting_owner_approval");
 const day=localContentDay(at);
 await env.ZEVANORY_PRIVATE_ARTIFACTS.put(BLOG_OWNER_APPROVAL_PREFIX+day,JSON.stringify({approved:true,source:"owner",day,slug:first.draft.slug,digest:first.draft.digest,approvedAt:at.toISOString()}));
 return ensureDailyBlog(env,at);
}

test("missing credential blocks only its channel and verified channels leave dry_run",()=>{const rows=channelChecklist({META_ACCESS_TOKEN:"x",META_PAGE_ID:"p",INSTAGRAM_BUSINESS_ACCOUNT_ID:"i"});assert.equal(rows.find(x=>x.id==="blog").configured,true);assert.equal(rows.find(x=>x.id==="telegram").mode,"pending");assert.equal(rows.find(x=>x.id==="facebook").mode,"dry_run");const live=channelChecklist({META_ACCESS_TOKEN:"x",META_PAGE_ID:"p",INSTAGRAM_BUSINESS_ACCOUNT_ID:"i",META_APP_LIVE:"true"});assert.equal(live.find(x=>x.id==="facebook").mode,"active");});
test("CHANNEL_CREDENTIALS_JSON takes precedence and individual bindings remain a fallback",()=>{const bundled=resolveChannelCredentials({CHANNEL_CREDENTIALS_JSON:JSON.stringify({TELEGRAM_BOT_TOKEN:"bundle",TELEGRAM_CHANNEL_ID:"@zevanory"}),TELEGRAM_BOT_TOKEN:"legacy"});assert.equal(bundled.TELEGRAM_BOT_TOKEN,"bundle");assert.equal(channelChecklist({CHANNEL_CREDENTIALS_JSON:JSON.stringify({TELEGRAM_BOT_TOKEN:"bundle",TELEGRAM_CHANNEL_ID:"@zevanory"})}).find(x=>x.id==="telegram").configured,true);assert.equal(resolveChannelCredentials({TELEGRAM_BOT_TOKEN:"legacy"}).TELEGRAM_BOT_TOKEN,"legacy");});
test("channel bundle includes YouTube refresh without Google Business fields and IndexNow key is publishable",()=>{const bundled=resolveChannelCredentials({CHANNEL_CREDENTIALS_JSON:JSON.stringify({YOUTUBE_REFRESH_TOKEN:"refresh",GOOGLE_BUSINESS_ACCESS_TOKEN:"retired"})});assert.equal(bundled.YOUTUBE_REFRESH_TOKEN,"refresh");assert.equal(bundled.GOOGLE_BUSINESS_ACCESS_TOKEN,undefined);assert.match(INDEXNOW_PUBLIC_KEY,/^[a-f0-9]{32,128}$/);});
test("R117 legacy weekly entrypoint cannot publish without owner",async()=>{
 const store=kv(),env={ZEVANORY_PRIVATE_ARTIFACTS:store};
 const out=await ensureWeeklyBlog(env,new Date("2026-10-07T12:00:00Z"));
 assert.equal(out.created.length,0);assert.equal(out.reason,"legacy_publisher_disabled");
 assert.equal(await store.get("zpc:blog:index:v1"),null);
});
test("official Telegram and Pinterest adapters return real provider evidence", async()=>{
 const calls=[],fetchImpl=async url=>{calls.push(url);throw Error("network forbidden")};await assert.rejects(publishTelegram({env:{TELEGRAM_BOT_TOKEN:"x",TELEGRAM_CHANNEL_ID:"@zevanory"},payload:{content:"x",media_url:"https://zevanory.api.br/brand/export/post-01.png"},fetchImpl}),/dec22_draft_only/);await assert.rejects(publishPinterest({env:{PINTEREST_ACCESS_TOKEN:"x",PINTEREST_BOARD_ID:"board"},payload:{content:"x"},fetchImpl}),/dec22_draft_only/);assert.deepEqual(calls,[]);
});

test("private Sistema channels checklist contains exact Pinterest fields and replaces Google Business with Search Console",async()=>{const html=await renderChannelsPage({META_ACCESS_TOKEN:"x",META_PAGE_ID:"p",INSTAGRAM_BUSINESS_ACCOUNT_ID:"i"});assert.match(html,/Sistema/);assert.match(html,/TELEGRAM_BOT_TOKEN/);assert.match(html,/YOUTUBE_CLIENT_ID/);assert.match(html,/PINTEREST_ACCESS_TOKEN/);assert.match(html,/PINTEREST_BOARD_ID/);assert.match(html,/pins:write/);assert.match(html,/boards:write/);assert.match(html,/developers\.pinterest\.com\/apps\//);assert.match(html,/Google Search Console \+ Blog/);assert.doesNotMatch(html,/Google Perfil da Empresa/);assert.doesNotMatch(html,/GOOGLE_BUSINESS_/);assert.match(html,/Aguardando verificação da empresa \(em análise\)/);assert.match(html,/Pendente credencial/);assert.match(html,/developers\.facebook\.com/);});
test("DEC-21 60 consecutive days create distinct PRIVATE drafts and never publish",async()=>{
const store=kv(),writes=[],wrapped={get:store.get,put:async(k,v)=>{writes.push(k);await store.put(k,v)}};
 const env={ZEVANORY_PRIVATE_ARTIFACTS:wrapped,PUBLIC_BASE_URL:"https://zevanory.api.br",BLOG_AUTOPUBLISH:"true",INDEXNOW_KEY:"fake"};
 const slugs=[];
 for(let i=0;i<60;i++){
   const at=new Date(Date.UTC(2026,9,11+i,15)),out=await ensureDailyBlog(env,at,async()=>{throw Error("IndexNow forbidden")});
   const day=localContentDay(at);
   assert.equal(out.reason,"draft_only_publication_disabled","day "+i);
   assert.deepEqual(out.created,[]);
   assert.ok(out.draft.digest.length===64);
   const saved=JSON.parse(await store.get("zpc:blog:draft:v1:"+day));
   assert.equal(saved.article.status,"pending_owner_approval");
   assert.equal(saved.article.publishedAt,null);
   assert.equal(saved.article.cta_url,null);
   slugs.push(out.draft.slug);
 }
 assert.equal(new Set(slugs).size,60);
 assert.ok(writes.every(k=>k.startsWith("zpc:blog:draft:v1:")),"only private draft writes");
 assert.equal(await store.get("zpc:blog:index:v1"),null);
 assert.equal(await store.get("zpc:blog:daily:"+localContentDay(new Date(Date.UTC(2026,9,11,15)))),null);
});

test("DEC-21 same Fortaleza day has same private draft, subsequent day different, zero public writes",async()=>{
const store=kv(),writes=[],wrapped={get:store.get,put:async(k,v)=>{writes.push(k);await store.put(k,v)}};
 const env={ZEVANORY_PRIVATE_ARTIFACTS:wrapped,PUBLIC_BASE_URL:"https://zevanory.api.br",BLOG_AUTOPUBLISH:"true",INDEXNOW_KEY:"fake"};
 const first=await ensureDailyBlog(env,new Date("2026-10-08T12:00:00Z"),async()=>{throw Error("IndexNow must not run")});
 const repeat=await ensureDailyBlog(env,new Date("2026-10-08T18:00:00Z"));
 const next=await ensureDailyBlog(env,new Date("2026-10-09T12:00:00Z"));
 for(const r of [first,repeat,next]){assert.equal(r.reason,"draft_only_publication_disabled");assert.deepEqual(r.created,[]);assert.equal(r.latest,null)}
 assert.equal(first.draft.digest,repeat.draft.digest);
 assert.notEqual(first.draft.slug,next.draft.slug);
 assert.equal(localContentDay(new Date("2026-10-09T01:00:00Z")),"2026-10-08");
 assert.ok(writes.every(k=>k.startsWith("zpc:blog:draft:v1:")));
 assert.equal(await store.get("zpc:blog:index:v1"),null);
 assert.equal(await store.get("zpc:blog:daily:2026-10-08"),null);
 assert.equal(await store.get("zpc:blog:article:"+first.draft.slug),null);
 assert.equal(await store.get("zpc:blog:article:"+next.draft.slug),null);
});

test("DEC-21 historical published index immutable while later days remain draft-only",async()=>{
const store=kv(),env={ZEVANORY_PRIVATE_ARTIFACTS:store,BLOG_AUTOPUBLISH:"true",INDEXNOW_KEY:"fake"};
 const legacy=["ia-pratica-pequenos-negocios","automacao-atendimento-clareza","atendimento-servicos-varzea-alegre"].map((slug,i)=>({slug:slug+"-2026-10-0"+(7+i),title:slug,url:"https://zevanory.api.br/blog/"+slug,publishedAt:"2026-10-0"+(7+i)+"T03:00:00Z",body:longFormDailyArticle({slug,title:slug},"2026-10-10").body}));
 const stable=JSON.stringify({articles:legacy});await store.put("zpc:blog:index:v1",stable);
 const writes=[],wrapped={get:store.get,put:async(k,v)=>{writes.push(k);await store.put(k,v)}};env.ZEVANORY_PRIVATE_ARTIFACTS=wrapped;
 for(const d of ["2026-10-12","2026-10-13","2026-10-14","2026-10-15","2026-10-16"]){
  const out=await ensureDailyBlog(env,new Date(d+"T12:30:00Z"),async()=>{throw Error("IndexNow forbidden")});
  assert.equal(out.reason,"draft_only_publication_disabled",d);
  assert.deepEqual(out.created,[]);
  assert.equal(await store.get("zpc:blog:article:"+out.draft.slug),null);
  assert.equal(await store.get("zpc:blog:daily:"+d),null);
 }
 assert.equal(await store.get("zpc:blog:index:v1"),stable,"historical index unchanged");
 assert.ok(writes.every(k=>k.startsWith("zpc:blog:draft:v1:")));
});

test("blog index lists newest first with a readable Sao Paulo date",async()=>{
  const store=kv();
  await store.put("zpc:blog:index:v1",JSON.stringify({articles:[{slug:"old",title:"Antigo",description:"a",publishedAt:"2026-10-07T20:00:32.000Z"},{slug:"new",title:"Novo",description:"b",publishedAt:"2026-10-11T12:25:00.000Z"}]}));
  const html=await renderBlogIndex({ZEVANORY_PRIVATE_ARTIFACTS:store});
  assert.ok(html.indexOf("/blog/new")<html.indexOf("/blog/old"));
  assert.match(html,/11\/10\/2026/);
  assert.equal((html.match(/<article>/g)||[]).length,2);
});
test("legacy hourly cycle never publishes Telegram or creates the blog article (single engine)",async()=>{
  const store=kv(),calls=[];
  const env={ZEVANORY_PRIVATE_ARTIFACTS:store,TELEGRAM_BOT_TOKEN:"s",TELEGRAM_CHANNEL_ID:"@zevanory"};
  const fetchImpl=async (url,options)=>{calls.push(String(url));return new Response(JSON.stringify({ok:true,result:{message_id:9}}),{status:200});};
  // 03:00Z = 00:00 Sao Paulo, the slot where the legacy post used to pre-empt 12:00.
  for(const at of ["2026-10-11T03:00:00Z","2026-10-11T15:00:00Z"]){
    const out=await runMultichannelAutonomy(env,new Date(at),fetchImpl);
    assert.equal(out.blog.created.length,0);assert.equal(out.blog.reason,"acquisition_engine_owned");
  }
  assert.equal(calls.filter(u=>u.includes("api.telegram.org")).length,0);
  assert.equal(await store.get("zpc:multichannel:evidence:telegram:daily:2026-10-11"),null);
  assert.equal(await store.get("zpc:blog:daily:2026-10-11"),null);
});
test("legacy cycle surfaces the engine Telegram receipt and the latest article as evidence",async()=>{
  const store=kv();
  await store.put("zpc:acquisition:daily:2026-10-12:telegram",JSON.stringify({channel:"telegram",status:"publicado",provider_post_id:"12",url:"https://t.me/zevanory/12",at:"2026-10-12T15:25:01.000Z"}));
  await store.put("zpc:blog:index:v1",JSON.stringify({articles:[{slug:"a",url:"https://zevanory.api.br/blog/a",publishedAt:"2026-10-11T12:25:00Z"},{slug:"b",url:"https://zevanory.api.br/blog/b",publishedAt:"2026-10-12T12:25:00Z"}]}));
  const out=await runMultichannelAutonomy({ZEVANORY_PRIVATE_ARTIFACTS:store},new Date("2026-10-12T16:00:00Z"),async()=>{throw new Error("no network expected")});
  assert.equal(out.blog.latest.slug,"b");
  assert.deepEqual(out.evidence.map(e=>e.url),["https://t.me/zevanory/12"]);
  assert.equal(JSON.parse(await store.get("zpc:multichannel:state:v1")).evidence.length,1);
});
test("telegram photo caption stays within the 1024-char Bot API limit", async()=>{
 const calls=[],fetchImpl=async url=>{calls.push(url);throw Error("network forbidden")};await assert.rejects(publishTelegram({env:{TELEGRAM_BOT_TOKEN:"x",TELEGRAM_CHANNEL_ID:"@zevanory"},payload:{content:"x",media_url:"https://zevanory.api.br/brand/export/post-01.png"},fetchImpl}),/dec22_draft_only/);await assert.rejects(publishPinterest({env:{PINTEREST_ACCESS_TOKEN:"x",PINTEREST_BOARD_ID:"board"},payload:{content:"x"},fetchImpl}),/dec22_draft_only/);assert.deepEqual(calls,[]);
});

test("telegram falls back to a text message when the photo is refused with 400, never on other errors", async()=>{
 const calls=[],fetchImpl=async url=>{calls.push(url);throw Error("network forbidden")};await assert.rejects(publishTelegram({env:{TELEGRAM_BOT_TOKEN:"x",TELEGRAM_CHANNEL_ID:"@zevanory"},payload:{content:"x",media_url:"https://zevanory.api.br/brand/export/post-01.png"},fetchImpl}),/dec22_draft_only/);await assert.rejects(publishPinterest({env:{PINTEREST_ACCESS_TOKEN:"x",PINTEREST_BOARD_ID:"board"},payload:{content:"x"},fetchImpl}),/dec22_draft_only/);assert.deepEqual(calls,[]);
});

test("legacy Telegram receipts from before the cutover remain visible as evidence",async()=>{
  const store=kv();
  await store.put("zpc:multichannel:evidence:telegram:daily:2026-10-10",JSON.stringify({channel:"telegram",creative_id:"daily:2026-10-10",provider_post_id:"6",url:"https://t.me/zevanory/6",publishedAt:"2026-10-10T03:00:06.000Z"}));
  const out=await runMultichannelAutonomy({ZEVANORY_PRIVATE_ARTIFACTS:store},new Date("2026-10-11T12:00:00Z"),async()=>{throw new Error("no network")});
  assert.deepEqual(out.evidence.map(e=>e.provider_post_id),["6"]);
});
test("Telegram resolves a public t.me URL even when configured with numeric chat ID", async()=>{
 const calls=[],fetchImpl=async url=>{calls.push(url);throw Error("network forbidden")};await assert.rejects(publishTelegram({env:{TELEGRAM_BOT_TOKEN:"x",TELEGRAM_CHANNEL_ID:"@zevanory"},payload:{content:"x",media_url:"https://zevanory.api.br/brand/export/post-01.png"},fetchImpl}),/dec22_draft_only/);await assert.rejects(publishPinterest({env:{PINTEREST_ACCESS_TOKEN:"x",PINTEREST_BOARD_ID:"board"},payload:{content:"x"},fetchImpl}),/dec22_draft_only/);assert.deepEqual(calls,[]);
});

test("Pinterest F1 dynamic editorial is published with the official hashed Z image", async()=>{
 const store=kv(),creative={creative_id:"f1",status:"approved_for_autopublish",compliance:100,score:92,offer_id:"ZEV-IA-011",product:"ZEVANORY IA na Prática",price_brl:97,brand:"ZEVANORY",asset_url:"https://example.test/img",content:"editorial",landing_url:"https://vendas.zevanory.api.br/ia-na-pratica"};await store.put("zpc:creative-autonomy:feed:v1",JSON.stringify([creative]));const calls=[];const out=await runMultichannelAutonomy({ZEVANORY_PRIVATE_ARTIFACTS:store,PINTEREST_BOARD_ID:"x",PINTEREST_ACCESS_TOKEN:"x"},new Date("2026-10-10T18:00:00Z"),async url=>{calls.push(url);throw Error("provider forbidden")});assert.deepEqual(calls,[]);assert.equal(out.evidence.some(x=>x.channel==="pinterest"),false);const d=JSON.parse(await store.get("zpc:channel:draft:v1:pinterest:f1"));assert.equal(d.approved,false);
});

test("DEC-21 draft is never published; historical article links still reach real destinations",async()=>{
  const { attribution } = await import("../worker/sales-public-worker.mjs");
  // C-03: the article now wears the shared site shell (worker/blog-layout.mjs): header nav (catalogue, guides),
  // institutional footer links, the skip link (#conteudo) and the Worker-served stylesheet. They are the
  // only additions to the allowed destinations; the article CTAs below keep every original assertion.
  const salesPages = new Set(["material-gratuito","ia-por-ramo","conteudo-pronto","ia-na-pratica","vendas-na-pratica","lucro-e-caixa","combo-ia-vendas","negocio-completo","solucoes","quem-criou","termos","privacidade","reembolso"]);
  const apexPaths = new Set(["/blog",BLOG_CSS_PATH]);
  const store=kv(),env={ZEVANORY_PRIVATE_ARTIFACTS:store,PUBLIC_BASE_URL:"https://zevanory.api.br",BLOG_AUTOPUBLISH:"true"};
  const out=await ensureDailyBlog(env,new Date("2026-10-14T12:00:00Z"));
  assert.equal(out.reason,"draft_only_publication_disabled");
  assert.equal(await store.get("zpc:blog:index:v1"),null);
  assert.equal(await store.get("zpc:blog:article:"+out.draft.slug),null);
  const archived=JSON.parse(await store.get("zpc:blog:draft:v1:2026-10-14")).article;
  const real={...archived,slug:out.draft.slug,publishedAt:"2026-10-14T12:00:00Z",status:"published"};
  // Explicit historical article fixture, NOT written by ensureDailyBlog.
  await store.put("zpc:blog:article:"+real.slug,JSON.stringify(real));
  assert.ok(real.slug.length>48,"fixture must reproduce a slug longer than the funnel limit");
  const legacy={...real,slug:"artigo-antigo-sem-dia-"+"x".repeat(80)+"-\"><script>",day:undefined};
  await store.put("zpc:blog:article:legacy",JSON.stringify(legacy));
  for (const [slug, expectCamp] of [[real.slug,"blog_20261014"],["legacy",null]]) {
    const html=await renderBlogArticle(env,slug);
    assert.doesNotMatch(html,/<script>/,"slug content never reaches markup unescaped");
    const hrefs=[...html.matchAll(/href="([^"]+)"/g)].map(m=>m[1].replace(/&amp;/g,"&"));
    const material=hrefs.filter(h=>h.includes("material-gratuito"));
    assert.equal(material.length,1);
    assert.match(material[0],/^https:\/\/vendas\.zevanory\.api\.br\/material-gratuito\?/,"free material must point at the sales host");
    for (const h of hrefs) {
      if (h==="#conteudo") continue;
      if (h.startsWith("/")) { assert.ok(apexPaths.has(h)||h.startsWith("/brand/export/"),"unexpected relative link "+h); continue; }
      if (/^(mailto:|https:\/\/wa\.me\/)/.test(h)) continue;
      const u=new URL(h);
      assert.ok(["zevanory.api.br","vendas.zevanory.api.br"].includes(u.hostname),h);
      if (u.hostname==="vendas.zevanory.api.br") {
        const page=u.pathname.slice(1);
        assert.ok(salesPages.has(page)||/^comprar\/ZEV-[A-Z0-9-]+$/.test(page),"sales destination "+page);
      }
      const camp=u.searchParams.get("utm_campaign");
      if (camp!==null) {
        assert.match(camp,/^[a-z0-9_-]{1,48}$/,"campaign "+camp);
        assert.equal(attribution(new Request(h),u).camp,camp,"funnel keeps the campaign");
        if (expectCamp) assert.equal(camp,expectCamp);
      }
    }
  }
});
