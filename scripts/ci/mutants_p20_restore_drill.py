#!/usr/bin/env python3
"""Mutantes causais do ensaio mensal P20 (scripts/p20/*) e da sua ligação ao registro B0 (scripts/b0/*), classificados
pelo classificador COMPARTILHADO scripts/ci/mutant_classifier.py (sem modificação).

Suíte (uma execução `node --test`, TAP): tests/p20-restore-drill.test.mjs (D1-D12), tests/p20-backup-encryption.test.mjs
(E1-E10, cifragem AES-256-GCM do backup no Worker e no ensaio), tests/p20-kv-copy-drill.test.mjs (K1-K8, cópia KV -> Neon
restaurada e conferida chave a chave) e tests/b0-baseline.test.mjs (B0 e P20 no registro). Sem rede, sem banco, sem segredos. Cada mutante altera UMA regra numa cópia mínima da árvore em
diretório temporário (o repositório nunca é alterado).
Expectativas (mutants_p20_restore_drill_allow.json, formato load_mutant_config): primary (1-3) com test_pattern E
assertion_pattern NÃO nulo (marcador [Dn.k]/[B0P20.k] da asserção que codifica a regra) e secondary com justification,
escritas por raciocínio sobre a mutação ANTES de rodá-la. Validação antes de qualquer mutante (exit 2): config inválida,
primary sem marcador, test_pattern que não casa com nenhum teste da baseline, mutante sem config ou config órfã.
INCONCLUSIVE repete 1 vez; persistindo, o job falha. Exit: 0 todos KILLED; 1 SURVIVED; 2 baseline/config; 3 INCONCLUSIVE.
Uso: python3 scripts/ci/mutants_p20_restore_drill.py [raiz-do-repo]
"""
import json, os, shutil, sys, tempfile

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import mutant_classifier as mc  # noqa: E402  (sem modificação)

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
REPO = Path(ARGS[0] if ARGS else Path(__file__).resolve().parents[2])
TESTS = ["tests/p20-restore-drill.test.mjs", "tests/p20-backup-encryption.test.mjs", "tests/p20-kv-copy-drill.test.mjs", "tests/b0-baseline.test.mjs", "tests/p20-diario-ensaio.test.mjs"]
COPY_DIRS = ["scripts/p20", "scripts/b0", "docs/p20", "docs/b0", "migrations/d1"]
# P20 diário D1: data-backup importa a reconciliação diária (PR 4) e o ensaio importa a cadeia e a derivação (PR 6).
COPY_FILES = TESTS + ["tests/helpers/text.mjs", "tests/helpers/p20-backup-fixture.mjs", "tests/helpers/d1-sqlite.mjs", "scripts/audit/workers-usage.mjs",
                      "worker/data-backup.mjs", "worker/backup-crypto.mjs", "worker/diario-p20.mjs", "worker/diario-sombra.mjs", "worker/diario-reconcilia.mjs",
                      ".github/workflows/p20-monthly-restore-drill.yml", ".github/workflows/b0-baseline-collector.yml",
                      ".github/workflows/p18-external-monitor.yml", ".github/workflows/b0-baseline-tests.yml", ".github/workflows/p18-monitor-watchdog.yml"]
TIMEOUT = 300
NODE = shutil.which("node") or "node"
L, D, P = "scripts/p20/restore-drill-lib.mjs", "scripts/p20/restore-drill.mjs", "scripts/p20/publish-drill.mjs"
B, C, W = "scripts/b0/b0-lib.mjs", "scripts/b0/b0-collector.mjs", ".github/workflows/p20-monthly-restore-drill.yml"
WC, WB, E = "worker/backup-crypto.mjs", "worker/data-backup.mjs", "scripts/p20/backup-envelope.mjs"
R = "scripts/p20/kv-memory-replay.mjs"  # reconstrução do KV em memória (não é escritor de KV)
DD, DR = "scripts/p20/restore-drill-diario.mjs", "scripts/p20/diario-d1-read.mjs"

