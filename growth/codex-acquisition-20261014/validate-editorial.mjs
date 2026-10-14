import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const EXPECTED_CAMPAIGNS = new Map([
  ["fluxo-caixa-pix-lucro-caixa", { product: "lucro-e-caixa", utm: "c3_fluxo_caixa_pix", measurement: "measurable_5_of_5", file: "editorial-fluxo-caixa-pix.md" }],
  ["whatsapp-clientes-vendas-pratica", { product: "vendas-na-pratica", utm: "c3_whatsapp_clientes", measurement: "blocked_0_of_5_until_operational_handoff", file: "editorial-whatsapp-clientes.md" }]
]);
const CHANNELS = new Set(["seo", "youtube", "tiktok", "telegram", "bluesky"]);
const VISUALS = new Set([
  "assets/brand/export/blog-card.png",
  "assets/brand/export/short.png",
  "assets/brand/export/post-01.png",
  "assets/brand/export/link-card.png"
]);
const REQUIRED_CRITERIA = new Set([
  "owner_approval", "destination_readback", "claims_review", "brand_validation",
  "channel_limits", "measurement_ready", "human_preview", "canonical_pipeline"
]);
const WHATSAPP_SLUGS = [
  "/mensagem-para-cliente-que-sumiu",
  "/como-cobrar-cliente-pelo-whatsapp",
  "/como-mandar-orcamento-pelo-whatsapp"
];
const FORBIDDEN = /\b(?:lucro garantido|renda garantida|faturamento garantido|resultado garantido|vendas garantidas|ganhe dinheiro|vai vender mais|conversão garantida)\b/i;
const SECRET_KEY = /^(?:token|secret|password|authorization|api_key|access_key|private_key)$/i;
const assert = (condition, message) => { if (!condition) throw new Error(message); };

function rejectSensitiveKeys(value, path = "$") {
  if (Array.isArray(value)) return value.forEach((item, i) => rejectSensitiveKeys(item, path + "[" + i + "]"));
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert(!SECRET_KEY.test(key), "sensitive_key:" + path + "." + key);
    rejectSensitiveKeys(child, path + "." + key);
  }
}

const graphemes = value => [...new Intl.Segmenter("pt-BR", { granularity: "grapheme" }).segment(value)].length;
const sectionParagraph = (text, heading) => {
  const escaped = heading.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  const match = text.match(new RegExp("^## " + escaped + "\\r?\\n\\r?\\n([^\\r\\n]+)", "m"));
  return match?.[1] || "";
};

function validateUrls(text, campaign) {
  const urls = [...text.matchAll(/https:\/\/[^\s)]+/g)].map(match => match[0].replace(/[.,;:]$/u, ""));
  assert(urls.length >= 5, "editorial_urls_minimum:" + campaign.id);
  const sources = new Set();
  for (const raw of urls) {
    const url = new URL(raw);
    assert(url.protocol === "https:", "editorial_url_https");
    assert(url.hostname === "vendas.zevanory.api.br", "editorial_url_host");
    assert(url.searchParams.get("utm_medium") === "organic", "editorial_utm_medium");
    assert(url.searchParams.get("utm_campaign") === campaign.utm_campaign, "editorial_utm_campaign:" + campaign.id);
    const source = url.searchParams.get("utm_source");
    assert(CHANNELS.has(source === "blog" ? "seo" : source), "editorial_utm_source:" + source);
    assert([...url.searchParams.keys()].every(key => ["utm_source", "utm_medium", "utm_campaign"].includes(key)), "editorial_unexpected_query");
    sources.add(source);
  }
  for (const expected of ["blog", "youtube", "tiktok", "telegram", "bluesky"]) {
    assert(sources.has(expected), "editorial_missing_source:" + campaign.id + ":" + expected);
  }
}

