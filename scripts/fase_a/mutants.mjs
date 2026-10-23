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
const LIA = path.join(ROOT, "worker", "fase-a-lia.mjs");
const FUNNEL = path.join(ROOT, "worker", "funnel.mjs");
// Módulos copiados para o diretório de CADA mutante (o módulo testado importa os vizinhos pelo caminho relativo).
const WORKER_COPIES = ["waitlist.mjs", "funnel.mjs", "fase-a-lia.mjs", "fase-a-lia.generated.mjs"];
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
      "      unit: UNIT,\n      eligible_browsers:", "      unit: UNIT, contacts: r.contacts,\n      eligible_browsers:") },
  { id: "M3", name: "robô contado como pessoa elegível", kind: "mod", test: PG, expect: "robôs fora do denominador",
    apply: (s) => once(s, "export function exclusionOf({ userAgent, asn = 0 }) {\n", "export function exclusionOf({ userAgent, asn = 0 }) {\n  return null;\n") },
  { id: "M4", name: "inscrição duplicada contada duas vezes", kind: "both", test: PG, expect: "idempotência por contato",
    applyMig: (s) => once(s, "  created_at timestamptz NOT NULL DEFAULT now(),\n  UNIQUE (window_id, niche, contact_ref)\n);", "  created_at timestamptz NOT NULL DEFAULT now()\n);"),
    apply: (s) => once(s, "\n        on conflict (window_id, niche, contact_ref) do nothing returning id),", "\n        returning id),") },
  { id: "M5", name: "link /comprar/ presente", kind: "tpl", test: STATIC, expect: "NO-GO (P13)",
    apply: (s) => once(s, '<button class="button primary" type="submit">', '<a class="button" href="/comprar/ZEV-IA-011" rel="nofollow">Comprar</a><button class="button primary" type="submit">') },
  { id: "M-SOL-085", name: "unidade = navegador-dia (mesmo navegador em dois dias conta 2)", kind: "mod", test: PG, expect: "M-SOL-085",
    apply: (s) => once(s, '  (select count(*)::int from p where p.niche = n.niche and p.confirmed and p.exclusion is null and ${PRIMARY_SRC("p")}) as browsers,',
      '  (select coalesce(sum(p.days), 0)::int from p where p.niche = n.niche and p.confirmed and p.exclusion is null and ${PRIMARY_SRC("p")}) as browsers,') },
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
  { id: "M11", name: "wa_owned/parceiros contados na métrica primária (população da decisão)", kind: "mod", test: PG, expect: "wa_owned (wa_status, wa_lista) e parceiros (parc_*) ficam FORA da métrica primária",
    apply: (s) => once(s, "const PRIMARY_SRC = (a) => `${a}.src not in", "const PRIMARY_SRC = (a) => `true or ${a}.src not in") },
  // AVAL 092 §4: wa_status/wa_lista = classe wa_owned (fora da primária, reportada como secundária pré-registrada).
  { id: "M13", name: "wa_owned classificado como canal (entra na mistura da decisão e some da classe)", kind: "mod", test: RULEF, expect: "classe wa_owned pré-registrada",
    apply: (s) => once(s, '  if (WA_OWNED_TAGS.includes(tag)) return "wa_owned";\n', "") },
  { id: "M14", name: "métrica secundária wa_owned conta inscrições de qualquer origem", kind: "mod", test: PG, expect: "reportado como métrica secundária",
    apply: (s) => once(s, ' and ${WA_OWNED_IN("p")}) as signups_wa_owned,', ") as signups_wa_owned,") },
  // AVAL 092 §3: multi-nicho (1 por nicho visitado e confirmado, nunca 2 no mesmo) e multi-aparelho (alias consentido).
  { id: "M15", name: "confirmação num nicho confirma a pessoa em todos os nichos", kind: "mod", test: PG, expect: "multi-nicho",
    apply: (s) => once(s, "update waitlist_persons set confirmed = true where window_id = $1 and niche = $2 and person_id = $3 and not confirmed", "update waitlist_persons set confirmed = true where window_id = $1 and person_id = $3 and not confirmed") },
  { id: "M16", name: "denominador do nicho soma pessoas de outros nichos", kind: "mod", test: PG, expect: "multi-nicho",
    apply: (s) => once(s, '  (select count(*)::int from p where p.niche = n.niche and p.confirmed and p.exclusion is null and ${PRIMARY_SRC("p")}) as browsers,',
      '  (select count(*)::int from p where p.confirmed and p.exclusion is null and ${PRIMARY_SRC("p")}) as browsers,') },
  { id: "M17", name: "identidade consentida ignorada (mesmo contato em dois aparelhos conta 2 no denominador)", kind: "mod", test: PG, expect: "multi-aparelho",
    apply: (s) => once(s, "p as (select p.* from waitlist_persons p where p.window_id = $1 and not exists (select 1 from waitlist_person_alias a where a.window_id = p.window_id and a.niche = p.niche and a.alias_id = p.person_id)),",
      "p as (select p.* from waitlist_persons p where p.window_id = $1),") },
  // AVAL 099 §2: ativação amarrada ao sha256 da LIA aprovada (worker/fase-a-lia.mjs).
  { id: "M18", name: "endpoints de medição ignoram a trava da LIA", kind: "mod", test: PG, expect: "trava da LIA (AVAL 099)",
    apply: (s) => once(s, '    if (!act.active) return json(503, { ok: false, code: "lia_nao_aprovada", reason: act.reason });\n', "") },
  { id: "M19", name: "documento editado depois da aprovação continua ativo (hash não comparado)", kind: "lia", test: RULEF, expect: "trava da LIA (AVAL 099/101)",
    apply: (s) => once(s, '  if (want !== sha) return { ...base, approved_sha256_configured: true, reason: prefix + "_alterada_apos_aprovacao" };\n', "") },
  { id: "M20", name: "marcador de pendência ignorado", kind: "lia", test: RULEF, expect: "trava da LIA (AVAL 099/101)",
    apply: (s) => once(s, '  if (doc.pending_marker !== false) return { ...base, reason: prefix + "_pendente_de_revisao" };\n', "") },
  { id: "M21", name: "tabela de aprovação não conferida", kind: "lia", test: RULEF, expect: "trava da LIA (AVAL 099/101)",
    apply: (s) => once(s, '  if (!approvalComplete(doc.approval, doc.version)) return { ...base, reason: prefix + "_aprovacao_incompleta" };\n', "") },
  { id: "M22", name: "semana de teste conta sem LIA/ROPA aprovados", kind: "funnel", test: PG, expect: "semana de teste (funil das calculadoras",
    apply: (s) => once(s, " && (docs ? liaActivation(env, docs) : liaActivation(env)).active ?", " ?") },
  // AVAL 101: controles prometidos pela LIA v2.
  { id: "M23", name: "medição sem o sinal do aviso (pré-coleta ignorado)", kind: "mod", test: PG, expect: "aviso antes da coleta (AVAL 101 §3)",
    apply: (s) => once(once(s, '  if (String(body.aviso || "") !== AVISO_VERSION) return { counted: false, refused: "aviso_ausente" };\n', ""),
      '(String(body.aviso || "") !== AVISO_VERSION || optedOut(body))', "(optedOut(body))") },
  { id: "M24", name: "zvfa_optout/Sec-GPC ignorados no núcleo", kind: "mod", test: PG, expect: "não participação (AVAL 101 §4)",
    apply: (s) => once(s, "const optedOut = (body) => body?.optout === true || body?.gpc === true;", "const optedOut = (body) => false;") },
  { id: "M25", name: "não participar não apaga as linhas localizáveis", kind: "mod", test: PG, expect: "não participação (AVAL 101 §4)",
    apply: (s) => once(s, "    dp as (delete from waitlist_persons p using t where p.window_id = $1 and p.niche = t.niche and p.person_id = t.person_id returning p.niche, p.confirmed),",
      "    dp as (select t.niche, t.confirmed from t where false),") },
  { id: "M26", name: "derivado de IP+UA volta a ser persistido (tabela pessoa-dia)", kind: "both", test: PG, expect: "minimização (AVAL 101 §2)",
    applyMig: (s) => once(s, "INSERT INTO schema_migrations", "CREATE TABLE IF NOT EXISTS waitlist_person_days (day date NOT NULL, niche text NOT NULL, dhash text NOT NULL, PRIMARY KEY (day, niche, dhash));\n\nINSERT INTO schema_migrations"),
    apply: (s) => s },
  { id: "M27", name: "retenção ignora os 60 dias após o fim da janela", kind: "mod", test: PG, expect: "retenção (AVAL 101 §5)",
    apply: (s) => once(s, "delete from waitlist_persons where $1::boolean or window_end < $2::date", "delete from waitlist_persons where $1::boolean") },
  { id: "M28", name: "exclusão sem registro (waitlist_deletion_log)", kind: "mod", test: PG, expect: "não participação (AVAL 101 §4)",
    apply: (s) => once(s, "    l as (insert into waitlist_deletion_log (scope, trigger, n, result) select '${scope}', '${trigger}', count(*)::int, 'ok' from dp)", "    l as (select 1)") },
  { id: "M29", name: "agregado sem supressão de células pequenas", kind: "mod", test: RULEF, expect: "agregado anonimizado",
    apply: (s) => once(s, '  if (typeof value === "number") return Number.isInteger(value) && value > 0 && value < k ? `<${k}` : value;', '  if (typeof value === "number") return value;') },
  { id: "M30", name: "código de atendimento = identificador interno", kind: "mod", test: PG, expect: "pedido do titular por ação local",
    apply: (s) => once(s, "  const token = await dsrRefOf(secret, pid);\n", "  const token = pid;\n") },
  { id: "M31", name: "ROPA não exigido para ativar", kind: "lia", test: RULEF, expect: "trava da LIA (AVAL 099/101)",
    apply: (s) => once(s, "  const active = lia.active && ropa.active;", "  const active = lia.active;") },
  { id: "M32", name: "unidade volta a ser 'pessoa'", kind: "mod", test: RULEF, expect: "LIA v2",
    apply: (s) => once(s, 'export const UNIT = "navegador_dispositivo_pseudonimo";', 'export const UNIT = "pessoa_experimental_confirmada";') },
  { id: "M33", name: "cookie ultrapassa o fim da janela", kind: "mod", test: PG, expect: "aviso antes da coleta (AVAL 101 §3)",
    apply: (s) => once(s, "maxAge: Math.max(1, Math.min(Math.floor((endMs - now) / 1000), RETENTION.cookieMaxDays * 86400))", "maxAge: RETENTION.cookieMaxDays * 86400") },
  { id: "M34", name: "gatilho de medição no <head>, antes do aviso", kind: "tpl", test: STATIC, expect: "aviso de medição ANTES da coleta",
    apply: (s) => once(once(s, '<link rel="stylesheet" href="/lista-de-espera/a/{{slug}}.css?aviso={{aviso_version}}"></section>', "</section>"),
      '<link rel="stylesheet" href="/paginacao.css"></head>', '<link rel="stylesheet" href="/paginacao.css"><link rel="stylesheet" href="/lista-de-espera/a/{{slug}}.css?aviso={{aviso_version}}"></head>') },
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fase-a-mut-"));
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
  if (["mod", "both", "lia", "funnel"].includes(m.kind)) {
    const dir = path.join(tmp, m.id); fs.mkdirSync(dir, { recursive: true });
    for (const f of WORKER_COPIES) fs.copyFileSync(path.join(ROOT, "worker", f), path.join(dir, f));
    const target = { mod: MOD, both: MOD, lia: LIA, funnel: FUNNEL }[m.kind];
    fs.writeFileSync(path.join(dir, path.basename(target)), m.apply(read(target)));
    env.WAITLIST_MODULE = path.join(dir, "waitlist.mjs");
  }
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