M = {
    "M01 hash por tabela não conferido": (L, "      if (h !== m.sha) { fail(`hash_mismatch:${t}`); partOk = false; continue; }\n", ""),
    "M02 restaura cópia com falha de integridade": (D, "  if (assessment?.readable && assessment.failures.length === 0) {", "  if (assessment?.readable) {"),
    "M03 rótulo de produção sem leitura real": (L, "  if (mode === \"producao\" && sourceRead === true) return \"ENSAIO_EM_PRODUCAO\";", "  if (mode === \"producao\") return \"ENSAIO_EM_PRODUCAO\";"),
    "M04 alvo com host não local aceito": (L, "  if (!EPHEMERAL_HOSTS.includes(host)) throw new Error(\"TARGET_NOT_EPHEMERAL host\");\n", ""),
    "M05 DATABASE_URL no ambiente aceito": (L, "  for (const k of [\"DATABASE_URL\", \"RESTORE_TARGET_DATABASE_URL\",", "  for (const k of [\"RESTORE_TARGET_DATABASE_URL\","),
    "M06 leitor do KV grava (PUT)": (D, "    const r = await fetchImpl(url, { method: \"GET\",", "    const r = await fetchImpl(url, { method: \"PUT\","),
    "M07 leitor de produção lê fora do namespace do backup": (D, "  return async (key) => {\n    if (!BACKUP_KEY.test(key)) throw new Error(\"key_outside_backup_namespace\");\n    const url", "  return async (key) => {\n    const url"),
    "M08 RPO pela parte mais nova": (L, "  const oldest = Math.min(...partStartedAts.map((t) => Date.parse(t)));", "  const oldest = Math.max(...partStartedAts.map((t) => Date.parse(t)));"),
    "M09 tolerância de idade 72 h em vez de 26 h": (L, "export const MAX_AGE_H = 26;", "export const MAX_AGE_H = 72;"),
    "M10 RTO publicado com ensaio reprovado": (L, "    rto_seconds: verdict === \"APROVADO\" && isNum(rtoSeconds) ?", "    rto_seconds: verdict !== \"NOT_AVAILABLE\" && isNum(rtoSeconds) ?"),
    "M11 aprovado com falhas aceito na releitura": (L, "    if (r.failures.length || i.tables_hash_ok !== i.tables_checked", "    if (i.tables_hash_ok !== i.tables_checked"),
    "M12 rótulo ENSAIO_EM_PRODUCAO em modo sintético aceito": (L, "  if (r.label === \"ENSAIO_EM_PRODUCAO\" && r.mode !== \"producao\") throw new Error(\"label_mode_mismatch\");\n", ""),
    "M13 restauração parcial aprovada": (L, " || r.restore.tables !== i.tables_checked) throw new Error(\"approved_without_full_restore\");", ") throw new Error(\"approved_without_full_restore\");"),
    "M14 NOT_AVAILABLE com RPO aceito": (L, "    if (r.rpo_hours !== null || r.rto_seconds !== null || typeof r.reason !== \"string\")", "    if (typeof r.reason !== \"string\")"),
    "M15 publicação aceita registro de outro modo": (P, "  if (r.mode !== mode) return na(\"record_mode_mismatch\");\n", ""),
    "M16 relatório consolidado não ok ignorado": (L, "  if (R.ok !== true) fail(\"combined_report_not_ok\");\n", ""),
    "M17 parte de outro dia aceita": (L, "    if (P.day !== R.day) fail(`part_day_mismatch:${p}`);\n", ""),
    "M18 parte com falha aceita": (L, "    if (P.ok !== true || (Array.isArray(P.failures) && P.failures.length)) fail(`part_not_ok:${p}`);\n", ""),
    "M19 bundle ausente sem falha própria": (L, "    if (raw == null) { fail(`bundle_missing:${p}`); continue; }", "    if (raw == null) { continue; }"),
    "M20 resumo do manifesto não conferido": (L, " && manifestHash(shaOf).slice(0, 16) === P.neon.manifest;", ";"),
    "M21 tabela do manifesto ausente no bundle ignorada": (L, "    for (const t of mnames) if (!(t in bundle)) fail(`table_in_manifest_missing_from_bundle:${t}`);\n", ""),
    "M22 publicação do workflow sem Environment protegido": (W, "    environment: producao-critica  # aprovação do proprietário obrigatória; somente leitura (GET) no KV\n", ""),
    "M23 job de publicação com segredo": (W, "    env:\n      EVIDENCE_BRANCH: evidence/b0-baseline\n", "    env:\n      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}\n      EVIDENCE_BRANCH: evidence/b0-baseline\n"),
    "M24 B0 conta ensaio SINTETICA": (B, "  const r = win.find((x) => x.label === \"ENSAIO_EM_PRODUCAO\" && [\"APROVADO\", \"REPROVADO\"].includes(x.verdict));", "  const r = win.find((x) => [\"APROVADO\", \"REPROVADO\"].includes(x.verdict));"),
    "M25 B0 janela de 400 dias": (B, "export const P20_DRILL_WINDOW_DAYS = 31;", "export const P20_DRILL_WINDOW_DAYS = 400;"),
    "M26 B0 conta ensaio posterior ao dia": (B, " && Date.parse(r.finished_at) >= start && Date.parse(r.finished_at) <= end)", " && Date.parse(r.finished_at) >= start)"),
    "M27 B0 histórico P20 malformado tratado como vazio": (C, "    try { drills = readDrills(evidenceDir); } catch { drills = null; }", "    try { drills = readDrills(evidenceDir); } catch { drills = []; }"),
    "M28 B0 aprovado com restauração parcial aceito": (B, "    && (v.verdict === \"REPROVADO\" || (v.tables_hash_ok === v.tables_checked && v.tables_restored === v.tables_checked && isNum(v.rpo_hours) && isNum(v.rto_seconds)))", "    && (v.verdict === \"REPROVADO\" || (v.tables_hash_ok === v.tables_checked && isNum(v.rpo_hours) && isNum(v.rto_seconds)))"),
    "M29 B0 flag complete forjada aceita": (B, "    if (e.complete === true && !presentOk) throw new Error(\"complete_flag_mismatch \" + pid);", "    if (false) throw new Error(\"complete_flag_mismatch \" + pid);"),
    "M30 nonce fixo no Worker": (WC, "  const nonce = randomBytes(NONCE_BYTES);\n  if (!(nonce instanceof Uint8Array)", "  const nonce = new Uint8Array(NONCE_BYTES);\n  if (!(nonce instanceof Uint8Array)"),
    "M31 AAD omitida na cifragem do Worker": (WC, "iv: nonce, additionalData: te.encode(aadString(ctx)), tagLength: 128 }, k.key, te.encode(String(plaintext))", "iv: nonce, tagLength: 128 }, k.key, te.encode(String(plaintext))"),
    "M32 AAD esperada não conferida no ensaio": (E, "  if (o.aad.day !== ctx.day || o.aad.part !== ctx.part || o.aad.key !== ctx.bundleKey) throw err(\"aad_mismatch\");\n  const key = ring.get(o.kid);", "  const key = ring.get(o.kid);"),
    "M33 tag GCM não verificada no ensaio": (E, "    const pt = Buffer.concat([d.update(buf.subarray(0, buf.length - TAG_BYTES)), d.final()]);", "    const pt = d.update(buf.subarray(0, buf.length - TAG_BYTES));"),
    "M34 cifragem obrigatória sem chave cai para claro": (WB, "  if (bk.state === \"absent\" && encryptionRequired) { fail(\"backup_key_absent_encryption_required\"); return report; }\n", ""),
    "M35 chave inválida grava em claro": (WB, "  if (bk.state === \"invalid\") { fail(\"backup_key_invalid\"); return report; }\n", ""),
    "M36 ensaio aceita rebaixamento para claro": (L, "    if (isObj(P.encryption) && P.encryption.state === \"cifrado\" && !opened.encrypted) { fail(`bundle_encryption_downgrade:${p}`); continue; }\n", ""),
    "M37 lacuna copia_cifrada retirada com cópia parcial": (L, "a.parts.every((p) => p.copia_cifrada === true));", "a.parts.some((p) => p.copia_cifrada === true));"),
    "M38 releitura aceita lacuna retirada sem prova": (L, "  if (!ccPending && !(b.copia_cifrada === true && b.parts.every((p) => isObj(p) && p.copia_cifrada === true))) throw new Error(\"copia_cifrada_unproven\");\n", ""),
    "M39 kid declarado no conjunto não conferido": (E, "      if (kidOf(raw) !== kid) throw err(\"backup_keyring_kid_mismatch\");\n", ""),
    "M40 Worker relê cópia sem exigir o envelope": (WB, "        if (bk.state === \"present\" && !opened.encrypted) fail(\"neon_copy_not_encrypted\");\n        else storedBundle", "        storedBundle"),
    "M41 consolidado obrigatório aceita parte em claro": (WB, "  if (encryptionRequired && report.encryption.state !== \"cifrado\") failures.push(\"backup_nao_cifrado:\" + report.encryption.state);\n", ""),
    "M42 kid desconhecido decifrado com outra chave": (E, "  const key = ring.get(o.kid);", "  const key = ring.get(o.kid) || [...ring.values()][0];"),
    "M43 material de chave na mensagem de erro": (E, "  if (raw.length !== KEY_BYTES) throw err(\"backup_keyring_malformed\");", "  if (raw.length !== KEY_BYTES) throw err(\"backup_keyring_malformed:\" + t);"),
    # Cópia KV -> Neon (lacuna copia_kv_para_neon): só sai de not_covered com prova completa.
    "M44 lacuna copia_kv retirada com cópia só declarada": (L, "verdict === \"APROVADO\" && !!kvCopy && kvCopy.failures.length === 0 && kvProofComplete(kvCopy.proof, a.day),", "!!kvCopy,"),
    "M45 lacuna copia_kv retirada por valor não estritamente true": (L, "!(kvCopyProven === true && isCopiaKv(s))", "!(kvCopyProven && isCopiaKv(s))"),
    "M46 releitura aceita lacuna copia_kv retirada sem prova": (L, "  if (!kvPending && !(r.verdict === \"APROVADO\" && kvProofComplete(r.kv_copy, b.day) && (b.copia_cifrada !== true || r.kv_copy.copia_cifrada === true))) throw new Error(\"copia_kv_unproven\");\n", ""),
    "M47 NOT_AVAILABLE sem lacuna copia_kv aceito": (L, "  if (r.verdict === \"NOT_AVAILABLE\" && !kvPending) throw new Error(\"copia_kv_unproven\");\n", ""),
    "M48 prova do KV com chave a menos aceita": (L, "    && k.restored + k.expired_at_restore === k.keys && isInt(k.with_ttl)", "    && isInt(k.with_ttl)"),
    "M49 manifesto da fonte (valor+TTL+metadados) não conferido": (L, "  if (manifestHash(digests) !== entriesManifest) failures.push(`${prefix}_manifest_mismatch`);\n", ""),
    "M50 hash do valor por chave não conferido": (L, "  if (sha256(r.value) !== r.sha256) return \"value_hash_mismatch\";\n", ""),
    "M51 TTL não recriado na restauração do KV": (R, "    if (exp != null) opts.expiration = exp;\n", ""),
    "M52 metadados não recriados na restauração do KV": (R, "    if (r.metadata != null) opts.metadata = JSON.parse(r.metadata);\n", ""),
    "M53 chave fora dos prefixos críticos aceita": (L, " && KV_PREFIXES.some((p) => k.startsWith(p)) && !k.startsWith(\"zpc:restore-drill:\");", " && !k.startsWith(\"zpc:restore-drill:\");"),
    "M54 rebaixamento da cópia do KV para claro aceito": (L, "  if (isObj(p0.v.encryption) && p0.v.encryption.state === \"cifrado\" && !opened.encrypted) { fail(\"kv_copy_encryption_downgrade\"); return out; }\n", ""),
    "M55 SHA da cópia do KV não conferido": (L, "  if (sha256(opened.text) !== c.sha) { fail(\"kv_copy_hash_mismatch\"); return out; }\n", ""),
    "M56 Worker grava a cópia do KV a partir da fonte, não do Neon": (WB, "      const copyJson = JSON.stringify(backed);", "      const copyJson = JSON.stringify(present.map(([k, v]) => ({ snapshot_day: day, key: k, value: v, sha256: hashes[k], expiration: metaOf(k).expiration, metadata: metaOf(k).metadata })));"),
    "M57 Worker não copia o TTL para o Neon": (WB, "present.map(([k]) => metaOf(k).expiration), present.map(([k]) => metaOf(k).metadata)],", "present.map(() => null), present.map(([k]) => metaOf(k).metadata)],"),
    "M58 Worker não confere TTL e metadados relidos do Neon": (WB, " || entries[r.key] !== (await kvEntryDigest({ sha: r.sha256, expiration: r.expiration, metadata: r.metadata }))) mismatch++;", ") mismatch++;"),
    "M59 ensaio lê a cópia do KV fora do namespace do backup": (D, "  if (typeof kvKey === \"string\" && KV_COPY_KEY.test(kvKey)) kvCopy = await get(kvKey);", "  if (typeof kvKey === \"string\") kvCopy = await get(kvKey);"),
    "M60 chave expirada recriada na restauração": (R, "    if (exp != null && exp < nowSec + KV_MIN_TTL_S) { expired.push(r.key); continue; }\n", ""),
    "M61 restauração do KV não roda e a prova não é exigida": (D, "    if (!Array.isArray(restore.kv_rows)) kvCopy.failures.push(\"kv_restore_not_run\");\n    else kvCopy", "    if (Array.isArray(restore.kv_rows)) kvCopy"),
    # Diário D1 no ensaio mensal (scripts/p20/diario-d1-read.mjs, restore-drill-diario.mjs e a releitura do registro).
    "M62 releitura aceita diario_d1 retirado sem prova": (L, "  if (!ddPending && !(r.verdict === \"APROVADO\" && diarioProvado(r.diario) && r.rpo_critico_medido_s === r.diario.rpo_critico_medido_s)) throw new Error(\"diario_d1_unproven\");\n", ""),
    "M63 prova do diário aceita sobra": (L, " && d.faltando === 0 && d.sobrando === 0 &&", " && d.faltando === 0 &&"),
    "M64 cadeia do diário não verificada no ensaio": (DD, "  const cadeia = await verifyChain(rows, { head });", "  const cadeia = { ok: true };"),
    "M65 cadeia do diário sem a cabeça (fim cortado)": (DD, "  const cadeia = await verifyChain(rows, { head });", "  const cadeia = await verifyChain(rows, {});"),
    "M66 reaplicação não conferida": (DD, "  const reconstrucaoOk = Array.isArray(relidas) && relidas.length === cauda.length && cauda.every((r, i) => igual(r, relidas[i]));", "  const reconstrucaoOk = true;"),
    "M67 evento da cópia fora do diário ignorado": (DD, "  const conjuntoIgual = reconstrucaoOk && faltando.length === 0 && sobrando.length === 0", "  const conjuntoIgual = reconstrucaoOk && sobrando.length === 0"),
    "M68 leitor do D1 aceita SQL arbitrária": (DR, "    if (!SQL_PERMITIDAS.includes(sql)) throw new Error(\"d1_sql_nao_permitida\");\n", ""),
    "M69 leitor do D1 lê além da cabeça": (DR, "      const page = await q(SQL_PAGINA, [cursor, topo, pagina]);", "      const page = await q(SQL_PAGINA, [cursor, Number.MAX_SAFE_INTEGER, pagina]);"),
    "M70 leitor do D1 cai para o token compartilhado": (DR, "  const r = await lerDiario({ token: process.env.CF_TOKEN_D1_DIARIO_READ || \"\" });", "  const r = await lerDiario({ token: process.env.CF_TOKEN_D1_DIARIO_READ || process.env.CLOUDFLARE_API_TOKEN || \"\" });"),
    "M71 token do D1 no env do job": (W, "      PGPASSWORD: p20-drill-local-only\n    steps:\n", "      PGPASSWORD: p20-drill-local-only\n      CF_TOKEN_D1_DIARIO_READ: ${{ secrets.CF_TOKEN_D1_DIARIO_READ }}\n    steps:\n"),
    "M72 passo do ensaio recebe o token do D1": (W, "          P20_BACKUP_KEYS: ${{ secrets.P20_BACKUP_KEYS }}  # chave(s) de decifragem; ausente = bundles cifrados reprovam\n", "          P20_BACKUP_KEYS: ${{ secrets.P20_BACKUP_KEYS }}  # chave(s) de decifragem; ausente = bundles cifrados reprovam\n          CF_TOKEN_D1_DIARIO_READ: ${{ secrets.CF_TOKEN_D1_DIARIO_READ }}\n"),
    "M73 diário sem prova fora da sombra não reprova": (L, "  if (a.readable && isObj(diario) && diarioExigido(diario) && !diarioAprovado(diario)) failures.push(\"diario_sem_prova:\" + limpo(diario.estado) + (diario.motivo ? \":\" + limpo(diario.motivo) : \"\"));\n", ""),
    "M74 RPO crítico publicado sem prova": (DD, "  if (!conjuntoIgual) return { ...resumo, estado: \"nao_provado\",", "  if (!conjuntoIgual) return { ...resumo, rpo_critico_medido_s: rpo, estado: \"nao_provado\","),
    "M75 reconstrução sem a margem do corte": (DD, "  const cauda = rows.filter((r) => Number(r.ts_ms) > corte - MARGEM_MS);", "  const cauda = rows.filter((r) => Number(r.ts_ms) > corte);"),
    "M76 prova do diário sem restauração conferida": (DD, "  if (!restoreOk) return nao(\"restauracao_nao_aprovada\", { ...comum, cadeia_ok: true });\n", ""),
    "M77 lacuna do diário retirada em ensaio não aprovado": (L, "  if (!ddPending && !(r.verdict === \"APROVADO\" && diarioProvado(r.diario)", "  if (!ddPending && !(diarioProvado(r.diario)"),
    "M78 lacuna do diário retirada só pelo estado, sem a prova completa": (L, "    .filter((s) => !(provado && isDiarioD1(s)))", "    .filter((s) => !(isObj(diario) && diario.estado === \"provado\" && isDiarioD1(s)))"),
    # NC-PR6-01: fora da sombra, lista positiva (só "provado" com a prova completa passa).
    "M79 lista negativa: só nao_provado reprova": (L, "diarioExigido(diario) && !diarioAprovado(diario)) failures.push(", "diarioExigido(diario) && diario.estado === \"nao_provado\") failures.push("),
    "M80 fase desconhecida tratada como sombra": (L, "export const diarioExigido = (d) => !(isObj(d) && d.fase === \"sombra\");", "export const diarioExigido = (d) => isObj(d) && d.fase === \"ativo\";"),
    "M81 estado provado aceito sem a prova completa": (L, "export const diarioAprovado = (d) => isObj(d) && DIARIO_ESTADOS_APROVADOS.includes(d.estado) && diarioProvado(d);", "export const diarioAprovado = (d) => isObj(d) && DIARIO_ESTADOS_APROVADOS.includes(d.estado);"),
    "M82 releitura aceita aprovado em ativo sem prova": (L, "  if (r.verdict === \"APROVADO\" && isObj(r.diario) && diarioExigido(r.diario) && !diarioAprovado(r.diario)) throw new Error(\"diario_ativo_sem_prova\");\n", ""),
    "M83 implementação do diário escolhe a própria fase": (D, "    if (isObjDiario(diario)) diario = { ...diario, fase: diarioFase };\n", ""),
}

