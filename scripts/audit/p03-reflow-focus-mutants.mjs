// P03 — mutantes do gate reflow/foco (pedido da auditoria do Sol). Cada mutante altera uma CÓPIA de
// sales-public (nunca o repositório), serve em localhost e roda p03-reflow-focus.mjs num subconjunto de
// páginas (jurídica, calculadora, venda longa, guia com <details>). Esperado: M0 (controle) PASSA e todo
// outro mutante FALHA o gate (KILLED). Um mutante que sobrevive, ou cuja troca de texto não se aplica,
// falha este passo. Emite uma linha ::notice MUTANT por mutante.
// Uso: node p03-reflow-focus-mutants.mjs <salesPublicDir> <outJson>
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATE = path.join(HERE, "p03-reflow-focus.mjs");
const [src, outJson = "p03-reflow-focus-mutants.json"] = process.argv.slice(2);
if (!src) { console.error("usage: <salesPublicDir> [outJson]"); process.exit(2); }
const SUB = ["termos.html", "calculadora-cmv.html", "ia-na-pratica.html", "como-cobrar-cliente-pelo-whatsapp.html"];
const PORT = 8793;

const edit = (file, old, neu) => (site) => {
  const p = path.join(site, file);
  const s = fs.readFileSync(p, "utf8");
  const hit = typeof old === "string" ? s.includes(old) : old.test(s);
  if (!hit) throw new Error(`MUTANT_NOT_APPLIED ${file}: ${String(old).slice(0, 60)}`);
  fs.writeFileSync(p, s.replace(old, neu));
};
const MUTANTS = [
  ["M0_controle_sem_mutacao", null, () => {}],
  // Mutantes do próprio Sol
  ["MA_sol_remove_texto_do_anuncio_em_ir", "focus", edit("paginacao.js", /\n\s*if \(mudou \|\| foco\) anuncio\.textContent = [^\n]*\n/, "\n")],
  ["MB_sol_remove_aria_live", "focus", edit("paginacao.js", '"aria-live": "polite", ', "")],
  ["MC_sol_grade_fixa_5_colunas", "reflow", edit("paginacao.css", "grid-template-columns:repeat(auto-fill,minmax(44px,1fr))", "grid-template-columns:repeat(5,44px)")],
  ["MC2_indice_css_antigo_completo", "reflow", (s) => {
    edit("paginacao.css", ".pg-indice{position:static}", ".pg-indice{position:relative}")(s);
    edit("paginacao.css", "box-sizing:border-box;width:min(calc(100% - 16px),400px);display:grid;grid-template-columns:repeat(auto-fill,minmax(44px,1fr))", "display:grid;grid-template-columns:repeat(5,44px)")(s);
  }],
  // Mutantes das correções/checagens novas
  // AVAL 086 do Sol: botões só com ícone abaixo de 300 px (o comportamento anterior) tem de morrer.
  ["MM_sol_so_icone_abaixo_de_300px", "reflow", (s) => fs.appendFileSync(path.join(s, "paginacao.css"), "\n@media(max-width:300px){.pg-rot{position:absolute!important;width:4px!important;height:4px!important;overflow:hidden!important;clip:rect(0 0 0 0)!important;white-space:nowrap!important}}\n")],
  // Rótulo curto que não é parte do nome acessível (viola 2.5.3).
  ["MN_rotulo_curto_fora_do_nome", "reflow", (s) => { edit("paginacao.js", ">Ant</span>", ">Volta</span>")(s); edit("paginacao.js", ">Próx</span>", ">Segue</span>")(s); }],
  // Rótulo curto sempre (sem medir): a forma por extenso nunca aparece quando cabe.
  ["MO_rotulo_curto_sem_medir", "reflow", edit("paginacao.js", "    if (!cabe) nav.classList.add(\"pg-curtos\");", "    nav.classList.add(\"pg-curtos\");")],
  ["MD_sem_modo_corpo_tela_baixa", "reflow", edit("paginacao.js", 'const m = querCorpo() ? "corpo" : "main";', 'const m = "main";')],
  ["ME_indice_sem_janela", "reflow", edit("paginacao.js", "return Math.max(3, cols * linhasCabem);", "return Infinity;")],
  ["MF_folga_revela_linha_vizinha", "reflow", edit("paginacao.js", "const topo = ant ? Math.max(ini, Math.min(b.ini, ant.fim)) : ini;", "const topo = ini;")],
  ["MG_foco_nao_vai_ao_titulo", "focus", edit("paginacao.js", "    if (foco) {\n", "    if (false) {\n")],
  ["MH_sem_contorno_de_foco", "focus", (s) => fs.appendFileSync(path.join(s, "paginacao.css"), "\n*:focus,*:focus-visible{outline:none!important;box-shadow:none!important}\n")],
  ["MI_hash_da_carga_ignorado", "hash", edit("paginacao.js", "  if (location.hash) irParaHash(false);", "")],
  // Defeito real achado pela suíte hash: com prefers-reduced-motion, "transition: all .01ms" do
  // product.css deixava o <main> com altura 0 na 1ª medição e #bloco-N abria o bloco 1 (TypeError).
  // Há duas proteções independentes (montagem sem transição + fila do hash); remover só uma é
  // mutante equivalente (sobrevive, registrado no relatório), por isso o mutante remove as duas.
  ["MJ_reduced_motion_sem_as_duas_protecoes", "hash", (s) => {
    edit("paginacao.js", "    if (!blocos.length) { hashPendente = true; return false; }\n", "")(s);
    edit("paginacao.css", "html.pg-montando,html.pg-montando *{transition:none!important}", "")(s);
  }],
  ["MK_details_reflow_perde_ancora", "details", edit("paginacao.js", "const i = intencao !== null ? intencao : blocoDe(ancora);", "const i = intencao !== null ? intencao : 0;")],
  ["ML_landmarks_dentro_do_main", "aria", edit("paginacao.js", "const cont = m === \"corpo\" ? corpo : main;", "const cont = main; if (m === \"corpo\") for (const e of document.querySelectorAll(\"body > header, body > footer\")) e.setAttribute(\"role\", \"presentation\");")],
];

