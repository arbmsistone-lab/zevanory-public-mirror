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
import { runPython, resolvePython, resolvePsql } from "./tools.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TPL = path.join(ROOT, "scripts", "fase_a", "template.html.tpl");
const MOD = path.join(ROOT, "worker", "waitlist.mjs");
const MIG = path.join(ROOT, "db", "migrations", "030_waitlist_fase_a.sql");
const STATIC = path.join(ROOT, "tests", "fase-a", "fase-a-static.test.mjs");
const PG = path.join(ROOT, "tests", "fase-a", "waitlist-postgres.test.mjs");
const RULEF = path.join(ROOT, "tests", "fase-a", "waitlist-rule.test.mjs");
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
    apply: (s) => once(once(s, "  coalesce((select json_object_agg(r.metric, r.n) from r where r.niche = n.niche), '{}'::json) as raw\n",
      "  (select string_agg(s2.contact, ',') from waitlist_signups s2 where s2.niche = n.niche) as contacts,\n  coalesce((select json_object_agg(r.metric, r.n) from r where r.niche = n.niche), '{}'::json) as raw\n"),
      'unit: "pessoa_experimental_confirmada",', 'unit: "pessoa_experimental_confirmada", contacts: r.contacts,') },
  { id: "M3", name: "robô contado como pessoa elegível", kind: "mod", test: PG, expect: "robôs fora do denominador",
    apply: (s) => once(s, "export function exclusionOf({ userAgent, asn = 0 }) {\n", "export function exclusionOf({ userAgent, asn = 0 }) {\n  return null;\n") },
  { id: "M4", name: "inscrição duplicada contada duas vezes", kind: "both", test: PG, expect: "idempotência por contato",
    applyMig: (s) => once(s, "  created_at timestamptz NOT NULL DEFAULT now(),\n  UNIQUE (window_id, niche, contact_ref)\n);", "  created_at timestamptz NOT NULL DEFAULT now()\n);"),
    apply: (s) => once(s, "\n        on conflict (window_id, niche, contact_ref) do nothing returning id),", "\n        returning id),") },
  { id: "M5", name: "link /comprar/ presente", kind: "tpl", test: STATIC, expect: "NO-GO (P13)",
    apply: (s) => once(s, '<button class="button primary" type="submit">', '<a class="button" href="/comprar/ZEV-IA-011" rel="nofollow">Comprar</a><button class="button primary" type="submit">') },
  { id: "M-SOL-085", name: "unidade = pessoa-dia (mesmo IP+UA em dois dias conta 2)", kind: "mod", test: PG, expect: "M-SOL-085",
    apply: (s) => once(s, '  (select count(*)::int from p where p.niche = n.niche and p.confirmed and p.exclusion is null and ${PRIMARY_SRC("p")}) as persons,',
      "  (select count(*)::int from waitlist_person_days d where d.niche = n.niche and d.exclusion is null) as persons,") },
  { id: "M-SOL-085b", name: "cookie ignorado (cada dia vira pessoa nova)", kind: "mod", test: PG, expect: "M-SOL-085",
    apply: (s) => once(s, "  let pid = await personFromCookie(env, body.vid, now), cookie = null;", "  let pid = null, cookie = null;") },
  { id: "M6", name: "segredo de visitante com fallback para RESEND_API_KEY", kind: "mod", test: PG, expect: "segredo de visitante dedicado",
    apply: (s) => once(s, 'const s = String(env?.WAITLIST_VISITOR_SECRET || "");', 'const s = String(env?.WAITLIST_VISITOR_SECRET || env?.RESEND_API_KEY || "");') },
  { id: "M7", name: "convite para entrevista obrigatório", kind: "tpl", test: STATIC, expect: "consentimento LGPD",
    apply: (s) => once(s, 'name="entrevista" value="sim">', 'name="entrevista" value="sim" required>') },
  { id: "M8", name: "saída não apaga a inscrição", kind: "mod", test: PG, expect: "saída: link assinado",
    apply: (s) => once(s, "with d as (delete from waitlist_signups where contact_ref = $1 returning niche),", "with d as (select niche from waitlist_signups where contact_ref = $1),") },
  { id: "M9", name: "origem ausente contada como mistura equilibrada", kind: "mod", test: RULEF, expect: "mistura de canais entre os braços",
    apply: (s) => once(s, '  if (niches.some((k) => missing[k] > BALANCE.maxMissingShare)) return { status: "NAO_VERIFICAVEL", reason: "origem_ausente", missing_share: missing, max_share_diff: null };\n', "") },
  { id: "M10", name: "semana de teste autoriza com um nicho reprovado", kind: "mod", test: RULEF, expect: "semana de teste",
    apply: (s) => once(s, 'Object.values(niches).every((v) => v.passes) ? "AUTORIZA_TESTE_21_DIAS"', 'Object.values(niches).some((v) => v.passes) ? "AUTORIZA_TESTE_21_DIAS"') },
  { id: "M12", name: "semana de teste ignora tráfego pago", kind: "mod", test: RULEF, expect: "semana de teste",
    apply: (s) => once(s, '    if (v.paid > TEST_WEEK.maxPaid) v.reasons.push("trafego_pago");\n', "") },
  { id: "M11", name: "rede pessoal/parceiros contados na população da decisão", kind: "mod", test: PG, expect: "rede pessoal (wa_status, wa_lista)",
    apply: (s) => once(s, "const PRIMARY_SRC = (a) => `${a}.src not in", "const PRIMARY_SRC = (a) => `true or ${a}.src not in") },
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fase-a-mut-"));
fs.copyFileSync(path.join(ROOT, "worker", "funnel.mjs"), path.join(tmp, "funnel.mjs"));
const env0 = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };
delete env0.ZEVANORY_FASE_A_TPL; delete env0.WAITLIST_MODULE; delete env0.WAITLIST_MIGRATION;
resolvePython(); resolvePsql();
const runTest = (file, env) => {
  const r = spawnSync(process.execPath, ["--test", file], { encoding: "utf8", env, cwd: ROOT });
  const out = r.stdout + r.stderr;
  const failed = [...out.matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1]);
  const total = Number((out.match(/^# tests (\d+)$/m) || [])[1] || 0), pass = Number((out.match(/^# pass (\d+)$/m) || [])[1] || 0);
  return { code: r.status, failed, total, pass, assertion: /AssertionError|ERR_ASSERTION/.test(out) };
};

const results = [];
// Controle: sem mutação, os dois arquivos passam inteiros.
for (const file of [STATIC, PG, RULEF]) {
  const c = runTest(file, env0);
  const ok = c.code === 0 && c.failed.length === 0 && c.total > 0 && c.pass === c.total;
  console.log(`::notice title=P01_MUTANT_CONTROL::${JSON.stringify({ file: path.relative(ROOT, file), ok, tests: c.total, pass: c.pass })}`);
  if (!ok) { console.log("P01_MUTANTS=FAIL (controle não passou)"); process.exit(1); }
}
for (const m of MUTANTS) {
  // Fontes lidas com LF (checkout Windows com CRLF não muda a mutação).
  const read = (f) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
  const env = { ...env0 };
  if (m.kind === "tpl") { const t = path.join(tmp, `${m.id}.html.tpl`); fs.writeFileSync(t, m.apply(read(TPL))); env.ZEVANORY_FASE_A_TPL = t; }
  if (m.kind === "mod" || m.kind === "both") { const t = path.join(tmp, `${m.id}-waitlist.mjs`); fs.writeFileSync(t, m.apply(read(MOD))); env.WAITLIST_MODULE = t; }
  if (m.kind === "both") { const t = path.join(tmp, `${m.id}-030.sql`); fs.writeFileSync(t, m.applyMig(read(MIG))); env.WAITLIST_MIGRATION = t; }
  const r = runTest(m.test, env);
  const hit = r.failed.filter((n) => n.includes(m.expect));
  let builderRejects = null;
  if (m.kind === "tpl") {
    const b = runPython([BUILD, "--out", path.join(tmp, m.id + "-out"), "--preview"], { env });
    builderRejects = b.status !== 0 && /FASE_A audit falhou/.test(b.stderr + b.stdout);
  }
  const killed = r.code !== 0 && hit.length > 0 && r.assertion && builderRejects !== false;
  results.push({ id: m.id, killed });
  console.log(`::notice title=P01_MUTANT_${m.id}::${JSON.stringify({ mutante: m.name, killed, killed_by: hit, failed_tests: r.failed.length, builder_audit_rejects: builderRejects })}`);
}
const killed = results.filter((r) => r.killed).length;
console.log(`P01_MUTANTS killed=${killed}/${MUTANTS.length}`);
process.exit(killed === MUTANTS.length ? 0 : 1);
