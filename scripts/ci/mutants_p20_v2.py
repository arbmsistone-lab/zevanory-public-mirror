#!/usr/bin/env python3
"""Mutantes do P20 v2 (docs/p20/particoes-v2.md): UM mutante por regra nova, cada um com o teste que tem de morrer
escrito ANTES de rodar. Cada mutante altera uma linha numa cópia da árvore em diretório temporário (o repositório nunca
é alterado) e roda só o teste esperado:
  - regras do Worker e do condutor: tests/p20-particoes-v2.test.mjs (node, sem rede, sem banco);
  - regras do arquivador e do restaurador: o método do teste oficial tests/test_p20_restauracao_integral.py (PostgreSQL
    descartável do job; sem PGHOST os mutantes Python ficam INCONCLUSIVE e o job falha).
Veredito: KILLED = o teste esperado reprovou (nome do teste no resultado); SURVIVED = passou; INCONCLUSIVE = âncora
ausente/duplicada, falha de outro teste ou tempo esgotado (repetido 1 vez). Exit 0 só com todos KILLED.
Uso: python3 scripts/ci/mutants_p20_v2.py [raiz-do-repo]
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.dont_write_bytecode = True
REPO = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parents[2])
COPY = ["worker", "scripts/ops", "scripts/p20", "tests", "db", "docs/p20", "data"]
NODE_T = "tests/p20-particoes-v2.test.mjs"
PY_T = "tests.test_p20_restauracao_integral.RestauracaoIntegral."
W, CR, DRV = "worker/data-backup.mjs", "worker/backup-crypto.mjs", "scripts/ops/data-backup.mjs"
A, RS = "scripts/ops/backup_preserve_archive.py", "scripts/ops/restore_new_database.py"

# (arquivo, trecho original, trecho mutado, ("node"|"py", teste que tem de reprovar))
M = {
    "V01 partes = ceil(E/31)": (W, "Math.ceil(eligibleCount / MAX_DRILL_TABLES)", "Math.ceil(eligibleCount / (MAX_DRILL_TABLES + 1))",
                                ("node", "garantia de distribuição")),
    "V02 credenciais numeradas junto com as elegíveis": (W, "const eligible = inv.filter((x) => !SENSITIVE.test(x.t)).map((x) => x.t);",
                                                         "const eligible = inv.map((x) => x.t);", ("node", "tabelas de credencial saem ANTES")),
    "V03 sem limite de capacidade": (W, "  if (parts > MAX_PARTS) return { ok: false, failures: [\"capacity_exceeded:\" + eligible.length], eligible: eligible.length };\n", "",
                                     ("node", "capacidade: 180")),
    "V04 parte aceita plan_id diferente": (W, "      if (pl.plan_id !== planId) { fail(\"inventory_changed\"); return reject(report); }\n", "",
                                           ("node", "parte com plan_id diferente")),
    "V05 parte fora do plano aceita": (W, "      if (!Number.isInteger(part) || part < 0 || part >= pl.plan.parts) { fail(\"part_out_of_range\"); return reject(report); }\n", "",
                                       ("node", "parte fora do intervalo")),
    "V06 tabela em duas partes aceita": (W, "    for (const t of names) { if (seen.has(t)) failures.push(\"table_in_two_parts:\" + t); seen.set(t, i); }",
                                         "    for (const t of names) { seen.set(t, i); }", ("node", "consolidação v2 reprova")),
    "V07 cobertura incompleta aceita": (W, "  if (missing.length) failures.push(\"coverage_incomplete:\" + missing.length);\n", "",
                                        ("node", "consolidação v2 reprova")),
    "V08 plano adulterado aceito": (W, "  if (expectedId !== planId) { failures.push(\"plan_auth_failed\"); return; }\n", "",
                                    ("node", "consolidação v2 reprova")),
    "V09 parte de outro plano aceita": (W, "if (r.contract !== CONTRACT_V2 || r.plan_id !== planId || r.part !== i)", "if (r.contract !== CONTRACT_V2 || r.part !== i)",
                                        ("node", "consolidação v2 reprova")),
    "V10 hash dos bundles fora do HMAC": (W, "\"parts\", \"parts_detail\", \"ok\"", "\"parts\", \"ok\"", ("node", "consolidação v2 íntegra")),
    "V11 HKDF com outro contexto": (CR, "export const REPORT_HKDF_INFO = \"zevanory-backup-report-v2\";", "export const REPORT_HKDF_INFO = \"zevanory-backup-report\";",
                                    ("py", "test_p2_94_tabelas_4_partes")),
    "V12 condutor aceita 7 partes": (DRV, "body.parts >= 1 && body.parts <= 6", "body.parts >= 1 && body.parts <= 7", ("node", "condutor: rota de plano")),
    "V13 linhas pela estatística, não pelo conteúdo": (W, "      if (v2) { try { const a = JSON.parse(json); rows = Array.isArray(a) ? a.length : -1; } catch { rows = -1; } if (rows < 0) fail(\"neon_copy_not_array:\" + t); }\n", "",
                                                      ("py", "test_n2_escrita_concorrente_conta_no_conteudo")),
    "V14 arquivador aceita parte ausente": (A, "        if with_bundle - set(keys):\n            fail(\"missing_part \" + \",\".join(str(p) for p in sorted(with_bundle - set(keys))))\n", "",
                                            ("py", "test_n3_parte_ausente")),
    "V15 arquivador aceita parte extra": (A, "        if set(keys) - with_bundle:\n            fail(\"extra_part \" + \",\".join(str(p) for p in sorted(set(keys) - with_bundle)))\n", "",
                                          ("py", "test_n4_parte_extra")),
    "V16 arquivador sem conferir o HMAC do relatório": (A, "    if not _h.compare_digest(hmac_hex(k, canonical(body)), str(auth.get(\"hmac\", \"\"))):\n        fail(\"report_hmac_invalid\")\n", "",
                                                        ("py", "test_n5_relatorio_com_hmac_adulterado")),
    "V17 arquivador sem conferir o hash do bundle": (A, "            if sha256_hex(raw[p]) != exp[p][\"sha256\"]:\n                fail(f\"part_hash_mismatch part={p}\")\n", "",
                                                     ("py", "test_n6_bundle_movido_de_parte")),
    "V18 restaurador sem a chave restaura mesmo assim": (RS, "    if bpa.content_state(info) == bpa.ST_ENC_OPAQUE:\n        fail(\"restore_requires_backup_key\")\n", "",
                                                        ("py", "test_n8_sem_chave_no_arquivamento_nao_autenticado_e_restauracao_recusada")),
    "V19 restaurador não decifra (defeito original)": (RS, "    tables, info, plain = bpa.describe_parts(raw, doc.get(\"day\"), ring)", "    tables, info, plain = bpa.describe_parts(raw, doc.get(\"day\"), {})",
                                                       ("py", "test_n10_legado_v1_cifrado_3_partes_restaura_com_decifragem")),
    "V20 FK quebrada vira erro genérico": (RS, "        if code == \"23503\" and table:\n            fail(f\"inconsistencia_entre_tabelas {table} sqlstate=23503\")\n", "",
                                           ("py", "test_n9_chave_estrangeira_quebrada_entre_partes")),
    "V21 legado declarado completo": (RS, "\"estado\": \"completo\" if meta[\"contract\"] == 2 and meta[\"auth_state\"] == bpa.AUTH_OK else meta[\"auth_state\"]",
                                      "\"estado\": \"completo\"", ("py", "test_n10_legado_v1_cifrado_3_partes_restaura_com_decifragem")),
    # Contra-auditoria GPT-6 17/11 (lacunas 1 e 2 do PR #1070 em bd16101e).
    "V22 parte rejeitada grava o relatório (sobrescreve o válido)": (W, "      if (pl.plan_id !== planId) { fail(\"inventory_changed\"); return reject(report); }\n",
                                                                     "      if (pl.plan_id !== planId) { fail(\"inventory_changed\"); return finishPart(kv, report, part); }\n",
                                                                     ("node", "parte com plan_id diferente")),
    "V23 consolidação aceita relatório de outra execução": (W, "    if (r.run_id !== runId) { failures.push(\"part_run_mismatch:\" + i); return; }\n", "",
                                                             ("node", "consolidação v2 reprova")),
    "V24 sem reconferir o plano depois da exportação": (W, "      if (!post.ok || post.plan_id !== planId) fail(\"inventory_changed_during_export\");\n", "",
                                                         ("py", "test_n12_tipo_de_coluna_muda_entre_validacao_e_exportacao")),
    "V25 sem conferir as colunas do conteúdo exportado": (W, "fail(\"export_columns_mismatch:\" + r.t); }", "}",
                                                          ("py", "test_n13_coluna_criada_e_desfeita_em_volta_da_exportacao")),
    # Contra-auditoria GPT-6 17/11, segunda rodada (PR #1070 em 54823ea6).
    "V26 parte grava em dia já concluído": (W, "  if (await dayClosed(env, day)) { fail(\"day_already_complete\"); return reject(report); }\n", "",
                                            ("py", "test_n15_dia_concluido_execucao_b_falha_sem_tocar_a")),
    "V27 consolidação grava em dia já concluído": (W, "  if (await dayClosed(env, day)) return { schema: \"zevanory-backup/v1\", day, parts, ok: false, rejected: true, failures: [\"day_already_complete\"] };\n", "",
                                                   ("node", "consolidação v2 íntegra")),
    "V28 tipos não conferidos na própria leitura": (W, "        if (seen !== canonical(pl.colsOf[r.t] || [])) fail(\"export_schema_mismatch:\" + r.t);\n", "",
                                                    ("py", "test_n14_tipo_muda_e_volta_em_volta_da_exportacao")),
    "V29 reaproveita conteúdo de outro esquema": (W, "      if (v2 && p.cols !== canonical(pl.colsOf[t] || [])) continue;\n", "",
                                                  ("py", "test_n16_reaproveitamento_exige_o_mesmo_esquema")),
}


def build(tmp, mutation):
    for rel in COPY:
        src = Path(REPO, *rel.split("/"))
        shutil.copytree(src, Path(tmp, *rel.split("/")), dirs_exist_ok=True, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "node_modules"))
    shutil.copyfile(Path(REPO, "package.json"), Path(tmp, "package.json")) if Path(REPO, "package.json").exists() else None
    rel, old, new = mutation
    f = Path(tmp, *rel.split("/"))
    text = f.read_text(encoding="utf-8")
    if text.count(old) != 1:
        return False
    f.write_text(text.replace(old, new, 1), encoding="utf-8")
    return True


def run(tmp, kind, test):
    env = {**os.environ, "NODE_NO_WARNINGS": "1", "NO_COLOR": "1", "PYTHONDONTWRITEBYTECODE": "1"}
    if kind == "node":
        cmd = ["node", "--test", "--test-reporter=tap", f"--test-name-pattern={re.escape(test)}", NODE_T]
    else:
        cmd = [sys.executable, "-E", "-m", "unittest", PY_T + test]
    try:
        r = subprocess.run(cmd, cwd=tmp, env=env, capture_output=True, text=True, timeout=1500)
    except subprocess.TimeoutExpired:
        return "INCONCLUSIVE", "timeout"
    out = r.stdout + r.stderr
    if kind == "node":
        failed = re.findall(r"^not ok \d+ - (.*)$", out, re.M)
        ran = re.search(r"^# tests (\d+)$", out, re.M)
        if not ran or ran.group(1) == "0":
            return "INCONCLUSIVE", "teste esperado não rodou"
        if r.returncode == 0:
            return "SURVIVED", "teste passou"
        return ("KILLED", failed[0]) if failed and all(test in f for f in failed) else ("INCONCLUSIVE", "falhou outro teste: " + "; ".join(failed)[:200])
    if re.search(r"^Ran 1 test", out, re.M) is None:
        return "INCONCLUSIVE", "teste esperado não rodou: " + out[-300:]
    if r.returncode == 0:
        return "SURVIVED", "teste passou"
    return ("KILLED", test) if re.search(r"^(FAIL|ERROR): " + re.escape(test), out, re.M) else ("INCONCLUSIVE", out[-300:])


def main():
    results = []
    for name, (rel, old, new, (kind, test)) in M.items():
        if kind == "py" and not os.environ.get("PGHOST"):
            results.append((name, "INCONCLUSIVE", "PGHOST ausente"))
            continue
        verdict = reason = None
        for _ in range(2):
            with tempfile.TemporaryDirectory(prefix="p20mut_") as tmp:
                if not build(tmp, (rel, old, new)):
                    verdict, reason = "INCONCLUSIVE", "âncora ausente ou duplicada"
                    break
                verdict, reason = run(tmp, kind, test)
            if verdict != "INCONCLUSIVE":
                break
        results.append((name, verdict, reason))
        print(f"MUTANT {name} {verdict} ({reason[:160]})", flush=True)
    k = sum(v == "KILLED" for _, v, _ in results)
    s = sum(v == "SURVIVED" for _, v, _ in results)
    i = sum(v == "INCONCLUSIVE" for _, v, _ in results)
    print(f"MUTANTS total={len(results)} killed={k} survived={s} inconclusive={i}")
    return 0 if k == len(results) else (1 if s else 3)


if __name__ == "__main__":
    sys.exit(main())