export function validateEditorialPackage(manifest, files) {
  assert(manifest && typeof manifest === "object", "manifest_required");
  rejectSensitiveKeys(manifest);
  assert(manifest.schema_version === 1, "schema_version");
  assert(manifest.metadata?.market === "BR" && manifest.metadata?.language === "pt-BR", "locale");
  assert(manifest.metadata?.stacked_on_pr === 815, "stacked_pr");
  assert(manifest.metadata?.stacked_on_sha === "362d7372b7bd36fa4fb649ef00f55a1756c5a7ca", "stacked_sha");
  for (const flag of ["publication_allowed", "distribution_executed", "paid_media_allowed", "outbound_messages_allowed"]) {
    assert(manifest.metadata?.[flag] === false, "safety_flag:" + flag);
  }
  assert(manifest.metadata?.owner_approval_required === true, "owner_approval_required");

  assert(Array.isArray(manifest.campaigns) && manifest.campaigns.length === 2, "two_campaigns");
  const campaignIds = new Set();
  for (const campaign of manifest.campaigns) {
    const expected = EXPECTED_CAMPAIGNS.get(campaign.id);
    assert(expected, "unknown_campaign:" + campaign.id);
    assert(!campaignIds.has(campaign.id), "duplicate_campaign:" + campaign.id);
    campaignIds.add(campaign.id);
    assert(campaign.product === expected.product, "campaign_product:" + campaign.id);
    assert(campaign.utm_campaign === expected.utm, "campaign_utm:" + campaign.id);
    assert(campaign.measurement_state === expected.measurement, "campaign_measurement:" + campaign.id);
    assert(campaign.editorial_file === expected.file, "campaign_file:" + campaign.id);
    const text = files[campaign.editorial_file];
    assert(typeof text === "string" && text.length >= 2000, "editorial_file_missing:" + campaign.editorial_file);
    assert(text.includes(campaign.id), "editorial_campaign_marker:" + campaign.id);
    assert(!FORBIDDEN.test(text), "forbidden_claim:" + campaign.id);
    validateUrls(text, campaign);
  }

  assert(Array.isArray(manifest.assets) && manifest.assets.length === 10, "ten_assets");
  const assetIds = new Set();
  const perCampaign = new Map();
  for (const asset of manifest.assets) {
    assert(!assetIds.has(asset.id), "duplicate_asset:" + asset.id);
    assetIds.add(asset.id);
    assert(EXPECTED_CAMPAIGNS.has(asset.campaign_id), "asset_campaign:" + asset.id);
    assert(CHANNELS.has(asset.channel), "asset_channel:" + asset.id);
    assert(asset.source === (asset.channel === "seo" ? "blog" : asset.channel), "asset_source:" + asset.id);
    assert(VISUALS.has(asset.visual_reference), "asset_visual:" + asset.id);
    assert(asset.editorial_state === "final_for_owner_review", "asset_editorial_state:" + asset.id);
    assert(asset.owner_approved === false && asset.ready_for_distribution === false && asset.published === false, "asset_release_state:" + asset.id);
    if (asset.channel === "youtube" || asset.channel === "tiktok") {
      assert(asset.deliverable_kind === "final_production_script", "video_deliverable:" + asset.id);
      assert(asset.production_state === "media_not_produced_not_certified", "video_production_state:" + asset.id);
    } else if (asset.channel === "seo") {
      assert(asset.deliverable_kind === "final_editorial_brief", "seo_deliverable:" + asset.id);
      assert(asset.production_state === "brief_only_no_site_change", "seo_production_state:" + asset.id);
    } else {
      assert(asset.deliverable_kind === "final_channel_text", "text_deliverable:" + asset.id);
      assert(/^text_complete_/.test(asset.production_state), "text_production_state:" + asset.id);
    }
    if (!perCampaign.has(asset.campaign_id)) perCampaign.set(asset.campaign_id, new Set());
    assert(!perCampaign.get(asset.campaign_id).has(asset.channel), "duplicate_channel:" + asset.campaign_id + ":" + asset.channel);
    perCampaign.get(asset.campaign_id).add(asset.channel);
  }
  for (const id of EXPECTED_CAMPAIGNS.keys()) assert(perCampaign.get(id)?.size === 5, "five_channels:" + id);

  assert(Array.isArray(manifest.publication_criteria), "publication_criteria");
  assert(manifest.publication_criteria.length === REQUIRED_CRITERIA.size, "publication_criteria_count");
  for (const criterion of REQUIRED_CRITERIA) assert(manifest.publication_criteria.includes(criterion), "publication_criterion:" + criterion);
  assert(Array.isArray(manifest.approved_visual_references) && manifest.approved_visual_references.length === VISUALS.size, "visual_reference_count");
  for (const visual of manifest.approved_visual_references) assert(VISUALS.has(visual), "unknown_visual_reference");

  const cash = files["editorial-fluxo-caixa-pix.md"];
  const whatsapp = files["editorial-whatsapp-clientes.md"];
  assert((cash.match(/^\| \d+[^\n]+\|/gm) || []).length === 10, "cashflow_scene_count");
  assert((whatsapp.match(/^\| \d+[^\n]+\|/gm) || []).length === 10, "whatsapp_scene_count");
  const blueskyCash = sectionParagraph(cash, "5. Texto final — Bluesky");
  const blueskyWhatsapp = sectionParagraph(whatsapp, "5. Texto final — Bluesky");
  assert(blueskyCash && graphemes(blueskyCash) <= 300, "bluesky_limit:cashflow:" + graphemes(blueskyCash));
  assert(blueskyWhatsapp && graphemes(blueskyWhatsapp) <= 300, "bluesky_limit:whatsapp:" + graphemes(blueskyWhatsapp));
  assert(blueskyCash !== blueskyWhatsapp, "duplicate_channel_copy");

  const handoff = files["CLAUDE_HANDOFF_WHATSAPP_MEASUREMENT.md"];
  assert(typeof handoff === "string" && handoff.includes("Destinatário:** Claude"), "handoff_recipient");
  assert(handoff.includes("nenhuma alteração operacional é implementada"), "handoff_boundary");
  for (const slug of WHATSAPP_SLUGS) assert(handoff.includes(slug), "handoff_slug:" + slug);
  assert(handoff.includes("não capturar conteúdo de mensagem, nome, telefone, e-mail, IP bruto"), "handoff_privacy");
  assert(handoff.includes("PR operacional separado"), "handoff_separate_pr");

  return { ok: true, campaigns: campaignIds.size, assets: assetIds.size, final_texts: 4, final_scripts: 4, final_briefs: 2, publication_allowed: false };
}

export async function loadEditorialPackage(baseUrl = new URL(".", import.meta.url)) {
  const manifest = JSON.parse(await readFile(new URL("editorial-manifest.json", baseUrl), "utf8"));
  const names = [...manifest.campaigns.map(item => item.editorial_file), "CLAUDE_HANDOFF_WHATSAPP_MEASUREMENT.md"];
  const files = Object.fromEntries(await Promise.all(names.map(async name => [name, await readFile(new URL(name, baseUrl), "utf8")])));
  return { manifest, files };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const { manifest, files } = await loadEditorialPackage();
  process.stdout.write(JSON.stringify(validateEditorialPackage(manifest, files)) + "\n");
}
