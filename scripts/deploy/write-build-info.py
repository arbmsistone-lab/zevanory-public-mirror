#!/usr/bin/env python3
"""public/build-info.json do candidato central (servido em /build-info.json).

Sem argumentos (antes do prepare-central-candidate, como sempre): grava sha, source, repository (inalterados) e
mp_signature_region_sha256, o SHA-256 da região de assinatura Mercado Pago do Worker do checkout (o texto que
tests/mercadopago-webhook-signature.test.mjs executa; definição em scripts/deploy/build_provenance.py).
--bundle-dir DIR (depois do `wrangler deploy --dry-run --outdir DIR`): acrescenta bundle_sha256, o SHA-256 do único
módulo JavaScript do dry-run, preservando os demais campos. build-info.json é asset (não entra no bundle), então
acrescentá-lo depois do dry-run não altera o bundle medido.
"""
import json, os, sys
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_provenance as bp  # noqa: E402

OUT = Path("public/build-info.json")

if len(sys.argv) == 3 and sys.argv[1] == "--bundle-dir":
    info = json.loads(OUT.read_text(encoding="utf-8"))
    for key in ("sha", "source", "repository", "mp_signature_region_sha256"):
        if not info.get(key):
            sys.exit(f"BUILD_INFO_INCOMPLETE: {key}")
    info["bundle_sha256"], _module = bp.bundle_sha256(sys.argv[2])
elif len(sys.argv) == 1:
    info = {"sha": os.environ["TARGET_RUNTIME_SHA"], "source": "github-actions-cloudflare",
            "repository": os.environ["GITHUB_REPOSITORY"],
            "mp_signature_region_sha256": bp.region_sha256_file()}
else:
    sys.exit("usage: write-build-info.py [--bundle-dir DIR]")
with open(OUT, "w", encoding="utf-8") as f:
    json.dump(info, f, indent=2)
    f.write("\n")
