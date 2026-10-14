import {readFile} from "node:fs/promises";
import {pathToFileURL} from "node:url";

const EXPECTED_CHANNELS=["seo","youtube","tiktok","telegram","bluesky"];
const EXPECTED_CAMPAIGNS=new Map([
  ["fluxo-caixa-pix-lucro-caixa",{product:"lucro-e-caixa",sku:"ZEV-LCX-011"}],
  ["whatsapp-clientes-vendas-pratica",{product:"vendas-na-pratica",sku:"ZEV-VEN-011"}]
]);
const EXPECTED_DESTINATIONS={
  cashflow_calculator:{host:"zevanory.api.br",path:"/calculadora-fluxo-de-caixa",tracked:true},
  free_checklist:{host:"zevanory.api.br",path:"/material-gratuito",tracked:true},
  whatsapp_reengagement_guide:{host:"vendas.zevanory.api.br",path:"/mensagem-para-cliente-que-sumiu",tracked:false},
  whatsapp_collection_guide:{host:"vendas.zevanory.api.br",path:"/como-cobrar-cliente-pelo-whatsapp",tracked:false},
  whatsapp_quote_guide:{host:"vendas.zevanory.api.br",path:"/como-mandar-orcamento-pelo-whatsapp",tracked:false}
};
const STAGES={
  seo:{artifact_stage:"seo_brief",production_status:"not_produced_not_certified"},
  youtube:{artifact_stage:"video_script",production_status:"not_produced_not_certified"},
  tiktok:{artifact_stage:"video_script",production_status:"not_produced_not_certified"},
  telegram:{artifact_stage:"text_draft",production_status:"not_approved_not_published"},
  bluesky:{artifact_stage:"text_draft",production_status:"not_approved_not_published"}
};
const CLAIMS=/\b(?:lucro garantido|renda garantida|faturamento garantido|resultado garantido|vendas garantidas|conversão garantida|ganhe dinheiro|venda mais em \d+ dias|multiplique (?:suas )?vendas)\b/i;
const SENSITIVE=/^(?:token|secret|password|authorization|api_key|access_key|private_key|cookie)$/i;
const LABEL=/^[a-z0-9_-]{1,48}$/;
const assert=(ok,message)=>{if(!ok)throw new Error(message);};

function rejectSensitive(value,path="$"){
  if(Array.isArray(value))return value.forEach((item,i)=>rejectSensitive(item,path+"["+i+"]"));
  if(!value||typeof value!=="object")return;
  for(const [key,child] of Object.entries(value)){
    assert(!SENSITIVE.test(key),"sensitive_key:"+path+"."+key);
    rejectSensitive(child,path+"."+key);
  }
}
const words=text=>String(text).toLocaleLowerCase("pt-BR").match(/[\p{L}\p{N}]+/gu)||[];
const grams=text=>{const w=words(text),set=new Set();for(let i=0;i+2<w.length;i++)set.add(w.slice(i,i+3).join(" "));return set;};
export function similarity(a,b){
  const x=grams(a),y=grams(b),union=new Set([...x,...y]);
  return union.size?[...x].filter(item=>y.has(item)).length/union.size:0;
}
const assetText=asset=>[asset.hook,asset.body,asset.cta].join(" ");

export function destinationMatrix(plan){
  const registry=plan.destination_registry||{};
  return Object.entries(registry).map(([id,item])=>({
    id,url:item.url,expected_final_url:item.expected_final_url,
    content_marker:item.content_marker,campaign_visits_tracked:item.campaign_visits_tracked,
    funnel_page:item.funnel_page
  }));
}

