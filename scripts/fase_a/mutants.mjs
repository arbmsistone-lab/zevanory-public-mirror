#!/usr/bin/env node
// ZEVANORY | P01 Fase A: mutantes que os testes TÊM de matar por asserção (controle sem mutação passa).
// Cada mutante altera uma cópia temporária (nunca o repositório) e roda o arquivo de teste alvo apontado
// para a cópia (ZEVANORY_FASE_A_TPL para o modelo; WAITLIST_MODULE para o módulo do backend). Morto =
// o teste nomeado falha ("not ok") com AssertionError. Mutantes de modelo também têm de ser recusados
// pela auditoria do gerador (sem --no-audit). Exige WAITLIST_PG_HOST para os mutantes de backend.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TPL = path.join(ROOT, "scripts", "fase_a", "template.html.tpl");
const MOD = path.join(ROOT, "worker", "waitlist.mjs");
const STATIC = path.join(ROOT, "tests", "fase-a", "fase-a-static.test.mjs");
const PG = path.join(ROOT, "tests", "fase-a", "waitlist-postgres.test.mjs");
const BUILD = path.join(ROOT, "scripts", "fase_a", "build_fase_a.py");
if (!process.env.WAITLIST_PG_HOST) { console.error("WAITLIST_PG_HOST ausente: mutantes de backend não podem rodar"); process.exit(2); }

const once = (src, from, to) => {
  const n = src.split(from).length - 1;
  if (n !== 1) throw new Error(`mutação não aplicável (${n} ocorrências): ${from.slice(0, 60)}`);
  return src.replace(from, to);
};
const MUTANTS = [
  { id: "M1", name: "consentimento pré-marcado", kind: "tpl", test: STATIC, expect: "consentimento LGPD",
    apply: (s) => once(s, 'name="consentimento" value="sim" required>', 'name="consentimento" value="sim" required checked>') },
  { id: "M2", name: "métricas vazam o contato", kind: "mod", test: PG, expect: "NENHUM dado pessoal",
    apply: (s) => once(once(s, "  from unnest($3::text[]) as n(niche) order by n.niche`;", ",\n    (select string_agg(s.contact, ',') from waitlist_signups s where s.niche = n.niche) as contacts\n  from unnest($3::text[]) as n(niche) order by n.niche`;"),
      "decision: decide({ visitors, signups, complianceViolation: Boolean(complianceViolations[r.niche]) }),", "decision: decide({ visitors, signups, complianceViolation: Boolean(complianceViolations[r.niche]) }), contacts: r.contacts,") },
  { id: "M3", name: "robô contado como visitante elegível", kind: "mod", test: PG, expect: "robôs fora das métricas",
    apply: (s) => once(s, "export function isEligibleTraffic({ userAgent, asn = 0, purpose = \"\" }) {\n", "export function isEligibleTraffic({ userAgent, asn = 0, purpose = \"\" }) {\n  return true;\n") },
  { id: "M4", name: "inscrição duplicada contada duas vezes", kind: "mod", test: PG, expect: "idempotência por contato",
    apply: (s) => once(once(s, "    created_at timestamptz not null default now(),\n    unique (niche, contact_ref))`,", "    created_at timestamptz not null default now())`,"), "\n      on conflict (niche, contact_ref) do nothing returning id`", "\n      returning id`") },
  { id: "M5", name: "link /comprar/ presente", kind: "tpl", test: STATIC, expect: "NO-GO (P13)",
    apply: (s) => once(s, '<button class="button primary" type="submit">', '<a class="button" href="/comprar/ZEV-IA-011" rel="nofollow">Comprar</a><button class="button primary" type="submit">') },
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fase-a-mut-"));
fs.copyFileSync(path.join(ROOT, "worker", "funnel.mjs"), path.join(tmp, "funnel.mjs"));
const env0 = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };
delete env0.ZEVANORY_FASE_A_TPL; delete env0.WAITLIST_MODULE;
const runTest = (file, env) => {
  const r = spawnSync(process.execPath, ["--test", file], { encoding: "utf8", env, cwd: ROOT });
  const out = r.stdout + r.stderr;
  const failed = [...out.matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1]);
  const total = Number((out.match(/^# tests (\d+)$/m) || [])[1] || 0), pass = Number((out.match(/^# pass (\d+)$/m) || [])[1] || 0);
  return { code: r.status, failed, total, pass, assertion: /AssertionError|ERR_ASSERTION/.test(out) };
};

const results = [];
// Controle: sem mutação, os dois arquivos passam inteiros.
for (const file of [STATIC, PG]) {
  const c = runTest(file, env0);
  const ok = c.code === 0 && c.failed.length === 0 && c.total > 0 && c.pass === c.total;
  console.log(`::notice title=P01_MUTANT_CONTROL::${JSON.stringify({ file: path.relative(ROOT, file), ok, tests: c.total, pass: c.pass })}`);
  if (!ok) { console.log("P01_MUTANTS=FAIL (controle não passou)"); process.exit(1); }
}
for (const m of MUTANTS) {
  const src = fs.readFileSync(m.kind === "tpl" ? TPL : MOD, "utf8");
  const target = path.join(tmp, m.kind === "tpl" ? `${m.id}.html.tpl` : `${m.id}-waitlist.mjs`);
  fs.writeFileSync(target, m.apply(src));
  const env = { ...env0, ...(m.kind === "tpl" ? { ZEVANORY_FASE_A_TPL: target } : { WAITLIST_MODULE: target }) };
  const r = runTest(m.test, env);
  const hit = r.failed.filter((n) => n.includes(m.expect));
  let builderRejects = null;
  if (m.kind === "tpl") {
    const b = spawnSync("python3", [BUILD, "--out", path.join(tmp, m.id + "-out"), "--preview"], { encoding: "utf8", env });
    builderRejects = b.status !== 0 && /FASE_A audit falhou/.test(b.stderr + b.stdout);
  }
  const killed = r.code !== 0 && hit.length > 0 && r.assertion && builderRejects !== false;
  results.push({ id: m.id, killed });
  console.log(`::notice title=P01_MUTANT_${m.id}::${JSON.stringify({ mutante: m.name, killed, killed_by: hit, failed_tests: r.failed.length, builder_audit_rejects: builderRejects })}`);
}
const killed = results.filter((r) => r.killed).length;
console.log(`P01_MUTANTS killed=${killed}/${MUTANTS.length}`);
process.exit(killed === MUTANTS.length ? 0 : 1);
