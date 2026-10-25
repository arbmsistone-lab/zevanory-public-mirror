// Fora de tests/*.test.mjs de propósito: executa scripts/ci/production-worker-state.sh de verdade em bash, com
// `curl` e `npx` falsos no PATH (sem rede, sem credencial). Rodado por credential-separation-behaviour.yml e
// credential-separation-gate.yml (Linux). Motivo: o run 40142599036 do readback saiu com código 1 sem NENHUMA linha de
// log; cada caminho de erro agora tem de emitir ::error title=WORKER_STATE::<etapa> failed (http=...) com diagnóstico
// redigido, nunca o token nem um valor. Marcadores [Wn.k].
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readTextNormalized } from "../helpers/text.mjs";
import { requireTool } from "../helpers/toolchain.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TOKEN = "cfut_TOKEN_SENTINELA_0123456789abcdefghijklmnop";
const VALUE = "VALOR-DE-VAR-QUE-NUNCA-PODE-APARECER-987654321";
// Valores adversariais (Sol 229): curto, partido entre linhas, embutido em JSON, com formatação estranha.
const SHORT = "Zq9", SPLIT_A = "PARTE-ALFA-", SPLIT_B = "PARTE-BETA-77", JSONV = "JSONVAL-4242", ODD = "ODD\u001b[31mVAL\tUE";
const ADVERSARIAL = [SHORT, SPLIT_A, SPLIT_B, JSONV, "ODD", "VAL\tUE"];
const V0 = "00000000-0000-4000-8000-000000000000", V1 = "11111111-1111-4111-8111-111111111111";
const ok = (result) => ({ code: 200, body: { success: true, errors: [], messages: [], result } });
const bindings = [{ name: "ZEVANORY_DEPLOYMENT_ENV", type: "plain_text", text: "production" }, { name: "PUBLIC_BASE_URL", type: "plain_text", text: VALUE },
  { name: "DATABASE_URL", type: "secret_text" }];
const dep = (...vs) => ok({ deployments: vs.map((v, i) => ({ id: v.replace(/^./, "d"), created_on: `2026-10-${24 - i}T00:00:00Z`, versions: [{ version_id: v, percentage: 100 }] })) });
const ver = (id, etag = "e1", trig = "upload") => ok({ id, number: 2, annotations: { "workers/triggered_by": trig }, resources: { bindings, script: { etag, handlers: ["fetch"] }, script_runtime: { compatibility_date: "2025-01-01", compatibility_flags: [] } } });
// Cenário base: tudo responde bem. Chave = trecho da URL (o primeiro que casar vence; ordem importa).
const BASE = () => ({
  wrangler: { exit: 0, stdout: JSON.stringify([{ name: "DATABASE_URL", type: "secret_text" }]), stderr: "" },
  http: [
    ["/workers/scripts/zevanory/settings", ok({ bindings })],
    ["/workers/scripts/zevanory/script-settings", ok({ logpush: false })],
    ["/workers/scripts/zevanory/deployments", dep(V0, V1)],
    [`/workers/scripts/zevanory/versions/${V0}`, ver(V0)],
    [`/workers/scripts/zevanory/versions/${V1}`, ver(V1, "e1", "upload")],
    ["/workers/scripts/zevanory/versions?", ok({ items: [{ id: V0, number: 2, metadata: { created_on: "2026-10-24T00:00:00Z" }, annotations: { "workers/triggered_by": "secret" } }, { id: V1, number: 1, metadata: { created_on: "2026-10-23T00:00:00Z" } }] })],
    ["/workers/scripts", ok([{ id: "zevanory" }, { id: "outro" }])],
    ["/tokens/verify", ok({ status: "active", id: "tok" })],
    ["/api/release", { code: 200, body: { sales_mode: "globally-blocked", deployment: { commit_sha: "a".repeat(40) } } }],
  ],
});

