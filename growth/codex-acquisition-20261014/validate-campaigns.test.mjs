import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {validateCampaigns} from "./validate-campaigns.mjs";

const source=new URL("./campaigns.json",import.meta.url);
const load=async()=>JSON.parse(await readFile(source,"utf8"));

test("two organic campaigns are comparable and remain unpublished",async()=>{
  const plan=await load(),result=validateCampaigns(plan);
  assert.equal(result.ok,true);
  assert.equal(result.status,"draft_not_published");
  assert.equal(result.campaigns.length,2);
  assert.equal(result.channels.length,5);
  assert.equal(result.assets,10);
  assert.equal(result.max_similarity.score<0.5,true);
  assert.match(result.links["fluxo-caixa-pix-lucro-caixa"].youtube,/utm_campaign=c3_fluxo_caixa_pix/);
});

test("publication, paid media and outbound messages fail closed",async()=>{
  for(const field of ["publication_allowed","paid_media_allowed","outbound_messages_allowed"]){
    const plan=await load();plan.metadata[field]=true;
    assert.throws(()=>validateCampaigns(plan),/(publication|paid_media|outbound_messages)_disabled/);
  }
});

test("financial or conversion promises fail closed",async()=>{
  const plan=await load();
  plan.campaigns[0].assets[0].body="Lucro garantido com esta rotina.";
  assert.throws(()=>validateCampaigns(plan),/forbidden_claim/);
});

test("invented baselines and targets fail closed",async()=>{
  const baseline=await load();baseline.campaigns[0].measurement.primary.baseline=100;
  assert.throws(()=>validateCampaigns(baseline),/invented_primary_metric/);
  const target=await load();target.campaigns[1].measurement.secondary[0].target=500;
  assert.throws(()=>validateCampaigns(target),/invented_metric/);
});

test("duplicated content fails closed",async()=>{
  const plan=await load();
  plan.campaigns[1].assets[1]={...plan.campaigns[0].assets[1],channel:"youtube"};
  assert.throws(()=>validateCampaigns(plan),/duplicate_content/);
});

test("unapproved destinations and malformed UTMs fail closed",async()=>{
  const route=await load();route.campaigns[0].assets[0].destination="/checkout";
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
