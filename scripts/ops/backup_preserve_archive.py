#!/usr/bin/env python3
"""ZEVANORY · Preservação do backup íntegro (ordem P0 de 15/10/2026).

Copia, para fora do provedor de origem, o backup Neon -> KV de um dia (padrão: 2026-10-14,
último íntegro antes do incidente Neon HTTP 402), CIFRADO, com manifesto de hashes e
restauração verificável. Nenhum dado é impresso em log (o repositório é público).

Modos:
  inspect  somente leitura: lista as chaves do dia e a expiração (sem ler valores).
  archive  lê os bundles, confere tabelas/linhas/SHA-256, cifra (AES-256-GCM, chave scrypt
           da senha do proprietário) e grava archive.enc + manifest.json (sem dados).
  verify   decifra, confere os hashes contra o manifesto e restaura cada tabela num
           Postgres efêmero (CI) como linhas jsonb, comparando contagens.
  kv-extend ESCRITA no KV de produção (exige autorização): grava cópias com retenção
           estendida em zpc:backup:v1:preserved:<dia>:part:<n>. Nunca altera a original.

Variáveis: CLOUDFLARE_API_TOKEN (leitura/escrita KV conforme o modo), BACKUP_ARCHIVE_PASSPHRASE
(>= 32 caracteres, criada e guardada SOMENTE pelo proprietário), PG* (modo verify).
"""
import argparse
import base64
import datetime as dt
import hashlib
import json
import os
import re
import secrets
import subprocess
import sys
import urllib.parse
import urllib.request

CF_ACCOUNT = "1b26415802588185a86c1d4d3ebf5bdb"
NAMESPACE = "728a45738e4047f29bcb89934fd533c1"  # ZEVANORY_PRIVATE_ARTIFACTS (produção)
PARTS = 3
MAGIC = b"ZVBK1"
KDF = {"name": "scrypt", "n": 2 ** 15, "r": 8, "p": 1, "len": 32}
TABLE_RE = re.compile(r"^[a-z_][a-z0-9_]{0,62}$")
DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def note(title, payload):
    """Anotação pública: só metadados (nomes de tabela, contagens, hashes)."""
    print(f"::notice title={title}::" + json.dumps(payload, ensure_ascii=True, separators=(",", ":"))[:3500], flush=True)


def fail(msg):
    print("::error title=BACKUP_PRESERVE::" + re.sub(r"[^A-Za-z0-9_.:,=/ -]", "", str(msg))[:300], flush=True)
    sys.exit(1)


def sha256_hex(b):
    return hashlib.sha256(b if isinstance(b, bytes) else str(b).encode("utf-8")).hexdigest()


def bundle_key(day, part):
    return f"zpc:backup:v1:neon:{day}:part:{part}"


def preserved_key(day, part):
    return f"zpc:backup:v1:preserved:{day}:part:{part}"


