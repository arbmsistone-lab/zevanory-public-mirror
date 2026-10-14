import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {validateCampaigns,destinationMatrix} from "./validate-campaigns.mjs";

const source=new URL("./campaigns.json",import.meta.url);
const load=async()=>JSON.parse(await readFile(source,"utf8"));
const normalizeUrl=value=>String(value).replace(/\/$/,"");

test("two organic campaign proposals are safe but not declared distribution-ready",async()=>{
  const plan=await load(),result=validateCampaigns(plan);
  assert.equal(result.ok,true);
  assert.equal(result.status,"draft_not_published");
  assert.equal(result.editorial_readiness,"proposals_only_not_ready_for_distribution");
  assert.equal(result.campaigns.length,2);
  assert.equal(result.channels.length,5);
  assert.equal(result.assets,10);
  assert.equal(result.max_similarity.score<0.5,true);
  assert.match(result.links["fluxo-caixa-pix-lucro-caixa"].youtube,/utm_campaign=c3_fluxo_caixa_pix/);
  assert.match(result.links["whatsapp-clientes-vendas-pratica"].youtube,/^https:\/\/vendas\.zevanory\.api\.br\//);
});

test("destination registry assigns main assets and sales guides to certified hosts",async()=>{
  const result=validateCampaigns(await load());
  const destinations=Object.fromEntries(result.destinations.map(item=>[item.id,item]));
  assert.equal(new URL(destinations.cashflow_calculator.url).hostname,"zevanory.api.br");
  for(const id of ["whatsapp_reengagement_guide","whatsapp_collection_guide","whatsapp_quote_guide"]){
    assert.equal(new URL(destinations[id].url).hostname,"vendas.zevanory.api.br");
    assert.equal(destinations[id].campaign_visits_tracked,false);
  }
});

test("a WhatsApp guide on the main domain fails closed",async()=>{
  const plan=await load();
  plan.destination_registry.whatsapp_reengagement_guide.url="https://zevanory.api.br/mensagem-para-cliente-que-sumiu";
  plan.destination_registry.whatsapp_reengagement_guide.expected_final_url=plan.destination_registry.whatsapp_reengagement_guide.url;
  assert.throws(()=>validateCampaigns(plan),/destination_host:whatsapp_reengagement_guide/);
});

test("live destinations return HTML content at the certified final URL",{timeout:45000},async()=>{
  const plan=await load(),matrix=destinationMatrix(plan);
  const paths=[...new Set(matrix.map(item=>new URL(item.url).pathname))];
  const candidates=paths.flatMap(path=>["zevanory.api.br","vendas.zevanory.api.br"].map(host=>"https://"+host+path));
  const candidateProof=await Promise.all(candidates.map(async url=>{
    const response=await fetch(url,{redirect:"follow",headers:{"user-agent":"ZEVANORY-Codex-Acquisition-Audit/1.0","accept":"text/html"}});
    const body=await response.text();
    return {requested_url:url,status:response.status,redirected:response.redirected,final_url:response.url,title:(body.match(/<title>([^<]+)/i)||[])[1]||null,content_type:response.headers.get("content-type")};
  }));
  console.log("LIVE_CANDIDATE_PROOF "+JSON.stringify(candidateProof));
  const byRequested=new Map(candidateProof.map(item=>[item.requested_url,item]));
  for(const item of matrix){
    const observed=byRequested.get(item.url);
    assert.equal(observed.status,200,"http_status:"+item.id);
    assert.equal(normalizeUrl(observed.final_url),normalizeUrl(item.expected_final_url),"final_url:"+item.id);
    assert.match(observed.content_type||"",/text\/html/i,"content_type:"+item.id);
    const response=await fetch(item.url,{redirect:"follow",headers:{"user-agent":"ZEVANORY-Codex-Acquisition-Audit/1.0","accept":"text/html"}});
    assert.equal((await response.text()).includes(item.content_marker),true,"content_marker:"+item.id);
  }
});

test("publication, paid media and outbound messages fail closed",async()=>{
  for(const field of ["publication_allowed","paid_media_allowed","outbound_messages_allowed"]){
    const plan=await load();plan.metadata[field]=true;
    assert.throws(()=>validateCampaigns(plan),/(publication|paid_media|outbound_messages)_disabled/);
  }
});

test("financial or conversion promises fail closed",async()=>{
  const plan=await load();plan.campaigns[0].assets[0].body="Lucro garantido com esta rotina.";
  assert.throws(()=>validateCampaigns(plan),/forbidden_claim/);
});

test("invented baselines and targets fail closed",async()=>{
  const baseline=await load();baseline.campaigns[0].measurement.primary.baseline=100;
  assert.throws(()=>validateCampaigns(baseline),/invented_primary_metric/);
  const target=await load();target.campaigns[1].measurement.secondary[0].target=500;
  assert.throws(()=>validateCampaigns(target),/invented_metric/);
});

test("an untracked landing cannot claim campaign visit measurement",async()=>{
  const plan=await load();
  const campaign=plan.campaigns.find(item=>item.id==="whatsapp-clientes-vendas-pratica");
  campaign.measurement.primary.source="clean.campaigns.c3_whatsapp_clientes";
  campaign.measurement.primary.status="measurable";
  assert.throws(()=>validateCampaigns(plan),/untracked_campaign_claim/);
});

test("measurement coverage must match the selected destinations",async()=>{
  const plan=await load();
  plan.campaigns[1].measurement.coverage.tracked_asset_destinations=5;
  assert.throws(()=>validateCampaigns(plan),/measurement_coverage/);
});

test("video scripts cannot be labeled produced or distribution-ready",async()=>{
  const produced=await load();
  const youtube=produced.campaigns[0].assets.find(item=>item.channel==="youtube");
  youtube.production_status="produced";
  assert.throws(()=>validateCampaigns(produced),/production_status/);
  const ready=await load();
  ready.campaigns[1].assets.find(item=>item.channel==="tiktok").ready_for_distribution=true;
  assert.throws(()=>validateCampaigns(ready),/distribution_must_be_false/);
});

test("duplicated content fails closed",async()=>{
  const plan=await load();
  const duplicate={...plan.campaigns[0].assets[1],channel:"youtube",destination_id:"whatsapp_quote_guide"};
  plan.campaigns[1].assets[1]=duplicate;
  assert.throws(()=>validateCampaigns(plan),/duplicate_content/);
});

test("unknown destinations and malformed UTMs fail closed",async()=>{
  const route=await load();route.campaigns[0].assets[0].destination_id="checkout";
  assert.throws(()=>validateCampaigns(route),/destination/);
  const utm=await load();utm.campaigns[1].utm.campaign="Campanha com espaços";
  assert.throws(()=>validateCampaigns(utm),/utm_campaign/);
});

test("secret-like fields are rejected",async()=>{
  const plan=await load();plan.metadata.api_key="do-not-store";
  assert.throws(()=>validateCampaigns(plan),/sensitive_key/);
});

test("campaign and product binding cannot be swapped",async()=>{
  const plan=await load();plan.campaigns[0].product.id="vendas-na-pratica";
  assert.throws(()=>validateCampaigns(plan),/product_binding/);
});