function run(cmd, args, opts) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, opts);
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out }));
  });
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p03mut-"));
const sub = path.join(tmp, "sub");
fs.mkdirSync(sub);
for (const f of SUB) fs.copyFileSync(path.join(src, f), path.join(sub, f)); // conteúdo real (detecção de <details>)
const results = [];
let bad = false;
// P03MUT_ONLY=nome1,nome2 roda só esses (depuração local; o CI roda todos).
const ONLY = process.env.P03MUT_ONLY ? process.env.P03MUT_ONLY.split(",") : null;
for (const [name, suite, apply] of MUTANTS.filter(([n]) => !ONLY || ONLY.includes(n))) {
  const site = path.join(tmp, "site");
  fs.rmSync(site, { recursive: true, force: true });
  fs.cpSync(src, site, { recursive: true });
  let applied = true, err = "";
  try { apply(site); } catch (e) { applied = false; err = String(e.message); }
  let verdict, code = null, summary = "", fails = [];
  if (!applied) { verdict = "NOT_APPLIED"; }
  else {
    const srv = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1", "--directory", site], { stdio: "ignore" });
    for (let i = 0; i < 40; i++) { if (spawnSync("curl", ["-fsS", "-o", "/dev/null", `http://127.0.0.1:${PORT}/termos.html`]).status === 0) break; await new Promise((r) => setTimeout(r, 250)); }
    const r = await run("node", [GATE, `http://127.0.0.1:${PORT}`, sub, String(SUB.length), path.join(tmp, "out-" + name)], { cwd: process.cwd(), env: process.env });
    srv.kill();
    code = r.code;
    summary = (r.out.match(/P03_REFLOW_FOCUS=(PASS|FAIL)/) || [])[1] || "?";
    fails = [...new Set(r.out.split("\n").filter((l) => l.includes("P03RF_FAIL")).map((l) => { try { const d = JSON.parse(l.split("::").slice(2).join("::")); return d.suite + ":" + d.problems.map((p) => p.replace(/(_b\d+.*|:.*)$/, "")).join("+"); } catch { return "?"; } }))].slice(0, 4);
    verdict = name.startsWith("M0") ? (code === 0 ? "PASS" : "CONTROL_FAILED") : code !== 0 ? "KILLED" : "SURVIVED";
  }
  if (!["PASS", "KILLED"].includes(verdict)) bad = true;
  results.push({ mutant: name, target_suite: suite, verdict, exit: code, gate: summary, evidence: fails, error: err || undefined });
  console.log(`MUTANT ${name} ${verdict} (exit=${code}${suite ? `, alvo=${suite}` : ""}) ${fails.join(" | ").slice(0, 300)}`);
}
fs.writeFileSync(outJson, JSON.stringify({ schema: "zevanory.p03.reflow-focus-mutants.v1", pages: SUB, results }, null, 1));
const killed = results.filter((r) => r.verdict === "KILLED").length;
// Uma única anotação com a tabela (o GitHub mostra no máximo 10 anotações de cada tipo por passo).
console.log("::notice title=P03_MUTANTS_TABLE::" + results.map((r) => `MUTANT ${r.mutant} ${r.verdict}${r.target_suite ? " [" + r.target_suite + "]" : ""}${r.evidence.length ? " <- " + r.evidence.slice(0, 2).join(" | ").slice(0, 120) : ""}${r.error ? " " + r.error.slice(0, 80) : ""}`).join("%0A"));
const control = results.find((r) => r.mutant.startsWith("M0"));
console.log(`::notice title=P03_REFLOW_FOCUS_MUTANTS::${killed}/${results.filter((r) => !r.mutant.startsWith("M0")).length} killed; control=${control ? control.verdict : "not-run"}`);
console.log(bad ? "P03_REFLOW_FOCUS_MUTANTS=FAIL" : "P03_REFLOW_FOCUS_MUTANTS=PASS");
fs.rmSync(tmp, { recursive: true, force: true });
if (bad) process.exit(1);
