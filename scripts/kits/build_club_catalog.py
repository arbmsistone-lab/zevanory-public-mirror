#!/usr/bin/env python3
"""ZEVANORY | Modelo B (Sol ORDEM 313): catálogo de contingência dos 5 kits a partir dos SHA256SUMS do build.

Lê SOMENTE os arquivos SHA256SUMS de cada pasta dist/<slug>/ do pipeline de produtos (nomes e SHA-256; nenhum
arquivo pago é lido, copiado ou versionado) e grava a chave `catalogo_contingencia` de data/hotmart-kits.json.

Regra de liberação por arquivo (a mesma da área de membros):
  - dia1: planilhas (.xlsx), modelos editáveis (.docx) e textos (.txt: comandos, COMECE_AQUI, licenças das fontes,
          SHA256SUMS.txt);
  - dia8: PDFs (.pdf) e o pacote completo (.zip).
Qualquer outra extensão faz o script FALHAR (nenhum arquivo entra no catálogo sem regra explícita), exceto as
prévias .webp do site, que não são parte do produto e são ignoradas.

Uso: python3 -I scripts/kits/build_club_catalog.py --dist /caminho/zevanory-products-v1.2/dist [--check]
     --check: não grava; sai 1 se o catálogo do repositório divergir do gerado.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "hotmart-kits.json"
RULE = {".xlsx": "dia1", ".docx": "dia1", ".txt": "dia1", ".pdf": "dia8", ".zip": "dia8"}
CTYPE = {
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".txt": "text/plain; charset=utf-8",
    ".pdf": "application/pdf",
    ".zip": "application/zip",
}
IGNORED = {".webp"}
LINE = re.compile(r"^([0-9a-f]{64})  ([A-Za-z0-9._/&+ -]+)$")


def entries_for(dist: Path, slug: str, sku: str, version: str) -> list[dict]:
    sums = dist / slug / "SHA256SUMS"
    if not sums.is_file():
        raise SystemExit(f"{slug}: {sums} ausente")
    out = []
    for n, raw in enumerate(sums.read_text(encoding="utf-8").splitlines(), 1):
        if not raw.strip():
            continue
        m = LINE.match(raw)
        if not m:
            raise SystemExit(f"{sums}:{n}: linha fora do formato")
        sha, path = m.group(1), m.group(2)
        ext = Path(path).suffix.lower()
        if ext in IGNORED:
            continue
        if ext not in RULE:
            raise SystemExit(f"{sums}:{n}: extensão sem regra de liberação: {path}")
        fid = hashlib.sha256(f"{sku}:{path}".encode()).hexdigest()[:16]
        out.append({
            "id": fid,
            "arquivo": path.rsplit("/", 1)[-1],
            "caminho": path,
            "liberacao": RULE[ext],
            "content_type": CTYPE[ext],
            "sha256": sha.upper(),
            "kv_key": f"zevanory/club-b/v{version}/{sku}/{path}",
        })
    if not any(e["liberacao"] == "dia8" and e["caminho"].endswith(".zip") for e in out):
        raise SystemExit(f"{slug}: pacote completo (.zip) ausente do SHA256SUMS")
    if not any(e["liberacao"] == "dia1" for e in out):
        raise SystemExit(f"{slug}: nenhum arquivo do 1º dia")
    return sorted(out, key=lambda e: (e["liberacao"], e["caminho"]))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dist", required=True)
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    data = json.loads(DATA.read_text(encoding="utf-8"))
    dist = Path(a.dist)
    catalog = {}
    for kit in data["kits"]:
        catalog[kit["sku"]] = entries_for(dist, kit["slug"], kit["sku"], data["versao_catalogo"])
    if a.check:
        same = data.get("catalogo_contingencia") == catalog
        print("CLUB_CATALOG=" + ("MATCH" if same else "DIFF"))
        return 0 if same else 1
    data["catalogo_contingencia"] = catalog
    DATA.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print("CLUB_CATALOG=WRITTEN " + " ".join(f"{k}:{len(v)}" for k, v in catalog.items()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
