#!/usr/bin/env node
// Mutantes do blog com publicação automática e gate de qualidade (Plano Mestre v1.2, seção 9; substitui a DEC-21).
// Cada mutante troca uma âncora exata (1 ocorrência, EOL normalizado) numa CÓPIA descartável da árvore (o checkout não
// é tocado), roda tests/blog-autopublicacao.test.mjs (TAP) e só conta KILLED se: rc != 0, contagem igual à linha de
// base, falha de ASSERÇÃO e o teste esperado (rótulo declarado ANTES de rodar) está entre os "not ok". Qualquer outra
// coisa é SURVIVED/INCONCLUSIVE e o runner sai 1. Offline, sem segredos, sem rede.
// Uso: node scripts/ci/mutants_blog_gate.mjs
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SUITE = "tests/blog-autopublicacao.test.mjs";
const BASE_COUNT = 8;
const COPY = ["worker", "data", "tests/helpers", SUITE];
const GATE = "worker/blog-quality-gate.mjs", MCA = "worker/multichannel-autonomy.mjs", ED = "worker/blog-editorial.mjs";
const BOM = "caso bom", G = "gate:", HM = "modo Hotmart", AG = "agenda e teto", ID = "idempotência", RJ = "rejeição ponta a ponta", ANO = "365 dias";
// [id, rótulo do teste esperado, [[arquivo, de, para], ...]]
const MUTANTS = [
  ["BG01_fonte_nao_exigida", G, [[GATE, '  if (hasFactualClaim(text) && !sources.some(verifiableSource)) reasons.push("fonte_ausente");\n', ""]]],
  ["BG02_fonte_do_proprio_site_aceita", G, [[GATE, " && !OWN_HOSTS.test(u.hostname);", ";"]]],
  ["BG03_duplicata_ignorada", G, [[GATE, "|| similarityMax >= BLOG_DUPLICATE_THRESHOLD)", "|| similarityMax > 1)"]]],
  ["BG04_filtro_forbidden_desligado", G, [[GATE, "CREATIVE_FORBIDDEN_RE.test(str(text)) || CLAIMS_RE.test(str(text))", "CLAIMS_RE.test(str(text))"]]],
  ["BG05_promessas_desligadas", G, [[GATE, "CREATIVE_FORBIDDEN_RE.test(str(text)) || CLAIMS_RE.test(str(text))", "CREATIVE_FORBIDDEN_RE.test(str(text))"]]],
  ["BG06_tamanho_minimo_removido", G, [[GATE, "ok: words >= BLOG_MIN_WORDS && sections", "ok: sections"]]],
  ["BG07_passos_ou_exemplo_nao_exigidos", G, [[GATE, "sections >= BLOG_MIN_SECTIONS && practical };", "sections >= BLOG_MIN_SECTIONS };"]]],
  ["BG08_compliance_100_nao_exigido", G, [[GATE, " || Number(rubric.compliance) !== BLOG_MIN_COMPLIANCE", ""]]],
  ["BG09_score_85_nao_exigido", G, [[GATE, " || !(Number(rubric.score) >= BLOG_MIN_SCORE)", ""]]],
  ["BG10_utm_nao_exigida", G, [[GATE, '  if (u.searchParams.get("utm_source") !== "blog" || u.searchParams.get("utm_medium") !== "organic" || u.searchParams.get("utm_campaign") !== blogCampaignOf(article.day)) return false;\n', ""]]],
  ["BG11_hotmart_com_modo_fechado", G, [[GATE, "  const kit = mode?.full !== true && mode?.hotmart === true ? hotmartKit(article.product) : null;\n  return Boolean(kit)", "  const kit = hotmartKit(article.product);\n  return Boolean(kit)"]]],
  ["BG12_trava_de_vendas_ignorada", G, [[GATE, '  if (salesLockReasons(article, mode).length) reasons.push("trava_de_vendas");\n', ""]]],
  ["BG13_cta_checkout_proprio", BOM, [[GATE, '(kit ? "/hotmart/" + kit.slug : "/material-gratuito")', '(kit ? "/hotmart/" + kit.slug : "/comprar/" + article.product)']]],
  ["BG14_teto_semanal_removido", AG, [[MCA, '  if(!weekDays.includes(day)&&weekDays.length>=BLOG_WEEKLY_CAP)return reject(["teto_semanal"],{week});\n', ""]]],
  ["BG15_teto_nao_idempotente", AG, [[MCA, "if(!weekDays.includes(day)&&weekDays.length>=BLOG_WEEKLY_CAP)", "if(weekDays.length>=BLOG_WEEKLY_CAP)"]]],
  ["BG16_agenda_seg_qua_sex_ignorada", AG, [[MCA, '  if(!isPublicationDay(day))return {created:[],latest:null,day,reason:"not_publication_day"};\n', ""]]],
  ["BG17_rejeicao_reprocessada_no_dia", AG, [[MCA, 'if(prior?.resultado==="rejeitado")return', "if(false)return"]]],
  ["BG18_publicado_reprocessado_no_dia", ID, [[MCA, 'if(prior?.resultado==="ok"){', "if(false){"]]],
  ["BG19_gate_ignorado", RJ, [[MCA, "if(!gate.ok)return reject(", "if(false)return reject("]]],
  ["BG20_pausa_criativa_ignorada", RJ, [[MCA, "if(await creativeAutopublishPaused(env))return", "if(false)return"]]],
  ["BG21_cta_ignora_modo_hotmart", HM, [[MCA, "const ctaUrl=blogCtaUrl(source,mode);", "const ctaUrl=blogCtaUrl(source,{});"]]],
  ["BG22_indice_duplica_na_nova_tentativa", ID, [[MCA, "articles:[...(index.articles||[]).filter(x=>x?.slug!==article.slug),article]", "articles:[...(index.articles||[]),article]"]]],
  ["BG23_contador_regravado_na_nova_tentativa", ID, [[MCA, "if(!weekDays.includes(day))await kv.put(weekKey", "await kv.put(weekKey"]]],
  // Auditoria do #1020: gerador sem edição repete o tema na janela de 45; revisão por amostragem (1 de cada 3).
  ["BG24_edicao_fixa_repete_artigo", ANO, [[ED, "const edition = ((Math.floor(n / 25) % EDITIONS.length) + EDITIONS.length) % EDITIONS.length;", "const edition = ((Math.floor(n / 25) % 2) + 2) % 2;"]]],
  ["BG25_amostra_de_revisao_desligada", BOM, [[MCA, "const amostraRevisao=weekDays.filter(d=>d!==day).length%3===0;", "const amostraRevisao=false;"]]],
  ["BG26_amostra_de_revisao_em_toda_publicacao", AG, [[MCA, "const amostraRevisao=weekDays.filter(d=>d!==day).length%3===0;", "const amostraRevisao=true;"]]],
];

const eol = (s) => s.replace(/\r\n/g, "\n");
function stage() {
  const d = mkdtempSync(join(tmpdir(), "zev-blog-mut-"));
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
