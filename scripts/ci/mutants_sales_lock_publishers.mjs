#!/usr/bin/env node
// Mutantes da trava de vendas nos publicadores de conteúdo (motor de aquisição, Short do YouTube, adaptadores
// orgânicos). Cada mutante troca âncoras exatas (1 ocorrência cada, texto com EOL normalizado) numa CÓPIA
// descartável da árvore (o checkout não é tocado), roda tests/sales-lock-publishers.test.mjs (TAP) e só conta
// KILLED se: rc != 0, contagem igual à linha de base (6), falha de ASSERÇÃO e o teste esperado (rótulo declarado
// abaixo ANTES de rodar, pela regra que o mutante quebra) está entre os "not ok". Qualquer outra coisa é
// SURVIVED/INCONCLUSIVE e o runner sai 1. Offline, sem segredos.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SUITE = "tests/sales-lock-publishers.test.mjs";
const BASE_COUNT = 7;
const COPY = ["worker", "data", "scripts/channels", "assets/brand/export", "tests/helpers", SUITE];
const ACQ = "worker/acquisition-engine.mjs", LOCK = "worker/sales-lock-content.mjs", YT = "scripts/channels/youtube-daily-short.mjs", REC = "worker/cloudflare-worker.recovered.mjs";
const M7 = "D7: Instagram e Facebook fechados", B_CLOSED = "B: trava fechada", B_DRAFT = "B: validateDraft fechada", B_READ = "B: leitura da trava", C = "C: Short fechado", D = "D': adaptador orgânico";
// [id, rótulo do teste esperado, [[arquivo, de, para], ...]]
const MUTANTS = [
  ["SLP01_engine_ignores_lock", B_CLOSED, [[ACQ, " const salesOpen=await contentSalesOpen(env);", " const salesOpen=true;"]]],
  ["SLP02_requested_counts_as_open", B_READ, [[LOCK, "return (await readSalesSwitch(env))?.enabled === true;", "return (await readSalesSwitch(env))?.requested === true;"]]],
  ["SLP03_closed_link_goes_to_comprar", B_CLOSED, [[ACQ, '(salesOpen===true?"comprar/"+entry.product.sku:page)', '("comprar/"+entry.product.sku)']]],
  ["SLP04_closed_label_not_written", B_CLOSED, [[ACQ, '(open?"":" ("+CLOSED_LABEL+")")', '""']]],
  ["SLP05_validate_violations_removed", B_DRAFT, [[ACQ, '  for(const v of salesLockViolations(String(draft?.text||"")+"\\n"+String(draft?.link||"")))reasons.push("sales_closed_"+v);\n', ""]]],
  ["SLP06_validate_label_not_required", B_DRAFT, [[ACQ, '  if(!String(draft?.text||"").includes(CLOSED_LABEL))reasons.push("sales_closed_label_missing");\n', ""]]],
  ["SLP07_validate_defaults_open", B_DRAFT, [[ACQ, " const reasons=[],open=salesOpen===true;", " const reasons=[],open=true;"]]],
  ["SLP08_publish_channel_forces_open", B_CLOSED, [[ACQ, " const open=salesOpen===true;\n const draft=generateNative", " const open=true;\n const draft=generateNative"]]],
  ["SLP09_short_offer_keeps_price", C, [[YT, 'offer: open ? "R$ " + price + " · " + SHORT_RULE_LABEL : closedLabel,', 'offer: "R$ " + price + " · " + SHORT_RULE_LABEL,']]],
  ["SLP10_short_narration_keeps_rule", C, [[YT, '[open ? entry.product.name + ", com " + SHORT_RULE_SPOKEN + "." : entry.product.name + ": " + CLOSED_LABEL + "."]', '[entry.product.name + ", com " + SHORT_RULE_SPOKEN + "."]']]],
  ["SLP11_short_lines_keep_rule", C, [[YT, "entry.product.name, open ? SHORT_RULE_LABEL : closedLabel];", "entry.product.name, SHORT_RULE_LABEL];"]]],
  ["SLP12_organic_text_gate_removed", D, [[REC, " && payloadSalesLockViolations(event?.payload).length === 0, \"organicEventAllowed\");", ", \"organicEventAllowed\");"]]],
  ["SLP13_payload_price_field_ignored", D, [[LOCK, '  if (p.price_brl != null && p.price_brl !== "") out.add("price");\n', ""]]],
  ["SLP14_price_detector_removed", B_DRAFT, [[LOCK, '  if (PRICE_RE.test(s)) out.push("price");\n', ""]]],
  ["SLP15_checkout_detector_removed", B_DRAFT, [[LOCK, '  if (hasCheckoutCta(s) || COMPRAR_RE.test(s)) out.push("checkout_link");\n', ""]]],
  ["SLP16_comprar_without_slash_missed", D, [[LOCK, "hasCheckoutCta(s) || COMPRAR_RE.test(s)", "hasCheckoutCta(s)"]]],
  ["SLP17_cta_detector_removed", B_DRAFT, [[LOCK, '  if (PURCHASE_CTA_RE.test(s)) out.push("purchase_cta");\n', ""]]],
  ["SLP18_caption_field_not_inspected", D, [[LOCK, '"content", "title", "description", "caption", "text"', '"content", "title", "description", "text"']]],
  ["SLP19_meta_outbound_gate_removed", M7, [[REC, '  if (P04_META_CLOSED.has(String(event?.destination || "")) && !supportEventAllowed(event)) throw new Error("p04_meta_closed");\n', ""]]],
  ["SLP20_meta_organic_gate_removed", M7, [[REC, ' && !P04_META_CLOSED.has(String(event?.destination || "")) && env.ORGANIC', " && env.ORGANIC"]]],
  ["SLP21_meta_support_bypass_broadened", M7, [[REC, ' && !supportEventAllowed(event)) throw new Error("p04_meta_closed");', ' && event?.event_type === "publish_content") throw new Error("p04_meta_closed");']]],
];