ALLOW_FILE = Path(os.environ.get("P20_MUTANTS_ALLOW_FILE") or Path(__file__).with_name("mutants_p20_restore_drill_allow.json"))


def load_config(path=None, titles=None, mutants=None):
    raw = json.loads(Path(path or ALLOW_FILE).read_text(encoding="utf-8"))
    specs = raw.get("mutants") if isinstance(raw, dict) else None
    if not isinstance(specs, dict):
        raise mc.ConfigError("config sem a seção 'mutants'")
    cfg = mc.load_mutant_config(specs)
    mutants = M if mutants is None else mutants
    missing, orphan = sorted(set(mutants) - set(cfg)), sorted(set(cfg) - set(mutants))
    if missing or orphan:
        raise mc.ConfigError(f"mutantes sem config {missing} / config órfã {orphan}")
    for mid, spec in cfg.items():
        for e in spec["primary"]:
            if not (isinstance(e.get("assertion_pattern"), str) and e["assertion_pattern"].strip()):
                raise mc.ConfigError(f"{mid}: primary sem assertion_pattern")
        if titles is not None:
            for e in spec["primary"] + spec["secondary"]:
                if not any(mc._test_matches(e["test_pattern"], t) for t in titles):
                    raise mc.ConfigError(f"{mid}: test_pattern não casa com nenhum teste: {e['test_pattern'][:60]}")
    return cfg