# ---------------- Cloudflare KV (API REST) ----------------
def _cf(path, token, method="GET", body=None, params=None):
    url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT}/storage/kv/namespaces/{NAMESPACE}{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, data=body, method=method, headers={"Authorization": "Bearer " + token, "User-Agent": "zevanory-backup-preserve/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read(30 * 1024 * 1024)


def kv_list(token, prefix):
    out = json.loads(_cf("/keys", token, params={"prefix": prefix, "limit": 1000}))
    if out.get("success") is not True:
        fail("kv_list_failed")
    return [{"name": k["name"], "expiration": k.get("expiration")} for k in out.get("result", [])]


def kv_get(token, key):
    return _cf("/values/" + urllib.parse.quote(key, safe=""), token)


def kv_put(token, key, value, ttl_seconds):
    out = json.loads(_cf("/values/" + urllib.parse.quote(key, safe=""), token, method="PUT", body=value, params={"expiration_ttl": int(ttl_seconds)}))
    if out.get("success") is not True:
        fail("kv_put_failed")


# ---------------- conteúdo e manifesto ----------------
def describe_bundles(raw_parts):
    """raw_parts: {part:int -> bytes}. Retorna tabelas com linhas e SHA-256 (igual ao do Worker:
    sha256 da string JSON de cada tabela)."""
    tables = {}
    for part, raw in sorted(raw_parts.items()):
        bundle = json.loads(raw)
        if not isinstance(bundle, dict):
            fail(f"bundle_not_object part={part}")
        for name, js in bundle.items():
            if not TABLE_RE.match(name) or not isinstance(js, str):
                fail(f"invalid_table_entry part={part}")
            rows = json.loads(js)
            if not isinstance(rows, list):
                fail(f"table_not_array part={part}")
            if name in tables:
                fail(f"duplicate_table {name}")
            tables[name] = {"part": part, "rows": len(rows), "sha256": sha256_hex(js)}
    return tables


def build_manifest(day, raw_parts, tables, ciphertext, plaintext, sources):
    return {
        "schema": "zevanory-backup-archive-manifest/v1",
        "day": day,
        "created_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "totals": {"parts": len(raw_parts), "tables": len(tables), "rows": sum(t["rows"] for t in tables.values())},
        "tables": dict(sorted(tables.items())),
        "parts_sha256": {str(p): sha256_hex(b) for p, b in sorted(raw_parts.items())},
        "plaintext_sha256": sha256_hex(plaintext),
        "ciphertext_sha256": sha256_hex(ciphertext),
        "cipher": "AES-256-GCM", "kdf": KDF, "format": "MAGIC|salt16|nonce12|ciphertext+tag",
        "sources": sources,
    }


# ---------------- cifra ----------------
def _key(passphrase, salt):
    from cryptography.hazmat.primitives.kdf.scrypt import Scrypt
    return Scrypt(salt=salt, length=KDF["len"], n=KDF["n"], r=KDF["r"], p=KDF["p"]).derive(passphrase.encode("utf-8"))


def encrypt(plaintext, passphrase):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    salt, nonce = secrets.token_bytes(16), secrets.token_bytes(12)
    return MAGIC + salt + nonce + AESGCM(_key(passphrase, salt)).encrypt(nonce, plaintext, MAGIC)


def decrypt(blob, passphrase):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    if not blob.startswith(MAGIC):
        fail("archive_magic_mismatch")
    salt, nonce, ct = blob[5:21], blob[21:33], blob[33:]
    return AESGCM(_key(passphrase, salt)).decrypt(nonce, ct, MAGIC)  # InvalidTag => adulterado ou senha errada


def passphrase_or_fail():
    p = os.environ.get("BACKUP_ARCHIVE_PASSPHRASE", "")
    if len(p) < 32:
        fail("passphrase_missing_or_short")
    return p


# ---------------- modos ----------------
def mode_inspect(args, token):
    keys = kv_list(token, f"zpc:backup:v1:neon:{args.day}:")
    note("BACKUP_PRESERVE_INSPECT", {"day": args.day, "keys": keys,
         "expected": [bundle_key(args.day, p) for p in range(PARTS)]})
    missing = sorted(set(bundle_key(args.day, p) for p in range(PARTS)) - {k["name"] for k in keys})
    if missing:
        fail("missing_parts " + ",".join(missing))


def check_expected(tables, args):
    tot_t, tot_r = len(tables), sum(t["rows"] for t in tables.values())
    if args.expected_tables and tot_t != args.expected_tables:
        fail(f"tables_mismatch got={tot_t} expected={args.expected_tables}")
    if args.expected_rows and tot_r != args.expected_rows:
        fail(f"rows_mismatch got={tot_r} expected={args.expected_rows}")


def mode_archive(args, token):
    passphrase = passphrase_or_fail()
    keys = {k["name"]: k.get("expiration") for k in kv_list(token, f"zpc:backup:v1:neon:{args.day}:")}
    raw = {}
    for p in range(PARTS):
        k = bundle_key(args.day, p)
        if k not in keys:
            fail("missing_part " + k)
        raw[p] = kv_get(token, k)
    tables = describe_bundles(raw)
    check_expected(tables, args)
    plaintext = json.dumps({"schema": "zevanory-backup-archive/v1", "day": args.day,
                            "parts": {str(p): b.decode("utf-8") for p, b in raw.items()}}, separators=(",", ":")).encode("utf-8")
    blob = encrypt(plaintext, passphrase)
    if decrypt(blob, passphrase) != plaintext:
        fail("roundtrip_failed")
    manifest = build_manifest(args.day, raw, tables, blob, plaintext,
                              {bundle_key(args.day, p): {"expiration": keys[bundle_key(args.day, p)]} for p in range(PARTS)})
    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, "archive.enc"), "wb") as f:
        f.write(blob)
    with open(os.path.join(args.out, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2, sort_keys=True)
    note("BACKUP_PRESERVE_ARCHIVE", {"day": args.day, "totals": manifest["totals"], "ciphertext_sha256": manifest["ciphertext_sha256"],
                                     "plaintext_sha256": manifest["plaintext_sha256"], "sources": manifest["sources"]})
    return manifest


def restore_into_postgres(tables_json):
    """tables_json: {name -> json string}. Restaura como <tabela>(doc jsonb) e devolve contagens."""
    counts = {}
    for name, js in sorted(tables_json.items()):
        tag = "zv" + secrets.token_hex(6)
        while f"${tag}$" in js:
            tag = "zv" + secrets.token_hex(6)
        sql = (f'drop table if exists restore_check."{name}"; create table restore_check."{name}"(doc jsonb not null); '
               f'insert into restore_check."{name}"(doc) select value from jsonb_array_elements(${tag}${js}${tag}$::jsonb); '
               f'select count(*) from restore_check."{name}";')
        # SQL via stdin: a single command-line argument is capped at 128 KiB on Linux (MAX_ARG_STRLEN),
        # and real tables are larger; stdin also keeps the data out of the process list.
        r = subprocess.run(["psql", "-v", "ON_ERROR_STOP=1", "-qtA", "-f", "-"], input="create schema if not exists restore_check;\n" + sql,
                           capture_output=True, text=True, timeout=300)
        if r.returncode != 0:
            fail(f"restore_failed {name}")
        counts[name] = int(r.stdout.strip().splitlines()[-1])
    return counts


def mode_verify(args, _token=None, restore=True):
    passphrase = passphrase_or_fail()
    with open(os.path.join(args.out, "manifest.json")) as f:
        manifest = json.load(f)
    with open(os.path.join(args.out, "archive.enc"), "rb") as f:
        blob = f.read()
    if sha256_hex(blob) != manifest["ciphertext_sha256"]:
        fail("ciphertext_hash_mismatch")
    plaintext = decrypt(blob, passphrase)
    if sha256_hex(plaintext) != manifest["plaintext_sha256"]:
        fail("plaintext_hash_mismatch")
    doc = json.loads(plaintext)
    raw = {int(p): v.encode("utf-8") for p, v in doc["parts"].items()}
    tables = describe_bundles(raw)
    if tables != manifest["tables"]:
        fail("table_manifest_mismatch")
    result = {"day": doc["day"], "tables": len(tables), "rows": sum(t["rows"] for t in tables.values()), "hashes": "ok"}
    if restore:
        tables_json = {}
        for b in raw.values():
            tables_json.update(json.loads(b))
        counts = restore_into_postgres(tables_json)
        bad = [n for n, c in counts.items() if c != tables[n]["rows"]]
        if bad:
            fail("restore_count_mismatch " + ",".join(bad[:10]))
        result["restore"] = {"tables": len(counts), "rows": sum(counts.values()), "ok": True}
    note("BACKUP_PRESERVE_VERIFY", result)
    return result


def mode_kv_extend(args, token):
    if args.confirm != f"PRESERVAR {args.day}":
        fail("confirmation_phrase_required")
    ttl = int(args.ttl_days) * 86400
    if not (30 * 86400 <= ttl <= 120 * 86400):
        fail("ttl_out_of_range")
    written = []
    for p in range(PARTS):
        v = kv_get(token, bundle_key(args.day, p))
        kv_put(token, preserved_key(args.day, p), v, ttl)
        if sha256_hex(kv_get(token, preserved_key(args.day, p))) != sha256_hex(v):
            fail("preserved_readback_mismatch")
        written.append({"key": preserved_key(args.day, p), "sha256": sha256_hex(v), "ttl_days": args.ttl_days})
    note("BACKUP_PRESERVE_KV_EXTEND", {"day": args.day, "written": written})


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["inspect", "archive", "verify", "kv-extend"])
    ap.add_argument("--day", default="2026-10-14")
    ap.add_argument("--expected-tables", type=int, default=51)
    ap.add_argument("--expected-rows", type=int, default=18142)
    ap.add_argument("--out", default="preserve-out")
    ap.add_argument("--ttl-days", default="75")
    ap.add_argument("--confirm", default="")
    args = ap.parse_args(argv)
    if not DAY_RE.match(args.day):
        fail("invalid_day")
    if args.mode == "verify":
        return mode_verify(args)
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "")
    if not token:
        fail("cloudflare_token_missing")
    return {"inspect": mode_inspect, "archive": mode_archive, "kv-extend": mode_kv_extend}[args.mode](args, token)


if __name__ == "__main__":
    main()
