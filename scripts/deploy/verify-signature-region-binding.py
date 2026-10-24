#!/usr/bin/env python3
"""Guarda (roteiro seção 7): os patches de deploy não tocam a região de assinatura Mercado Pago. Fecha em falha.

Reconstrói, num diretório temporário, a mesma sequência do publicador central (central-production-deploy.yml):
base estática pinada (public/ e wrangler.jsonc de BASE) + worker/ e scripts/deploy/ do checkout, depois
`write-build-info.py` e `prepare-central-candidate.py` — que reescreve worker/cloudflare-worker.recovered.mjs. Roda nos
dois modos de configuração do prepare (vendas fechadas e lançamento autorizado com valores sintéticos) e exige, em cada um:
  1. o prepare de fato alterou o Worker (senão a comparação seria vazia);
  2. região testada (checkout, antes do patch) == região do Worker DEPOIS do patch == mp_signature_region_sha256 do
     build-info gravado antes do patch (o que o deploy publica);
  3. nenhuma linha que menciona um identificador livre da região (verifyMercadoPagoSignature,
     normalizeMercadoPagoWebhook, safeText2, crypto5, Buffer) foi acrescentada, removida ou alterada pelo patch
     (pega um patch que troque o import de crypto5 sem tocar o texto da região).
Uso: verify-signature-region-binding.py [--repo .] (--base SHA | --base-dir DIR) [--prepare PATH]
  --base SHA      lê public/ e wrangler.jsonc do commit SHA (git archive / git show), como o publicador
  --base-dir DIR  base já extraída (DIR/public, DIR/wrangler.jsonc) — usada pelos testes offline
  --prepare PATH  outro prepare-central-candidate.py (só testes negativos)
Saída: uma linha JSON MP_SIGNATURE_REGION_BINDING=PASS|FAIL; código 0 só com PASS. Sem rede, sem segredos.
"""
import argparse, io, json, os, shutil, subprocess, sys, tarfile, tempfile
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_provenance as bp  # noqa: E402

WORKER = Path("worker", "cloudflare-worker.recovered.mjs")
MODES = {
    "sales_closed": {"ZEVANORY_LAUNCH_AUTHORIZATION": "", "MERCADOPAGO_PRODUCTION_ACCOUNT_HASH16": "",
                     "MERCADOPAGO_PRODUCTION_WEBHOOK_VERIFIED": ""},
    "launch_authorized_synthetic": {"ZEVANORY_LAUNCH_AUTHORIZATION": "AUTORIZO COMPRA REAL",
                                    "MERCADOPAGO_PRODUCTION_ACCOUNT_HASH16": "0123456789abcdef",
                                    "MERCADOPAGO_PRODUCTION_WEBHOOK_VERIFIED": "true"},
}


def git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True,
                          stdin=subprocess.DEVNULL).stdout


def stage_base(repo, base, base_dir, dst):
    if base_dir:
        shutil.copytree(Path(base_dir, "public"), dst / "public")
        shutil.copyfile(Path(base_dir, "wrangler.jsonc"), dst / "wrangler.central-fix.jsonc")
        return
    with tarfile.open(fileobj=io.BytesIO(git(repo, "archive", base, "public")), mode="r:") as t:
        t.extractall(dst, filter="data")
    (dst / "wrangler.central-fix.jsonc").write_bytes(git(repo, "show", f"{base}:wrangler.jsonc"))


def run_mode(repo, base, base_dir, prepare, mode, env_mode, tested):
    with tempfile.TemporaryDirectory(prefix="zev-sigbind-") as tmp:
        d = Path(tmp)
        shutil.copytree(repo / "worker", d / "worker", ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        shutil.copytree(repo / "scripts" / "deploy", d / "scripts" / "deploy",
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        if prepare:
            shutil.copyfile(prepare, d / "scripts" / "deploy" / "prepare-central-candidate.py")
        stage_base(repo, base, base_dir, d)
        before = (d / WORKER).read_bytes()
        env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "PUBLIC_OWNER_ACCOUNT_ID": "0" * 32,
               "TARGET_RUNTIME_SHA": "0" * 40, "GITHUB_REPOSITORY": os.environ.get("GITHUB_REPOSITORY") or "local/check",
               **env_mode}
        res = {"mode": mode}
        for step in ("write-build-info.py", "prepare-central-candidate.py"):
            p = subprocess.run([sys.executable, str(Path("scripts", "deploy", step))], cwd=d, env=env,
                               capture_output=True, stdin=subprocess.DEVNULL, timeout=300)
            if p.returncode != 0:
                res["error"] = f"{step} rc={p.returncode}: " + p.stderr.decode("utf-8", "replace")[-300:]
                return res
        after = (d / WORKER).read_bytes()
        recorded = json.loads((d / "public" / "build-info.json").read_text(encoding="utf-8")).get(
            "mp_signature_region_sha256")
        res.update({"worker_patched": before != after,
                    "worker_sha256_before": bp.hashlib.sha256(before).hexdigest(),
                    "worker_sha256_after": bp.hashlib.sha256(after).hexdigest(),
                    "region_after_patch": bp.region_sha256_text(after.decode("utf-8")),
                    "build_info": recorded,
                    "free_identifiers_changed": bp.identifiers_changed(before.decode("utf-8"), after.decode("utf-8"))})
        problems = []
        if not res["worker_patched"]:
            problems.append("PREPARE_DID_NOT_PATCH_WORKER")
        if res["region_after_patch"] != tested:
            problems.append("REGION_CHANGED_BY_DEPLOY_PATCH")
        if recorded != tested:
            problems.append("BUILD_INFO_REGION_DIFFERS_FROM_TESTED")
        if res["free_identifiers_changed"]:
            problems.append("FREE_IDENTIFIER_LINES_CHANGED_BY_DEPLOY_PATCH")
        res["problems"] = problems
        return res


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=".")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--base")
    g.add_argument("--base-dir")
    ap.add_argument("--prepare")
    a = ap.parse_args(argv)
    repo = Path(a.repo).resolve()
    out = {"MP_SIGNATURE_REGION_BINDING": "FAIL"}
    try:
        tested = bp.region_sha256_file(repo / WORKER)
        out["tested_region"] = tested
        out["modes"] = [run_mode(repo, a.base, a.base_dir, a.prepare, m, e, tested) for m, e in MODES.items()]
    except (bp.RegionError, OSError, ValueError, subprocess.SubprocessError, tarfile.TarError) as e:
        out["error"] = f"{type(e).__name__}: {e}"[:300]
        print(json.dumps(out, ensure_ascii=False, sort_keys=True))
        return 1
    ok = all("error" not in m and not m["problems"] for m in out["modes"])
    out["MP_SIGNATURE_REGION_BINDING"] = "PASS" if ok else "FAIL"
    print(json.dumps(out, ensure_ascii=False, sort_keys=True))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