def build(tmp, mutation=None):
    for rel in COPY_DIRS:
        shutil.copytree(Path(REPO, *rel.split("/")), Path(tmp, *rel.split("/")), dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    for rel in COPY_FILES:
        dst = Path(tmp, *rel.split("/"))
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(Path(REPO, *rel.split("/")), dst)
    if mutation:
        rel, old, new = mutation
        f = Path(tmp, *rel.split("/"))
        text = f.read_bytes().decode("utf-8").replace("\r\n", "\n")
        if text.count(old) != 1:
            return False
        with open(f, "w", encoding="utf-8", newline="\n") as h:
            h.write(text.replace(old, new, 1))
    return True


def run_suite(root):
    env = {**os.environ, "NODE_NO_WARNINGS": "1", "NO_COLOR": "1", "FORCE_COLOR": "0", "NODE_OPTIONS": "", "PYTHONDONTWRITEBYTECODE": "1"}
    return mc.run_command([NODE, "--test", "--test-concurrency=1", "--test-reporter=tap", "--test-reporter-destination=stdout", *TESTS],
                          cwd=root, timeout=TIMEOUT, env=env)


def run_mutant(name, mutation, total, spec):
    with tempfile.TemporaryDirectory() as tmp:
        ok = build(tmp, mutation)
        run = run_suite(tmp) if ok else {"return_code": 1, "stdout": "", "stderr": "", "timed_out": False, "signal": None}
    return mc.classify_run(total, run, expected=spec, allowlist=spec.get("allowlist") or [], anchor_ok=ok, mutant_id=name)


def main():
    with tempfile.TemporaryDirectory() as tmp:
        build(tmp)
        base = run_suite(tmp)
    parsed = mc.parse_tap(base.get("stdout", ""), stderr=base.get("stderr", ""))
    total = parsed["summary"].get("tests")
    vb = mc.validate_baseline(total if isinstance(total, int) else -1, base.get("return_code"), parsed["summary"], parsed["failures"],
                              timed_out=base.get("timed_out", False), signal=base.get("signal"))
    if not vb["ok"]:
        print("BASELINE FAILED", vb["reason"])
        print(base.get("stdout", "")[-3000:])
        return mc.EXIT_BAD_BASELINE
    titles = [p.get("test_id") for p in parsed["summary"].get("points") or []]
    print(f"BASELINE PASS tests={total}")
    try:
        cfg = load_config(titles=titles)
    except mc.ConfigError as e:
        print("CONFIG_INVALID", e)
        return mc.EXIT_BAD_BASELINE

    def judge(item):
        name, mutation = item
        res = run_mutant(name, mutation, total, cfg[name])
        if res["verdict"] == mc.INCONCLUSIVE:
            first = res["reason"]
            res = run_mutant(name, mutation, total, cfg[name])
            if res["verdict"] == mc.INCONCLUSIVE:
                res["reason"] = f"{first} | repetição: {res['reason']}"
        return res

    with ThreadPoolExecutor(max_workers=min(4, os.cpu_count() or 2)) as ex:
        results = list(ex.map(judge, M.items()))
    for r in results:
        print(f"MUTANT {r['mutant_id']} {r['verdict']}" + ("" if r["verdict"] == mc.KILLED else f" ({r['reason'][:300]})"))
        print("RESULT " + json.dumps({k: r.get(k) for k in ("mutant_id", "verdict", "reason", "killing_tests", "assertion_ids", "secondary_tests", "unexpected_failures")}, ensure_ascii=False))
    code, summary = mc.aggregate(results, baseline_valid=True)
    print(f"MUTANTS total={len(results)} killed={summary['KILLED']} survived={summary['SURVIVED']} inconclusive={summary['INCONCLUSIVE']}")
    return code


if __name__ == "__main__":
    sys.exit(main())