export function validateCampaigns(plan){
  assert(plan&&typeof plan==="object","plan_required");
  rejectSensitive(plan);
  assert(plan.schema_version===1,"schema_version");
  assert(plan.metadata?.market==="BR","market");
  assert(plan.metadata?.status==="draft_not_published","status");
  assert(plan.metadata?.editorial_readiness==="proposals_only_not_ready_for_distribution","editorial_readiness");
  assert(plan.metadata?.publication_allowed===false,"publication_disabled");
  assert(plan.metadata?.paid_media_allowed===false,"paid_media_disabled");
  assert(plan.metadata?.outbound_messages_allowed===false,"outbound_messages_disabled");
  assert(plan.metadata?.experiment_window_days===14,"comparable_window");
  assert(JSON.stringify(plan.shared_design?.channels)===JSON.stringify(EXPECTED_CHANNELS),"comparable_channels");
  assert(plan.shared_design?.assets_per_channel===1,"comparable_asset_count");
  assert(plan.shared_design?.utm_medium==="organic","organic_only");
  assert(plan.shared_design?.measurement_system==="worker/funnel.mjs","existing_measurement_required");
  assert(/não em visitas totais/i.test(plan.shared_design?.comparison_rule||""),"comparison_limit_missing");

  const registry=plan.destination_registry;
  assert(registry&&Object.keys(registry).length===Object.keys(EXPECTED_DESTINATIONS).length,"destination_registry");
  for(const [id,expected] of Object.entries(EXPECTED_DESTINATIONS)){
    const item=registry[id];assert(item,"destination_missing:"+id);
    for(const field of ["url","expected_final_url"]){
      const url=new URL(item[field]);
      assert(url.protocol==="https:"&&!url.username&&!url.password&&!url.port,"destination_https:"+id);
      assert(url.hostname===expected.host,"destination_host:"+id);
      assert(url.pathname===expected.path&&!url.search&&!url.hash,"destination_path:"+id);
    }
    assert(item.url===item.expected_final_url,"unexpected_redirect_contract:"+id);
    assert(typeof item.content_marker==="string"&&item.content_marker.length>=12,"content_marker:"+id);
    assert(item.campaign_visits_tracked===expected.tracked,"tracking_registry:"+id);
    assert(expected.tracked?typeof item.funnel_page==="string":item.funnel_page===null,"funnel_page:"+id);
  }

  assert(Array.isArray(plan.campaigns)&&plan.campaigns.length===2,"exactly_two_campaigns");
  const ids=new Set(),utmCampaigns=new Set(),allAssets=[];
  for(const campaign of plan.campaigns){
    assert(EXPECTED_CAMPAIGNS.has(campaign.id),"unknown_campaign:"+campaign.id);
    assert(!ids.has(campaign.id),"duplicate_campaign:"+campaign.id);ids.add(campaign.id);
    const expected=EXPECTED_CAMPAIGNS.get(campaign.id);
    assert(campaign.product?.id===expected.product&&campaign.product?.sku===expected.sku,"product_binding:"+campaign.id);
    assert(typeof campaign.audience?.primary==="string"&&campaign.audience.primary.length>20,"audience:"+campaign.id);
    assert(typeof campaign.value_proposition==="string"&&!CLAIMS.test(campaign.value_proposition),"value_proposition:"+campaign.id);
    assert(registry[campaign.entry_material?.primary],"entry_primary:"+campaign.id);
    assert(registry[campaign.entry_material?.secondary],"entry_secondary:"+campaign.id);
    assert(Array.isArray(campaign.entry_material?.reused_assets)&&campaign.entry_material.reused_assets.length>=3,"reuse_required:"+campaign.id);
    assert(LABEL.test(campaign.utm?.campaign||""),"utm_campaign:"+campaign.id);
    assert(!utmCampaigns.has(campaign.utm.campaign),"utm_campaign_duplicate");utmCampaigns.add(campaign.utm.campaign);
    assert(campaign.utm.medium==="organic","utm_medium:"+campaign.id);

    assert(Array.isArray(campaign.assets)&&campaign.assets.length===EXPECTED_CHANNELS.length,"asset_count:"+campaign.id);
    const channels=campaign.assets.map(asset=>asset.channel).sort();
    assert(JSON.stringify(channels)===JSON.stringify([...EXPECTED_CHANNELS].sort()),"asset_channels:"+campaign.id);
    for(const asset of campaign.assets){
      assert(registry[asset.destination_id],"destination:"+campaign.id+":"+asset.channel);
      assert(LABEL.test(asset.source||""),"utm_source:"+campaign.id+":"+asset.channel);
      assert(["hook","body","cta"].every(key=>typeof asset[key]==="string"&&asset[key].trim().length>=12),"asset_copy:"+campaign.id+":"+asset.channel);
      const expectedStage=STAGES[asset.channel];
      assert(asset.artifact_stage===expectedStage.artifact_stage,"artifact_stage:"+campaign.id+":"+asset.channel);
      assert(asset.production_status===expectedStage.production_status,"production_status:"+campaign.id+":"+asset.channel);
      assert(asset.ready_for_distribution===false,"distribution_must_be_false:"+campaign.id+":"+asset.channel);
      const text=assetText(asset);
      assert(!CLAIMS.test(text),"forbidden_claim:"+campaign.id+":"+asset.channel);
      assert(!/https?:\/\//i.test(text),"embedded_unreviewed_url:"+campaign.id+":"+asset.channel);
      allAssets.push({id:campaign.id+":"+asset.channel,text});
    }

    const tracked=campaign.assets.filter(asset=>registry[asset.destination_id].campaign_visits_tracked).length;
    const coverage=campaign.measurement?.coverage;
    assert(coverage?.tracked_asset_destinations===tracked&&coverage?.total_asset_destinations===campaign.assets.length,"measurement_coverage:"+campaign.id);
    const primary=campaign.measurement?.primary;
    assert(primary?.baseline===null&&primary?.target===null,"invented_primary_metric:"+campaign.id);
    if(tracked===campaign.assets.length){
      assert(primary.source==="clean.campaigns."+campaign.utm.campaign&&coverage.status==="complete_for_listed_assets","primary_metric_provenance:"+campaign.id);
    }else{
      assert(primary.source===null&&primary.status==="not_measurable_current_funnel"&&coverage.status==="gap","untracked_campaign_claim:"+campaign.id);
    }
    assert(Array.isArray(campaign.measurement?.secondary)&&campaign.measurement.secondary.length>=3,"secondary_metrics:"+campaign.id);
    for(const metric of campaign.measurement.secondary){
      assert(/^clean\.(?:pages|sources)\./.test(metric.source||""),"metric_provenance:"+campaign.id);
      assert(metric.baseline===null&&metric.target===null,"invented_metric:"+campaign.id);
    }
    assert(Array.isArray(campaign.measurement?.limitations)&&campaign.measurement.limitations.length>=2,"measurement_limits:"+campaign.id);
  }
  assert(ids.size===EXPECTED_CAMPAIGNS.size,"campaign_coverage");

  let maxSimilarity={score:0,pair:[]};
  for(let i=0;i<allAssets.length;i++)for(let j=i+1;j<allAssets.length;j++){
    const score=similarity(allAssets[i].text,allAssets[j].text);
    if(score>maxSimilarity.score)maxSimilarity={score,pair:[allAssets[i].id,allAssets[j].id]};
    assert(score<0.5,"duplicate_content:"+allAssets[i].id+":"+allAssets[j].id);
  }

  const links=Object.fromEntries(plan.campaigns.map(campaign=>[
    campaign.id,
    Object.fromEntries(campaign.assets.map(asset=>{
      const url=new URL(registry[asset.destination_id].url);
      url.searchParams.set("utm_source",asset.source);
      url.searchParams.set("utm_medium","organic");
      url.searchParams.set("utm_campaign",campaign.utm.campaign);
      return [asset.channel,url.toString()];
    }))
  ]));
  return {ok:true,status:plan.metadata.status,editorial_readiness:plan.metadata.editorial_readiness,campaigns:[...ids],channels:EXPECTED_CHANNELS,assets:allAssets.length,max_similarity:maxSimilarity,destinations:destinationMatrix(plan),links};
}

async function main(){
  const file=process.argv[2];assert(file,"usage: node validate-campaigns.mjs <campaigns.json>");
  const plan=JSON.parse(await readFile(file,"utf8"));
  process.stdout.write(JSON.stringify(validateCampaigns(plan),null,2)+"\n");
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
  main().catch(error=>{process.stderr.write(String(error.message||error)+"\n");process.exitCode=1;});
}
