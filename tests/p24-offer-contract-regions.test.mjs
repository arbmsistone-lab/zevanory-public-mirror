// R4 (Sol ORDEM 301): o chat do site e a seção "O que você recebe" fazem parte do contrato da oferta. O PR #946 não
// pode remover nem enfraquecer nenhuma região que o gate P24 (scripts/p24/product_quality_check.py) exige.
// Este teste prova, sem rede:
//   R4.1 as regiões obrigatórias do P24 contêm o contrato fixado abaixo (seis regiões, com offer_receives) e,
//        quando o ref da base está disponível no git local, todas as regiões que a base exige;
//   R4.2 em cada página de produto gerada, toda região obrigatória extraída pelo próprio P24 tem itens, e
//        "O que você recebe" fica no bloco da oferta (div.offer-side), com os mesmos itens do recibo do topo e das
//        características essenciais do Resumo da oferta;
//   R4.3 o gate P24 passa no repositório e reprova se o bloco "O que você recebe" sumir de uma página (mutante);
//   R4.4 o chat continua anexável às mesmas páginas que a base cobre (todas as de produto), com os arquivos do widget
//        publicados, e o catálogo do chat cobre os cinco produtos sem conflito com as páginas.
// Rótulos [R4.n.k].
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SITE_CHAT_PAGES, injectSiteChatHtml } from "../worker/sales-public-worker.mjs";
import { CATALOG } from "../worker/site-chat.mjs";
import { readTextNormalized } from "./helpers/text.mjs";
import { requireTool } from "./helpers/toolchain.mjs";

