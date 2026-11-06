#!/usr/bin/env python3
"""Proveniência do build (roteiro seção 7, "Amarração ao código publicado"). Sem rede, sem segredos.

mp_signature_region_sha256
  SHA-256 (hex) do texto UTF-8 da região de assinatura Mercado Pago definida em scripts/deploy/mp-signature-region.json:
  o arquivo-fonte tem CRLF trocado por LF; cada parte é a fatia [indexOf(início), indexOf(fim, início)); as partes são
  unidas por "\\n". É exatamente o código que tests/mercadopago-webhook-signature.test.mjs executa
  (tests/helpers/mp-signature-region.mjs implementa a mesma regra em JS; o teste S13 confere os dois lados).
  Fecha em falha (RegionError) se algum âncora de início faltar, aparecer mais de uma vez, estiver no offset 0, ou se
  o fim não vier depois do início.

bundle_sha256
  SHA-256 (hex) do ÚNICO módulo JavaScript (*.js / *.mjs) que `wrangler deploy --dry-run --outdir DIR` gera.
  O README.md (carimbo de data/hora) e o *.map (caminhos absolutos do diretório de trabalho) ficam de fora porque não
  são determinísticos e não são o código executado. Mais de um módulo, ou nenhum, fecha em falha (BundleError).

CLI
  build_provenance.py region [--file F | --git-ref SHA] [--expect HEX] [--expect-build-info PATH]
  build_provenance.py bundle DIR
  build_provenance.py identifiers --before F1 --after F2     (linhas com os identificadores livres da região inalteradas)
Saída: uma linha JSON. Código 0 = ok; 1 = divergência; 2 = entrada inválida (âncora, módulo, arquivo).
"""
from __future__ import annotations

import argparse
import collections
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

sys.dont_write_bytecode = True

HERE = Path(__file__).resolve().parent
SPEC_PATH = HERE / "mp-signature-region.json"
HEX64 = re.compile(r"^[0-9a-f]{64}$")


class RegionError(ValueError):
    """A região de assinatura não pode ser identificada sem ambiguidade."""


class BundleError(ValueError):
    """O diretório do dry-run não tem exatamente um módulo JavaScript."""


def load_spec(path=None):
    spec = json.loads(Path(path or SPEC_PATH).read_text(encoding="utf-8"))
    parts = spec.get("parts")
    if not isinstance(parts, list) or not parts or not all(
            isinstance(p, list) and len(p) == 2 and all(isinstance(x, str) and x for x in p) for p in parts):
        raise RegionError("REGION_SPEC_INVALID: parts")
    if not isinstance(spec.get("joiner"), str) or not isinstance(spec.get("source"), str):
        raise RegionError("REGION_SPEC_INVALID: joiner/source")
    return spec


def normalize_eol(text):
    return text.replace("\r\n", "\n")


def extract_region(src, spec=None):
    spec = spec or load_spec()
    src = normalize_eol(src)
    out = []
    for start, end in spec["parts"]:
        n = src.count(start)
        if n != 1:
            raise RegionError(f"REGION_ANCHOR_NOT_UNIQUE: {start!r} occurs {n} times")
        a = src.find(start)
        b = src.find(end, a)
        if not (a > 0 and b > a):
            raise RegionError(f"REGION_ANCHOR_NOT_FOUND: {start!r} .. {end!r}")
        out.append(src[a:b])
    return spec["joiner"].join(out)


def sha256_text(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def region_sha256_text(src, spec=None):
    return sha256_text(extract_region(src, spec))


def read_source(file=None, git_ref=None, repo=".", spec=None):
    spec = spec or load_spec()
    if git_ref:
        if not re.fullmatch(r"[0-9a-f]{40}", git_ref):
            raise RegionError("GIT_REF_MUST_BE_40_HEX")
        raw = subprocess.run(["git", "-C", str(repo), "show", f"{git_ref}:{spec['source']}"], check=True,
                             capture_output=True, stdin=subprocess.DEVNULL).stdout
    else:
        raw = Path(file or Path(repo, spec["source"])).read_bytes()
    return raw.decode("utf-8")


def region_sha256_file(file=None, git_ref=None, repo=".", spec=None):
    spec = spec or load_spec()
    return region_sha256_text(read_source(file, git_ref, repo, spec), spec)


def bundle_sha256(outdir):
    d = Path(outdir)
    if not d.is_dir():
        raise BundleError(f"BUNDLE_DIR_MISSING: {d}")
    modules = sorted(p for p in d.iterdir() if p.is_file() and p.suffix in (".js", ".mjs"))
    if len(modules) != 1:
        raise BundleError(f"BUNDLE_NOT_SINGLE_MODULE: {[p.name for p in modules]}")
    return hashlib.sha256(modules[0].read_bytes()).hexdigest(), modules[0].name


def identifier_lines(src, spec=None):
    """Para cada identificador livre da região: multiconjunto das linhas (LF) que o mencionam."""
    spec = spec or load_spec()
    lines = normalize_eol(src).split("\n")
    out = {}
    for ident in spec.get("free_identifiers") or []:
        rx = re.compile(r"(?<![\w$])" + re.escape(ident) + r"(?![\w$])")
        out[ident] = collections.Counter(ln for ln in lines if rx.search(ln))
    return out


def identifiers_changed(before, after, spec=None):
    """Identificadores livres cujas linhas foram acrescentadas/removidas/alteradas entre before e after."""
    a, b = identifier_lines(before, spec), identifier_lines(after, spec)
    return sorted(k for k in a if a[k] != b.get(k))


def _emit(obj, code):
    print(json.dumps(obj, ensure_ascii=False, sort_keys=True))
    return code


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("region")
    r.add_argument("--file")
    r.add_argument("--git-ref")
    r.add_argument("--repo", default=".")
    r.add_argument("--expect")
    r.add_argument("--expect-build-info")
    b = sub.add_parser("bundle")
    b.add_argument("dir")
    i = sub.add_parser("identifiers")
    i.add_argument("--before", required=True)
    i.add_argument("--after", required=True)
    a = ap.parse_args(argv)
    try:
        if a.cmd == "bundle":
            h, name = bundle_sha256(a.dir)
            return _emit({"bundle_sha256": h, "module": name}, 0)
        if a.cmd == "identifiers":
            changed = identifiers_changed(Path(a.before).read_text(encoding="utf-8"),
                                          Path(a.after).read_text(encoding="utf-8"))
            return _emit({"MP_SIGNATURE_FREE_IDENTIFIERS": "PASS" if not changed else "FAIL", "changed": changed},
                         1 if changed else 0)
        h = region_sha256_file(a.file, a.git_ref, a.repo)
        out, ok = {"mp_signature_region_sha256": h}, True
        if a.expect is not None:
            out["expected"] = a.expect
            ok = ok and a.expect == h
        if a.expect_build_info:
            rec = json.loads(Path(a.expect_build_info).read_text(encoding="utf-8")).get("mp_signature_region_sha256")
            out["build_info"] = rec
            ok = ok and isinstance(rec, str) and HEX64.match(rec) is not None and rec == h
        if a.expect is not None or a.expect_build_info:
            out["MP_SIGNATURE_REGION_MATCH"] = "PASS" if ok else "FAIL"
        return _emit(out, 0 if ok else 1)
    except (RegionError, BundleError, OSError, ValueError, subprocess.CalledProcessError) as e:
        return _emit({"error": f"{type(e).__name__}: {e}"[:300]}, 2)


if __name__ == "__main__":
    sys.exit(main())
