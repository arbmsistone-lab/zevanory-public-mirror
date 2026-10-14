import test from "node:test";
import assert from "node:assert/strict";
import { loadEditorialPackage, validateEditorialPackage } from "./validate-editorial.mjs";

const fresh = async () => {
  const loaded = await loadEditorialPackage();
  return { manifest: structuredClone(loaded.manifest), files: structuredClone(loaded.files) };
};

test("the editorial package contains two campaigns and ten blocked assets", async () => {
  const { manifest, files } = await fresh();
  assert.deepEqual(validateEditorialPackage(manifest, files), {
    ok: true,
    campaigns: 2,
    assets: 10,
    final_texts: 4,
    final_scripts: 4,
    final_briefs: 2,
    publication_allowed: false
  });
});

test("publication and distribution flags fail closed", async () => {
  const { manifest, files } = await fresh();
  manifest.metadata.publication_allowed = true;
  assert.throws(() => validateEditorialPackage(manifest, files), /safety_flag:publication_allowed/);
});

test("an asset cannot claim owner approval or readiness", async () => {
  const { manifest, files } = await fresh();
  manifest.assets[0].owner_approved = true;
  assert.throws(() => validateEditorialPackage(manifest, files), /asset_release_state/);
});

test("video scripts cannot masquerade as produced media", async () => {
  const { manifest, files } = await fresh();
  const video = manifest.assets.find(asset => asset.channel === "youtube");
  video.production_state = "media_produced";
  assert.throws(() => validateEditorialPackage(manifest, files), /video_production_state/);
});

test("unapproved visual references fail closed", async () => {
  const { manifest, files } = await fresh();
  manifest.assets[0].visual_reference = "assets/unreviewed/ad.png";
  assert.throws(() => validateEditorialPackage(manifest, files), /asset_visual/);
});

test("unsupported commercial promises fail closed", async () => {
  const { manifest, files } = await fresh();
  files["editorial-whatsapp-clientes.md"] += "\nVendas garantidas para todos.\n";
  assert.throws(() => validateEditorialPackage(manifest, files), /forbidden_claim/);
});

test("links outside the official store fail closed", async () => {
  const { manifest, files } = await fresh();
  files["editorial-fluxo-caixa-pix.md"] = files["editorial-fluxo-caixa-pix.md"].replace(
    "https://vendas.zevanory.api.br/calculadora-fluxo-de-caixa",
    "https://example.invalid/calculadora-fluxo-de-caixa"
  );
  assert.throws(() => validateEditorialPackage(manifest, files), /editorial_url_host/);
});

test("campaign attribution cannot silently change", async () => {
  const { manifest, files } = await fresh();
  files["editorial-whatsapp-clientes.md"] = files["editorial-whatsapp-clientes.md"].replace(
    "utm_campaign=c3_whatsapp_clientes",
    "utm_campaign=c3_fluxo_caixa_pix"
  );
  assert.throws(() => validateEditorialPackage(manifest, files), /editorial_utm_campaign/);
});

test("the measurement gap must remain explicit until the operational handoff lands", async () => {
  const { manifest, files } = await fresh();
  manifest.campaigns[1].measurement_state = "measurable_5_of_5";
  assert.throws(() => validateEditorialPackage(manifest, files), /campaign_measurement/);
});

test("all three WhatsApp guides are mandatory in the Claude handoff", async () => {
  const { manifest, files } = await fresh();
  files["CLAUDE_HANDOFF_WHATSAPP_MEASUREMENT.md"] = files["CLAUDE_HANDOFF_WHATSAPP_MEASUREMENT.md"].replaceAll(
    "/como-cobrar-cliente-pelo-whatsapp",
    "/guia-removido"
  );
  assert.throws(() => validateEditorialPackage(manifest, files), /handoff_slug/);
});

test("secret-like fields are rejected anywhere in the manifest", async () => {
  const { manifest, files } = await fresh();
  manifest.metadata.token = "must-not-be-stored";
  assert.throws(() => validateEditorialPackage(manifest, files), /sensitive_key/);
});
