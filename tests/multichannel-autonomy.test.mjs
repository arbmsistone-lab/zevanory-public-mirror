import { readFileSync } from "node:fs";
import test from "node:test";import assert from "node:assert/strict";
import {channelChecklist,ensureWeeklyBlog,ensureDailyBlog,localContentDay,INDEXNOW_PUBLIC_KEY,publishTelegram,publishPinterest,renderBlogArticle,renderChannelsPage,resolveChannelCredentials,runMultichannelAutonomy,brandPinterestCreative,PINTEREST_APPROVED_BRAND_PIN_URL} from "../worker/multichannel-autonomy.mjs";
const brandResponse=name=>new Response(readFileSync(new URL("../assets/brand/export/"+name,import.meta.url)),{status:200,headers:{"content-type":"image/png"}});
const kv=()=>{const m=new Map();return{m,get:async k=>m.get(k)||null,put:async(k,v)=>m.set(k,v)}};
test("missing credential blocks only its channel and verified channels leave dry_run",()=>{const rows=channelChecklist({META_ACCESS_TOKEN:"x",META_PAGE_ID:"p",INSTAGRAM_BUSINESS_ACCOUNT_ID:"i"});assert.equal(rows.find(x=>x.id==="blog").configured,true);assert.equal(rows.find(x=>x.id==="telegram").mode,"pending");assert.equal(rows.find(x=>x.id==="facebook").mode,"dry_run");const live=channelChecklist({META_ACCESS_TOKEN:"x",META_PAGE_ID:"p",INSTAGRAM_BUSINESS_ACCOUNT_ID:"i",META_APP_LIVE:"true"});assert.equal(live.find(x=>x.id==="facebook").mode,"active");});
test("CHANNEL_CREDENTIALS_JSON takes precedence and individual bindings remain a fallback",()=>{const bundled=resolveChannelCredentials({CHANNEL_CREDENTIALS_JSON:JSON.stringify({TELEGRAM_BOT_TOKEN:"bundle",TELEGRAM_CHANNEL_ID:"@zevanory"}),TELEGRAM_BOT_TOKEN:"legacy"});assert.equal(bundled.TELEGRAM_BOT_TOKEN,"bundle");assert.equal(channelChecklist({CHANNEL_CREDENTIALS_JSON:JSON.stringify({TELEGRAM_BOT_TOKEN:"bundle",TELEGRAM_CHANNEL_ID:"@zevanory"})}).find(x=>x.id==="telegram").configured,true);assert.equal(resolveChannelCredentials({TELEGRAM_BOT_TOKEN:"legacy"}).TELEGRAM_BOT_TOKEN,"legacy");});
test("channel bundle includes YouTube refresh without Google Business fields and IndexNow key is publishable",()=>{const bundled=resolveChannelCredentials({CHANNEL_CREDENTIALS_JSON:JSON.stringify({YOUTUBE_REFRESH_TOKEN:"refresh",GOOGLE_BUSINESS_ACCESS_TOKEN:"retired"})});assert.equal(bundled.YOUTUBE_REFRESH_TOKEN,"refresh");assert.equal(bundled.GOOGLE_BUSINESS_ACCESS_TOKEN,undefined);assert.match(INDEXNOW_PUBLIC_KEY,/^[a-f0-9]{32,128}$/);});
test("blog creates all three compliant weekly articles in one cycle with Article, FAQ and UTMs",async()=>{const store=kv(),env={ZEVANORY_PRIVATE_ARTIFACTS:store,PUBLIC_BASE_URL:"https://zevanory.api.br"};const out=await ensureWeeklyBlog(env,new Date("2026-10-07T12:00:00Z"),async()=>({ok:true}));assert.equal(out.total,3);assert.equal(out.created.length,3);const html=await renderBlogArticle(env,out.created[0].id);assert.match(html,/Article/);assert.match(html,/FAQPage/);assert.match(html,/utm_source=blog/);assert.match(html,/Garantia de 7 dias/);});
test("official Telegram and Pinterest adapters return real provider evidence",async()=>{const calls=[];const fetchImpl=async(url,init)=>{calls.push([url,init]);if(url.endsWith("/brand/export/pin.png"))return brandResponse("pin.png");return url.includes("telegram")?{status:200,json:async()=>({ok:true,result:{message_id:7}})}:{status:201,json:async()=>({id:"pin-9"})};};const tg=await publishTelegram({env:{TELEGRAM_BOT_TOKEN:"secret",TELEGRAM_CHANNEL_ID:"@zevanory"},payload:{content:"oi"},fetchImpl});assert.equal(tg.url,"https://t.me/zevanory/7");const pin=await publishPinterest({env:{PINTEREST_ACCESS_TOKEN:"secret",PINTEREST_BOARD_ID:"board"},payload:{title:"t",content:"c",landing_url:"https://zevanory.api.br",media_url:"https://zevanory.api.br/brand/export/pin.png"},fetchImpl});assert.equal(pin.url,"https://www.pinterest.com/pin/pin-9/");assert.equal(calls.length,3);});
test("private Sistema channels checklist contains exact Pinterest fields and replaces Google Business with Search Console",async()=>{const html=await renderChannelsPage({META_ACCESS_TOKEN:"x",META_PAGE_ID:"p",INSTAGRAM_BUSINESS_ACCOUNT_ID:"i"});assert.match(html,/Sistema/);assert.match(html,/TELEGRAM_BOT_TOKEN/);assert.match(html,/YOUTUBE_CLIENT_ID/);assert.match(html,/PINTEREST_ACCESS_TOKEN/);assert.match(html,/PINTEREST_BOARD_ID/);assert.match(html,/pins:write/);assert.match(html,/boards:write/);assert.match(html,/developers\.pinterest\.com\/apps\//);assert.match(html,/Google Search Console \+ Blog/);assert.doesNotMatch(html,/Google Perfil da Empresa/);assert.doesNotMatch(html,/GOOGLE_BUSINESS_/);assert.match(html,/Aguardando verificação da empresa \(em análise\)/);assert.match(html,/Pendente credencial/);assert.match(html,/developers\.facebook\.com/);});
test("all six editorial topics satisfy the original 85/100 and 100% publishing rubric",async()=>{
  const store=kv(),env={ZEVANORY_PRIVATE_ARTIFACTS:store,PUBLIC_BASE_URL:"https://zevanory.api.br"};
  const slugs=[];
  for(let i=0;i<6;i++){
    const date=new Date(Date.UTC(2026,9,10+i,12));
    const outcome=await ensureDailyBlog(env,date);
    assert.equal(outcome.created.length,1,"day "+i+" must pass unchanged creative compliance gate");
    assert.equal(outcome.latest.compliance,100);
    assert.ok(outcome.latest.score>=85);
    slugs.push(outcome.latest.slug);
  }
  assert.equal(new Set(slugs).size,6);
});
test("one SEO article per Fortaleza calendar day for two consecutive dates",async()=>{
  const store=kv(),env={ZEVANORY_PRIVATE_ARTIFACTS:store,PUBLIC_BASE_URL:"https://zevanory.api.br"};
  const first=await ensureDailyBlog(env,new Date("2026-10-08T12:00:00Z"));
  const repeat=await ensureDailyBlog(env,new Date("2026-10-08T18:00:00Z"));
  const next=await ensureDailyBlog(env,new Date("2026-10-09T12:00:00Z"));
  assert.equal(first.created.length,1);
  assert.equal(repeat.created.length,0);
  assert.equal(next.created.length,1);
  assert.equal(localContentDay(new Date("2026-10-09T01:00:00Z")),"2026-10-08");
  const index=JSON.parse(await store.get("zpc:blog:index:v1"));
  assert.equal(index.articles.length,2);
  const html=await renderBlogArticle(env,next.latest.slug);
  assert.match(html,/utm_source=blog/);
  assert.match(html,/https:\/\/vendas\.zevanory\.api\.br\/comprar\/ZEV-IA-011\?utm_source=blog/);
});
test("hourly cycle publishes one approved daily article to Telegram with real-URL contract and UTM",async()=>{
  const store=kv(),calls=[];
  const env={ZEVANORY_PRIVATE_ARTIFACTS:store,TELEGRAM_BOT_TOKEN:"s",TELEGRAM_CHANNEL_ID:"@zevanory"};
  const fetchImpl=async (url,options)=>{calls.push({url,body:JSON.parse(options.body)});return new Response(JSON.stringify({ok:true,result:{message_id:9}}),{status:200});};
  const out=await runMultichannelAutonomy(env,new Date("2026-10-06T12:00:00Z"),fetchImpl);
  assert.equal(out.blog.created.length,1);
  assert.equal(out.evidence.length,1);
  assert.equal(out.evidence[0].url,"https://t.me/zevanory/9");
  assert.match(calls[0].body.text,/\/comprar\/ZEV-IA-011\?utm_source=telegram/);
  assert.equal((await store.get("zpc:multichannel:evidence:telegram:daily:2026-10-06"))!==null,true);
});
test("Telegram daily publication is idempotent within the day and renews tomorrow",async()=>{
  const store=kv(),env={ZEVANORY_PRIVATE_ARTIFACTS:store,TELEGRAM_BOT_TOKEN:"s",TELEGRAM_CHANNEL_ID:"@zevanory"};
  let calls=0;
  const fetchImpl=async()=>{calls++;return new Response(JSON.stringify({ok:true,result:{message_id:calls}}),{status:200});};
  for(let i=0;i<3;i++)await runMultichannelAutonomy(env,new Date("2026-10-07T12:00:00Z"),fetchImpl);
  assert.equal(calls,1);
  assert.equal(await store.get("zpc:multichannel:quota:telegram:2026-10-07"),"1");
  await runMultichannelAutonomy(env,new Date("2026-10-08T12:00:00Z"),fetchImpl);
  assert.equal(calls,2);
  assert.equal(await store.get("zpc:multichannel:quota:telegram:2026-10-08"),"1");
});

test("telegram photo caption stays within the 1024-char Bot API limit", async () => {
  const { publishTelegram, telegramCaption, TELEGRAM_CAPTION_MAX } = await import("../worker/multichannel-autonomy.mjs");
  const long = ("palavra ".repeat(400)).trim();
  assert.ok(telegramCaption(long).length <= TELEGRAM_CAPTION_MAX);
  assert.equal(telegramCaption("curto"), "curto");
  const calls = [];
  const ok = async (url, init) => { if(url.endsWith("/brand/export/post-01.png"))return brandResponse("post-01.png");calls.push({ url, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { status: 200 }); };
  const out = await publishTelegram({ env: { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHANNEL_ID: "@zevanory" }, payload: { content: long, media_url: "https://zevanory.api.br/brand/export/post-01.png" }, fetchImpl: ok });
  assert.equal(out.provider_post_id, "7");
  assert.match(calls[0].url, /sendPhoto$/);
  assert.ok(calls[0].body.caption.length <= 1024);
});

test("telegram falls back to a text message when the photo is refused with 400, never on other errors", async () => {
  const { publishTelegram } = await import("../worker/multichannel-autonomy.mjs");
  const calls = [];
  const fetchImpl = async (url, init) => {
    if(url.endsWith("/brand/export/post-01.png"))return brandResponse("post-01.png");
    calls.push(url);
    if (url.endsWith("/sendPhoto")) return new Response(JSON.stringify({ ok: false, description: "Bad Request" }), { status: 400 });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), { status: 200 });
  };
  const out = await publishTelegram({ env: { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHANNEL_ID: "@zevanory" }, payload: { content: "texto", media_url: "https://zevanory.api.br/brand/export/post-01.png" }, fetchImpl });
  assert.equal(out.provider_post_id, "9");
  assert.deepEqual(calls.map((u) => u.split("/").pop()), ["sendPhoto", "sendMessage"]);
  const failing = async (url) => url.endsWith("/brand/export/post-01.png") ? brandResponse("post-01.png") : new Response("{}", { status: 401 });
  await assert.rejects(publishTelegram({ env: { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHANNEL_ID: "@zevanory" }, payload: { content: "x", media_url: "https://zevanory.api.br/brand/export/post-01.png" }, fetchImpl: failing }), /provider_http_401/);
});

test("Telegram post evidence survives hourly cron and contains two consecutive verified days",async()=>{
  const store=kv(),env={ZEVANORY_PRIVATE_ARTIFACTS:store,TELEGRAM_BOT_TOKEN:"s",TELEGRAM_CHANNEL_ID:"@zevanory"};
  let sent=0;
  const fetchImpl=async()=>new Response(JSON.stringify({ok:true,result:{message_id:100+(++sent)}}),{status:200});
  const day1=await runMultichannelAutonomy(env,new Date("2026-10-08T12:00:00Z"),fetchImpl);
  const repeat=await runMultichannelAutonomy(env,new Date("2026-10-08T13:00:00Z"),fetchImpl);
  assert.equal(day1.evidence.length,1);
  assert.equal(repeat.evidence.length,1);
  assert.equal(repeat.evidence[0].url,"https://t.me/zevanory/101");
  const day2=await runMultichannelAutonomy(env,new Date("2026-10-09T12:00:00Z"),fetchImpl);
  assert.equal(sent,2);
  assert.equal(day2.evidence.length,2);
  assert.deepEqual(new Set(day2.evidence.map(e=>e.provider_post_id)),new Set(["101","102"]));
  const later=await runMultichannelAutonomy(env,new Date("2026-10-09T13:00:00Z"),fetchImpl);
  assert.equal(sent,2);
  assert.equal(later.evidence.length,2);
  const publicState=JSON.parse(await store.get("zpc:multichannel:state:v1"));
  assert.equal(publicState.evidence.length,2);
});

test("Telegram resolves a public t.me URL even when configured with numeric chat ID",async()=>{
  const fetchImpl=async()=>new Response(JSON.stringify({ok:true,result:{message_id:42,chat:{id:-10098765,username:"zevanory"}}}),{status:200});
  const out=await publishTelegram({env:{TELEGRAM_BOT_TOKEN:"s",TELEGRAM_CHANNEL_ID:"-10098765"},payload:{content:"Guia publicado"},fetchImpl});
  assert.equal(out.url,"https://t.me/zevanory/42");
  const withoutUsername=async()=>new Response(JSON.stringify({ok:true,result:{message_id:43,chat:{id:-10098765}}}),{status:200});
  const privatePost=await publishTelegram({env:{TELEGRAM_BOT_TOKEN:"s",TELEGRAM_CHANNEL_ID:"-10098765"},payload:{content:"Guia publicado"},fetchImpl:withoutUsername});
  assert.equal(privatePost.url,null,"do not invent public links for a private channel");
});

test("Pinterest F1 dynamic editorial is published with the official hashed Z image",async()=>{
  const creative={creative_id:"f1-test-10",status:"approved_for_autopublish",compliance:100,score:92,asset_url:"https://creative.example/unverified.png",title:"Tema editorial específico",content:"Descrição editorial específica",landing_url:"https://vendas.zevanory.api.br/solucoes"};
  const rebranded=brandPinterestCreative(creative);
  assert.equal(rebranded.media_url,PINTEREST_APPROVED_BRAND_PIN_URL);
  assert.equal(rebranded.title,creative.title);
  assert.equal(rebranded.content,creative.content);
  const store=kv();
  await store.put("zpc:creative-autonomy:feed:v1",JSON.stringify([creative]));
  const requests=[];
  const fake=async(url,options={})=>{
    requests.push(url);
    if(url===PINTEREST_APPROVED_BRAND_PIN_URL)return brandResponse("pin.png");
    if(url==="https://api.pinterest.com/v5/pins"){
      const p=JSON.parse(options.body);
      assert.equal(p.media_source.url,PINTEREST_APPROVED_BRAND_PIN_URL);
      assert.equal(p.title,creative.title);
      assert.equal(p.description,creative.content);
      return new Response(JSON.stringify({id:"pin-brand-test"}),{status:201});
    }
    throw Error("Unexpected endpoint "+url);
  };
  const env={ZEVANORY_PRIVATE_ARTIFACTS:store,PINTEREST_ACCESS_TOKEN:"test",PINTEREST_BOARD_ID:"board"};
  const outcome=await runMultichannelAutonomy(env,new Date("2026-10-10T18:00:00Z"),fake);
  assert.ok(!requests.includes(creative.asset_url));
  assert.ok(requests.includes(PINTEREST_APPROVED_BRAND_PIN_URL));
  const pin=outcome.evidence.find(x=>x.channel==="pinterest");
  assert.equal(pin?.provider_post_id,"pin-brand-test");
  assert.equal(pin?.brand_asset_strategy,"approved_official_pin");
});