const eol = (s) => s.replace(/\r\n/g, "\n");
function stage() {
  const d = mkdtempSync(join(tmpdir(), "zev-slp-mut-"));
  for (const rel of COPY) { mkdirSync(dirname(join(d, rel)), { recursive: true }); cpSync(join(ROOT, rel), join(d, rel), { recursive: true }); }
  return d;
}
function run(d) {
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-reporter-destination=stdout", SUITE], { cwd: d, encoding: "utf8", timeout: 240000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  const out = eol(String(r.stdout || ""));
  const tests = Number((out.match(/^# tests (\d+)$/m) || [])[1] ?? -1);
  const failed = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
  return { rc: r.status, out, tests, failed };
}

let d = stage();
const base = run(d);
rmSync(d, { recursive: true, force: true });
if (base.rc !== 0 || base.tests !== BASE_COUNT || base.failed.length) { console.log(`BASELINE FAIL rc=${base.rc} tests=${base.tests}`); console.log(base.out.slice(-3000)); process.exit(2); }
console.log(`BASELINE PASS tests=${BASE_COUNT}`);
const bad = [];
for (const [id, label, edits] of MUTANTS) {
  d = stage();
  let verdict = "", why = "";
  for (const [file, from, to] of edits) {
    const f = join(d, file), text = eol(readFileSync(f, "utf8"));
    const n = text.split(from).length - 1;
    if (n !== 1) { verdict = "INCONCLUSIVE"; why = `${file} anchor_count=${n}`; break; }
    writeFileSync(f, text.replace(from, to));
  }
  if (!verdict) {
    const r = run(d);
    const hit = r.failed.some((t) => t.startsWith(label));
    if (r.rc === 0) { verdict = "SURVIVED"; why = "suite passed"; }
    else if (r.tests !== BASE_COUNT) { verdict = "INCONCLUSIVE"; why = `tests=${r.tests}`; }
    else if (!/AssertionError|ERR_ASSERTION/.test(r.out)) { verdict = "INCONCLUSIVE"; why = "non-assertion failure"; }
    else if (!hit) { verdict = "INCONCLUSIVE"; why = "expected test not failed: " + label + " | failed=" + JSON.stringify(r.failed); }
    else { verdict = "KILLED"; why = "by=" + JSON.stringify(r.failed); }
  }
  rmSync(d, { recursive: true, force: true });
  if (verdict !== "KILLED") bad.push(id);
  console.log(`MUTANT ${id} ${verdict} ${why}`);
}
const killed = MUTANTS.length - bad.length;
console.log(bad.length ? `MUTANTS FAIL killed=${killed}/${MUTANTS.length} not_killed=${bad.join(",")}` : `MUTANTS PASS killed=${killed}/${MUTANTS.length}`);
process.exit(bad.length ? 1 : 0);