const PYTHON = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
requireTool(PYTHON);
requireTool("git");
const readFileSync = (p) => readTextNormalized(p);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const P24 = "scripts/p24/product_quality_check.py";
const PRODUCTS = ["ia-na-pratica", "vendas-na-pratica", "lucro-e-caixa", "combo-ia-vendas", "negocio-completo"];
// Contrato da oferta fixado (gh-pages d01dd5ea): as seis regiões que o P24 exige em toda página de produto.
const CONTRACT_REGIONS = ["hero_receipt", "offer_receives", "essentials", "scope_features", "method_cards", "offer_method"];
const CONTRACT_CHAT_PAGES = ["solucoes", ...PRODUCTS, "conteudo-pronto", "termos", "privacidade", "reembolso"];
const env = { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" };

function py(code, args = [], cwd = ROOT) {
  const r = spawnSync(PYTHON, ["-I", "-c", code, ...args], { cwd, env, encoding: "utf-8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return r.stdout;
}
const REGIONS_OF = `import ast,sys
src=sys.stdin.read() if sys.argv[1]=="-" else open(sys.argv[1],encoding="utf-8").read()
for n in ast.parse(src).body:
    if isinstance(n,ast.Assign) and any(getattr(t,"id","")=="REQUIRED_REGIONS" for t in n.targets):
        print(",".join(ast.literal_eval(n.value)))`;
function requiredRegions(source) {
  const r = spawnSync(PYTHON, ["-I", "-c", REGIONS_OF, "-"], { cwd: ROOT, env, input: source, encoding: "utf-8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim().split(",").filter(Boolean);
}
function baseRef() {
  for (const ref of [process.env.R4_BASE_REF, process.env.GITHUB_BASE_REF && `origin/${process.env.GITHUB_BASE_REF}`, "origin/gh-pages"].filter(Boolean)) {
    const r = spawnSync("git", ["-C", ROOT, "rev-parse", "--verify", "--quiet", ref + "^{commit}"], { encoding: "utf-8" });
    if (r.status === 0) return ref;
  }
  return null;
}
function gitShow(ref, path) {
  const r = spawnSync("git", ["-C", ROOT, "show", `${ref}:${path}`], { encoding: "utf-8", maxBuffer: 64 << 20 });
  return r.status === 0 ? r.stdout : null;
}
const EXTRACT = `import json,sys
sys.path.insert(0,"scripts/p24")
import product_quality_check as q
print(json.dumps({s: q.extract_promises(open("sales-public/"+s+".html",encoding="utf-8").read()) for s in sys.argv[1:]}, ensure_ascii=False))`;

test("R4.1 o P24 exige as seis regiões do contrato da oferta e tudo o que a base exige", (t) => {
  const head = requiredRegions(readFileSync(join(ROOT, P24)));
  for (const r of CONTRACT_REGIONS) assert.ok(head.includes(r), `[R4.1.1] região do contrato ausente do P24: ${r}`);
  const ref = baseRef();
  const baseSrc = ref && gitShow(ref, P24);
  if (!baseSrc) { t.diagnostic("ref da base indisponível no git local; vale o contrato fixado"); return; }
  for (const r of requiredRegions(baseSrc)) assert.ok(head.includes(r), `[R4.1.2] região exigida pela base (${ref}) removida do P24: ${r}`);
  const map = JSON.parse(readFileSync(join(ROOT, "data/p24/promise-map.json")));
  for (const r of CONTRACT_REGIONS) assert.ok(map.extraction[r], `[R4.1.3] promise-map sem a extração de ${r}`);
});

test("R4.2 toda página de produto tem cada região obrigatória; 'O que você recebe' fica no bloco da oferta", () => {
  const got = JSON.parse(py(EXTRACT, PRODUCTS));
  for (const slug of PRODUCTS) {
    for (const r of CONTRACT_REGIONS) assert.ok(got[slug][r].length > 0, `[R4.2.1] ${slug}: região ${r} vazia`);
    assert.deepEqual(got[slug].offer_receives, got[slug].hero_receipt, `[R4.2.2] ${slug}: 'O que você recebe' da oferta difere do recibo do topo`);
    assert.deepEqual(got[slug].offer_receives.map((s) => s.replace(/\.$/, "")), got[slug].essentials, `[R4.2.3] ${slug}: difere das características essenciais`);
    const html = readFileSync(join(ROOT, "sales-public", slug + ".html"));
    const side = html.indexOf('<div class="offer-side">');
    const cta = html.indexOf("data-zev-sku=", side);
    const block = html.indexOf("<h3>O que você recebe</h3>", side);
    assert.ok(side > 0 && block > side && block < cta, `[R4.2.4] ${slug}: 'O que você recebe' fora do bloco da oferta, antes do CTA`);
  }
});

test("R4.3 o gate P24 passa e reprova quando o bloco 'O que você recebe' some de uma página", () => {
  const ok = spawnSync(PYTHON, ["-I", P24], { cwd: ROOT, env, encoding: "utf-8" });
  assert.equal(ok.status, 0, "[R4.3.1] " + ok.stdout + ok.stderr);
  assert.match(ok.stdout, /P24_GATE=PASS/, "[R4.3.2]");
  const dir = mkdtempSync(join(tmpdir(), "r4-p24-"));
  try {
    for (const p of ["data/p24", "data/products.json", "worker/cloudflare-worker.recovered.mjs", "scripts/p24", "sales-public"]) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      cpSync(join(ROOT, p), join(dir, p), { recursive: true, filter: (s) => !s.includes("__pycache__") });
    }
    const page = join(dir, "sales-public/lucro-e-caixa.html");
    const html = readFileSync(page);
    const mutated = html.replace(/<h3>O que você recebe<\/h3><ul>.*?<\/ul>/s, "");
    assert.notEqual(mutated, html, "[R4.3.3] âncora do mutante ausente");
    writeFileSync(page, mutated);
    const bad = spawnSync(PYTHON, ["-I", "scripts/p24/product_quality_check.py", "--root", dir], { cwd: dir, env, encoding: "utf-8" });
    assert.notEqual(bad.status, 0, "[R4.3.4] P24 não reprovou sem 'O que você recebe': " + bad.stdout);
    assert.match(bad.stdout + bad.stderr, /lucro-e-caixa: regi.{1,4}o de promessas 'offer_receives' n.{1,4}o encontrada/, "[R4.3.5]");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R4.4 o chat cobre as mesmas páginas da base, com o widget publicado e o catálogo dos cinco produtos", () => {
  for (const p of CONTRACT_CHAT_PAGES) assert.ok(SITE_CHAT_PAGES.has(p), `[R4.4.1] chat não é mais anexado a ${p}`);
  const ref = baseRef();
  const base = ref && gitShow(ref, "worker/sales-public-worker.mjs");
  const m = base && /SITE_CHAT_PAGES=Object\.freeze\(new Set\((\[[^\]]*\])\)\)/.exec(base);
  if (m) for (const p of JSON.parse(m[1])) assert.ok(SITE_CHAT_PAGES.has(p), `[R4.4.2] página com chat na base (${ref}) perdeu o chat: ${p}`);
  for (const f of ["site-chat.js", "site-chat.css"]) {
    assert.ok(existsSync(join(ROOT, "sales-public", f)), `[R4.4.3] sales-public/${f} ausente`);
    assert.ok(existsSync(join(ROOT, "sales-overlay", f)), `[R4.4.4] sales-overlay/${f} ausente`);
  }
  for (const slug of PRODUCTS) {
    const out = injectSiteChatHtml(readFileSync(join(ROOT, "sales-public", slug + ".html")));
    assert.ok(out.includes('<script src="/site-chat.js" defer></script></body>') && out.includes('href="/site-chat.css"'), `[R4.4.5] ${slug}: widget não anexável`);
  }
  assert.equal(CATALOG.ok, true, "[R4.4.6] catálogo do chat com conflito ou desatualizado: " + JSON.stringify({ missing: CATALOG.missing, conflicts: CATALOG.conflicts }));
  for (const slug of PRODUCTS) assert.ok(CATALOG.items[slug], `[R4.4.7] catálogo do chat sem ${slug}`);
  // O resumo do chat com vendas fechadas descreve a oferta: não pode voltar à promessa antiga ("mensagens de venda")
  // nem divergir do resumo aprovado na base.
  const cp = CATALOG.items["conteudo-pronto"]?.closedSummary || "";
  assert.match(cp, /roteiros multicanal de venda e acompanhamento/, "[R4.4.8] resumo do Conteúdo Pronto no chat sem os roteiros multicanal");
  assert.doesNotMatch(cp, /mensagens de venda/i, "[R4.4.9] resumo do Conteúdo Pronto no chat voltou a 'mensagens de venda'");
  const basePolicy = ref && gitShow(ref, "data/site-chat-policy.json");
  if (basePolicy) {
    const head = JSON.parse(readFileSync(join(ROOT, "data/site-chat-policy.json"))).closed_summaries || {};
    for (const [slug, text] of Object.entries(JSON.parse(basePolicy).closed_summaries || {}))
      assert.equal(head[slug], text, `[R4.4.10] resumo fechado do chat para ${slug} difere da base (${ref})`);
  }
});