function sandbox(scenario) {
  const dir = mkdtempSync(join(tmpdir(), "zev-worker-state-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(dir, "scenario.json"), JSON.stringify(scenario));
  // curl falso: devolve o corpo do cenário em -o e o código em -w; registra o cabeçalho Authorization só como "presente".
  writeFileSync(join(bin, "curl"), `#!/usr/bin/env node
const fs=require("fs");const s=JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, "scenario.json"))},"utf8"));
const a=process.argv.slice(2);const url=a.find(x=>/^https?:/.test(x));const o=a[a.indexOf("-o")+1];
const hit=s.http.find(([k])=>url.includes(k));
fs.appendFileSync(${JSON.stringify(join(dir, "calls.log"))},url+"\\n");
if(!hit){process.stderr.write("curl: (6) Could not resolve host\\n");process.exit(6)}
const [,r]=hit;if(r.exit){process.stderr.write("curl: ("+r.exit+") falha simulada "+${JSON.stringify(TOKEN)}+"\\n");process.exit(r.exit)}
fs.writeFileSync(o,typeof r.body==="string"?r.body:JSON.stringify(r.body));
if(a.includes("-w"))process.stdout.write(String(r.code));
if(a.includes("-f")&&r.code>=400){process.stderr.write("curl: (22) The requested URL returned error: "+r.code+"\\n");process.exit(22)}
`);
  writeFileSync(join(bin, "npx"), `#!/usr/bin/env node
const fs=require("fs");const s=JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, "scenario.json"))},"utf8")).wrangler;
process.stdout.write(s.stdout);process.stderr.write(s.stderr);process.exit(s.exit);
`);
  chmodSync(join(bin, "curl"), 0o755);
  chmodSync(join(bin, "npx"), 0o755);
  return { dir, bin };
}

function run(scenario, script) {
  requireTool("bash");
  const { dir, bin } = sandbox(scenario);
  try {
    const r = spawnSync("bash", ["-c", `set -euo pipefail\nsource scripts/ci/production-worker-state.sh\n${script}`], {
      cwd: ROOT, encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: "1b26415802588185a86c1d4d3ebf5bdb",
        CLOUDFLARE_TOKEN_SOURCE: "CLOUDFLARE_PUBLIC_OWNER_API_TOKEN", OUT: join(dir, "out"), NODE_NO_WARNINGS: "1" } });
    const calls = existsSync(join(dir, "calls.log")) ? readTextNormalized(join(dir, "calls.log")) : "";
    const hist = existsSync(join(dir, "history.json")) ? readTextNormalized(join(dir, "history.json")) : null;
    return { code: r.status, out: String(r.stdout || "") + String(r.stderr || ""), calls, hist, dir };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const fetchState = 'rc=0; zev_fetch_state "$OUT" || rc=$?; echo "RC=$rc"; ls "$OUT" | sort | tr "\\n" " "; echo';
const safe = (out, label) => {
  assert.ok(!out.includes(TOKEN) && !out.includes("SENTINELA"), `[${label}] o token nunca aparece`);
  for (const a of ADVERSARIAL) assert.ok(!out.includes(a), `[${label}] valor adversarial nunca aparece: ${JSON.stringify(a)}`);
  assert.ok(!out.includes(VALUE), `[${label}] valor de var nunca aparece`);
};

test("W1 caminho feliz: coleta completa, origem do token só pelo nome e a conta", () => {
  const r = run(BASE(), fetchState);
  assert.match(r.out, /^RC=0$/m, "[W1.1] coleta passa");
  assert.match(r.out, /^deployments\.json release\.json secrets\.json settings\.json version\.json $/m, "[W1.1] os 5 arquivos, sem sobras (stderr do wrangler e do curl apagados)");
  assert.match(r.out, /^WORKER_STATE credential_source=CLOUDFLARE_PUBLIC_OWNER_API_TOKEN token_present=yes account=1b26415802588185a86c1d4d3ebf5bdb$/m, "[W1.2] origem do token pelo nome e conta");
  assert.match(r.out, new RegExp(`^WORKER_STATE effective_version=${V0}$`, "m"), "[W1.3] versão efetiva impressa");
  assert.doesNotMatch(r.out, /::error/, "[W1.4] nenhum erro no caminho feliz");
  safe(r.out, "W1.5");
});

test("W2 wrangler secret list falha: ::error, só a CLASSE do erro e códigos numéricos, diagnóstico", () => {
  const s = BASE();
  s.wrangler = { exit: 1, stdout: "", stderr: `\n✘ [ERROR] A request to the Cloudflare API (/accounts/1b26/workers/scripts/zevanory/secrets) failed.\n  Authentication error [code: 10000]\nusing token ${TOKEN}\nvalor=${SHORT} ${SPLIT_A}\n${SPLIT_B} {"text":"${JSONV}"} ${ODD}\n` };
  const r = run(s, fetchState);
  assert.match(r.out, /^RC=1$/m, "[W2.1] coleta falha");
  assert.match(r.out, /^::error title=WORKER_STATE::wrangler secret list failed \(exit=1\)$/m, "[W2.1] erro nomeado");
  assert.match(r.out, /^WORKER_STATE wrangler: classification=AUTH_ERROR cf_codes=10000$/m, "[W2.2] stderr do wrangler vira classe enumerada + códigos numéricos");
  assert.ok(!r.out.includes("A request to the Cloudflare API") && !r.out.includes("using token"), "[W2.2] nenhuma linha crua do wrangler");
  assert.match(r.out, /^WORKER_STATE diagnose token_verify_account http=200$/m, "[W2.3] diagnóstico: token");
  assert.match(r.out, /^WORKER_STATE diagnose scripts_list count=2 zevanory_listed=true$/m, "[W2.3] diagnóstico: a conta lista o zevanory");
  assert.match(r.out, /^WORKER_STATE diagnose script_settings http=200$/m, "[W2.3] diagnóstico: settings x script-settings");
  const s2 = BASE(); s2.wrangler = { exit: 0, stdout: "não é json", stderr: "" };
  assert.match(run(s2, fetchState).out, /^::error title=WORKER_STATE::wrangler secret list failed \(exit=0\)$/m, "[W2.4] saída que não é lista JSON também falha alto");
  safe(r.out, "W2.5");
});

test("W3 settings 403: ::error com http e errors[].code/message da Cloudflare, diagnóstico das causas", () => {
  const s = BASE();
  s.http.unshift(["/workers/scripts/zevanory/settings", { code: 403, body: { success: false, errors: [{ code: 10000, message: "Authentication error" }, { code: 10000, message: `Authentication error ${TOKEN}` },
    { code: 7003, message: SHORT }, { code: 7000, message: `${SPLIT_A}\n${SPLIT_B}` }, { code: 1, message: JSON.stringify({ text: JSONV }) }], result: null } }]);
  const r = run(s, fetchState);
  assert.match(r.out, /^RC=1$/m, "[W3.1] coleta falha");
  assert.match(r.out, /^::error title=WORKER_STATE::settings failed \(http=403 curl_exit=0\)$/m, "[W3.1] etapa e código HTTP");
  assert.match(r.out, /^WORKER_STATE settings: CF_ERROR code=10000 message=Authentication error$/m, "[W3.2] mensagem conhecida (allowlist exata) aparece");
  assert.equal((r.out.match(/^WORKER_STATE settings: CF_ERROR code=\d+ message=<redacted:unknown>$/gm) || []).length, 4, "[W3.2] qualquer outra mensagem vira <redacted:unknown>, com o código numérico");
  assert.match(r.out, /^WORKER_STATE diagnose settings http=403$/m, "[W3.3] diagnóstico repete settings");
  assert.match(r.out, /^WORKER_STATE diagnose deployments http=200$/m, "[W3.3] diagnóstico testa deployments");
  assert.match(r.out, /^WORKER_STATE diagnose versions http=200$/m, "[W3.3] diagnóstico testa versions");
  safe(r.out, "W3.4");
});

test("W4 deployments e versão: falha de rede, version-id inválido e versão sem detalhe falham alto", () => {
  const net = BASE(); net.http.unshift(["/workers/scripts/zevanory/deployments", { exit: 28 }]);
  const a = run(net, fetchState);
  assert.match(a.out, /^::error title=WORKER_STATE::deployments failed \(http=000 curl_exit=28\)$/m, "[W4.1] timeout/rede: http=000 e código do curl");
  assert.ok(!a.out.includes("falha simulada") && !/^WORKER_STATE curl:/m.test(a.out), "[W4.1] stderr do curl nunca é impresso");
  const empty = BASE(); empty.http.unshift(["/workers/scripts/zevanory/deployments", ok({ deployments: [] })]);
  const b = run(empty, fetchState);
  assert.match(b.out, /^::error title=WORKER_STATE::version-id failed \(exit=2\) INPUT_INVALID deployments_empty$/m, "[W4.2] motivo do version-id no ::error (antes ia para dentro de $(...))");
  const gradual = BASE(); gradual.http.unshift(["/workers/scripts/zevanory/deployments", ok({ deployments: [{ id: "d", created_on: "2026-10-24T00:00:00Z", versions: [{ version_id: V0, percentage: 60 }, { version_id: V1, percentage: 40 }] }] })]);
  assert.match(run(gradual, fetchState).out, /^::error title=WORKER_STATE::version-id failed \(exit=1\) NO_SINGLE_VERSION /m, "[W4.3] rollout gradual nomeado");
  const nover = BASE(); nover.http.unshift([`/workers/scripts/zevanory/versions/${V0}`, { code: 404, body: { success: false, errors: [{ code: 10007, message: "version not found" }] } }]);
  const c = run(nover, fetchState);
  assert.match(c.out, new RegExp(`^::error title=WORKER_STATE::versions/${V0} failed \\(http=404 curl_exit=0\\)$`, "m"), "[W4.4] detalhe da versão");
  assert.match(c.out, /^RC=1$/m, "[W4.4] coleta falha");
  safe(a.out + b.out + c.out, "W4.5");
});

test("W5 /api/release falha: release_status=FAILED explícito; o readback não emite D0/V0 e falha", () => {
  const s = BASE(); s.http.unshift(["/api/release", { code: 503, body: `<html>${SHORT}</html>` }]);
  const r = run(s, `${fetchState}
cat "$OUT/release.json"; echo
rb=0; node scripts/ci/production-secret-names.mjs readback --secrets "$OUT/secrets.json" --settings "$OUT/settings.json" --deployments "$OUT/deployments.json" --version-detail "$OUT/version.json" --release "$OUT/release.json" || rb=$?
echo "READBACK_RC=$rb"`);
  assert.match(r.out, /^::error title=WORKER_STATE::release failed \(http=503 curl_exit=0\)$/m, "[W5.1] erro nomeado");
  assert.match(r.out, /^WORKER_STATE release_status=FAILED \(http=503\)$/m, "[W5.1] falha explícita do release");
  assert.match(r.out, /^\{"diagnostic_only":"release_failed","http":"503"\}$/m, "[W5.1] release.json marcado como só diagnóstico");
  assert.match(r.out, /^INVENTORY_DIGEST=NOT_EMITTED missing=release_commit$/m, "[W5.2] readback: NOT_EMITTED missing=release_commit");
  assert.ok(!/^INVENTORY_DIGEST=sha256:/m.test(r.out) && !/^EFFECTIVE_VERSION_ID=[0-9a-f]{8}-/m.test(r.out), "[W5.2] nem D0 nem V0");
  assert.match(r.out, /^READBACK_RC=1$/m, "[W5.2] readback sai != 0");
  const okr = run(BASE(), fetchState);
  assert.match(okr.out, /^WORKER_STATE release_status=OK$/m, "[W5.3] sucesso também explícito");
  safe(r.out, "W5.3");
});

test("W6 histórico de versões: coleta só leitura, sanitizado, com a premissa do Sol", () => {
  const r = run(BASE(), 'zev_fetch_history "$OUT" "$OUT/../history.json" 50; echo "RC=$?"');
  assert.match(r.out, /^RC=0$/m, "[W6.1] coleta do histórico passa");
  assert.match(r.calls, /\/workers\/scripts\/zevanory\/versions\?page=1&per_page=50/, "[W6.1] lista paginada (50)");
  assert.ok(r.calls.includes(`/versions/${V0}`) && r.calls.includes(`/versions/${V1}`), "[W6.1] detalhe de cada versão");
  const h = JSON.parse(r.hist);
  assert.equal(h.schema, "zevanory-version-history/v1", "[W6.2] histórico gravado");
  assert.ok(!r.hist.includes(VALUE) && !r.hist.includes(TOKEN), "[W6.2] histórico sem valor e sem token");
  assert.match(r.out, /^SOL_PREMISE status=PROVEN secret_versions=1 proven=1 refuted=0 not_proven=0$/m, "[W6.3] resumo da premissa (etag igual e só segredos)");
  assert.match(r.out, /^HISTORY_COMPLETENESS versions_listed=2 details_fetched=2 details_failed=0 ids=- pages_exhausted=true$/m, "[W6.6] completude: listadas, detalhes, falhas e paginação");
  const part = BASE(); part.http.unshift([`/workers/scripts/zevanory/versions/${V1}`, { code: 500, body: { success: false, errors: [{ code: 10013, message: SHORT }] } }]);
  const p = run(part, 'zev_fetch_history "$OUT" "$OUT/../history.json" 50; echo "RC=$?"');
  assert.match(p.out, new RegExp(`^HISTORY_COMPLETENESS versions_listed=2 details_fetched=1 details_failed=1 ids=${V1} pages_exhausted=true$`, "m"), "[W6.7] detalhe que falhou é contado e identificado");
  assert.match(p.out, /premise=NOT_PROVEN why=previous_detail_failed/, "[W6.7] versão cuja anterior falhou: NOT_PROVEN");
  assert.match(p.out, /^SOL_PREMISE status=NOT_PROVEN /m, "[W6.7] veredito global nunca PROVEN com detalhe faltando");
  safe(p.out, "W6.7");
  const bad = BASE(); bad.http.unshift(["/workers/scripts/zevanory/versions?", { code: 403, body: { success: false, errors: [{ code: 9109, message: "Unauthorized to access requested resource" }] } }]);
  const b = run(bad, 'rc=0; zev_fetch_history "$OUT" "$OUT/../history.json" 50 || rc=$?; echo "RC=$rc"');
  assert.match(b.out, /^::error title=WORKER_STATE::versions_list failed \(http=403 curl_exit=0\)$/m, "[W6.4] falha do histórico nomeada");
  assert.match(b.out, /^RC=1$/m, "[W6.4] e propagada");
  safe(r.out + b.out, "W6.5");
});

test("W7 workflow do readback: coleta com saída capturada, histórico e artefato de evidência só com arquivos seguros", () => {
  const wf = readTextNormalized(join(ROOT, ".github", "workflows", "production-test-secret-readback.yml"));
  assert.match(wf, /zev_fetch_state "\$d" > "\$ev\/collect\.txt" 2>&1 \|\| rc=\$\?\n\s+cat "\$ev\/collect\.txt"/, "[W7.1] saída da coleta sempre impressa, inclusive na falha");
  assert.match(wf, /zev_fetch_history "\$d" "\$ev\/version-history\.json" 50/, "[W7.2] histórico das últimas 50 versões");
  const up = wf.slice(wf.indexOf("uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02"));
  assert.match(up, /name: zevanory-readback-evidence-\$\{\{ github\.run_id \}\}/, "[W7.3] artefato nomeado pelo run");
  assert.match(up, /\n\s+retention-days: 7\n/, "[W7.3] retenção de 7 dias");
  const listed = [...up.split("retention-days")[0].matchAll(/\$\{\{ runner\.temp \}\}\/zevanory-evidence\/([^\s]*)/g)].map((m) => m[1]);
  assert.deepEqual(listed.sort(), ["collect.txt", "history.txt", "readback.txt", "version-history.json"], "[W7.3] allowlist explícita de arquivos (nunca a pasta inteira)");
  assert.match(wf, /- name: Upload readback evidence[^\n]*\n\s+if: always\(\)/, "[W7.3] sobe mesmo quando a coleta falha");
  assert.match(wf, /CLOUDFLARE_TOKEN_SOURCE: \$\{\{ secrets\.CLOUDFLARE_PUBLIC_OWNER_API_TOKEN != '' && 'CLOUDFLARE_PUBLIC_OWNER_API_TOKEN' \|\|/, "[W7.4] origem do token pelo nome");
  const evWrites = [...wf.matchAll(/"\$ev\/([\w.-]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(evWrites)].sort(), ["collect.txt", "history.txt", "readback.txt", "version-history.json"], "[W7.5] só saídas seguras vão para a evidência (nunca settings/version crus)");
});

test("W8 o auditor recalcula D0 sem chave, a partir dos bytes exportados, com uma implementação independente (Python)", () => {
  requireTool("python3");
  const r = run(BASE(), `zev_fetch_state "$OUT" > /dev/null
node scripts/ci/production-secret-names.mjs readback --secrets "$OUT/secrets.json" --settings "$OUT/settings.json" --deployments "$OUT/deployments.json" --version-detail "$OUT/version.json" --release "$OUT/release.json" > "$OUT/rb.txt" || true
cat "$OUT/rb.txt"
PYTHONDONTWRITEBYTECODE=1 python3 -I -c '
import hashlib, json, sys
lines = open(sys.argv[1], encoding="utf-8").read().split("\\n")
doc = next(l for l in lines if l.startswith("INVENTORY_DOCUMENT="))[len("INVENTORY_DOCUMENT="):]
d0 = next(l for l in lines if l.startswith("INVENTORY_DIGEST="))[len("INVENTORY_DIGEST="):]
raw = "sha256:" + hashlib.sha256(doc.encode("utf-8")).hexdigest()
canon = json.dumps(json.loads(doc), sort_keys=True, separators=(",", ":"), ensure_ascii=False)
print("PY_RAW_MATCH=" + str(raw == d0).lower())
print("PY_CANON_MATCH=" + str(canon == doc).lower())
' "$OUT/rb.txt"`);
  assert.match(r.out, /^INVENTORY_DIGEST=sha256:[0-9a-f]{64}$/m, "[W8.1] o readback emitiu D0 (fontes completas)");
  assert.match(r.out, /^PY_RAW_MATCH=true$/m, "[W8.1] Python: SHA-256 dos bytes UTF-8 do documento = D0");
  assert.match(r.out, /^PY_CANON_MATCH=true$/m, "[W8.2] Python: json.dumps(sort_keys, separators=(',',':'), ensure_ascii=False) reproduz o documento byte a byte");
  safe(r.out, "W8.3");
});
