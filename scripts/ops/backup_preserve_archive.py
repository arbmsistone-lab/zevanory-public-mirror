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
(>= 32 caracteres, criada e guardada SOMENTE pelo proprietário), PG* (modo verify),
P20_BACKUP_KEYS (opcional; chave(s) do envelope do backup, docs/p20/cifragem-backup.md).

Bundles cifrados pelo Worker (envelope AES-256-GCM zevanory-backup-enc/v1) são ARQUIVADOS COMO ESTÃO: o archive.enc
guarda o envelope original (cifrado de novo pela senha); nenhum texto claro novo é gravado em disco.
  - com P20_BACKUP_KEYS: o envelope é decifrado SÓ em memória (AAD do dia/parte, tag GCM), as tabelas conferidas
    contra o manifesto e, no verify, restauradas no Postgres efêmero. Estado da parte: cifrado_verificado_conteudo.
  - sem a chave: validação estrutural do envelope (versão, alg, kid, nonce de 12 bytes, tag, AAD do dia/parte) e
    integridade pelo SHA-256 do envelope (parts_sha256). Estado: cifrado_nao_verificado_conteudo (o conteúdo, as
    contagens e a restauração dessa parte NÃO são provados; registrado no manifesto e no log).
Mesmo contrato e mesma derivação de kid de scripts/p20/backup-envelope.mjs (vetor fixo gerado pelo node no teste).
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
ENC_FORMAT, ENC_VERSION, ENC_ALG, ENC_MARK = "zevanory-backup-enc/v1", 1, "A256GCM", "$enc"
KID_PREFIX = b"zevanory-p20-backup-kid/v1|"
B64_RE = re.compile(r"^[A-Za-z0-9+/]*={0,2}$")
KID_RE = re.compile(r"^[0-9a-f]{16}$")
ST_PLAIN, ST_ENC_OK, ST_ENC_OPAQUE = "claro_verificado", "cifrado_verificado_conteudo", "cifrado_nao_verificado_conteudo"


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


# ---------------- envelope do backup (P20) ----------------
def _b64(s):
    if not isinstance(s, str) or len(s) % 4 or not B64_RE.match(s):
        raise ValueError
    return base64.b64decode(s, validate=True)


def kid_of(raw):
    return hashlib.sha256(KID_PREFIX + raw).hexdigest()[:16]


def parse_keyring(text):
    """Mesmo formato de scripts/p20/backup-envelope.mjs: base64, lista 'nova,antiga' ou JSON {kid: base64}.
    Erros só por código (a chave nunca entra na mensagem)."""
    ring = {}
    s = (text or "").strip()
    if not s:
        return ring

    def key(b):
        try:
            raw = _b64(str(b).strip())
        except ValueError:
            fail("backup_keyring_malformed")
        if len(raw) != 32:
            fail("backup_keyring_malformed")
        return raw
    if s.startswith("{"):
        try:
            o = json.loads(s)
        except ValueError:
            fail("backup_keyring_malformed")
        if not isinstance(o, dict) or not o or not all(isinstance(v, str) for v in o.values()):
            fail("backup_keyring_malformed")
        for kid, b in o.items():
            raw = key(b)
            if kid_of(raw) != kid:
                fail("backup_keyring_kid_mismatch")
            ring[kid] = raw
        return ring
    for b in re.split(r"[\s,]+", s):
        if b:
            raw = key(b)
            ring[kid_of(raw)] = raw
    return ring


def aad_bytes(day, part):
    return f"zevanory-backup-enc|v={ENC_VERSION}|alg={ENC_ALG}|day={day}|part={part}|key={bundle_key(day, part)}".encode("utf-8")


def check_envelope(o, day, part):
    """Validação estrutural (sem chave). Devolve (kid, nonce, ct)."""
    if o.get(ENC_MARK) != ENC_FORMAT or o.get("v") != ENC_VERSION:
        fail(f"envelope_version_unsupported part={part}")
    if o.get("alg") != ENC_ALG or not isinstance(o.get("kid"), str) or not KID_RE.match(o["kid"]) or not isinstance(o.get("aad"), dict):
        fail(f"envelope_malformed part={part}")
    try:
        nonce, ct = _b64(o.get("nonce")), _b64(o.get("ct"))
    except ValueError:
        fail(f"envelope_malformed part={part}")
    if len(nonce) != 12 or len(ct) < 16:
        fail(f"envelope_malformed part={part}")
    a = o["aad"]
    if day is None or a.get("day") != day or a.get("part") != part or a.get("key") != bundle_key(day, part):
        fail(f"envelope_aad_mismatch part={part}")
    return o["kid"], nonce, ct


def open_envelope(o, day, part, ring):
    """Decifra só em memória. Kid fora do conjunto, tag ou AAD inválidas: falha fechada."""
    from cryptography.exceptions import InvalidTag
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    kid, nonce, ct = check_envelope(o, day, part)
    if kid not in ring:
        fail(f"envelope_kid_unknown part={part}")
    try:
        return AESGCM(ring[kid]).decrypt(nonce, ct, aad_bytes(day, part)).decode("utf-8")
    except (InvalidTag, UnicodeDecodeError):
        fail(f"envelope_decrypt_failed part={part}")


# ---------------- conteúdo e manifesto ----------------
def describe_parts(raw_parts, day=None, ring=None):
    """raw_parts: {part:int -> bytes} (valor original do KV, legado ou envelope). Retorna (tables, parts_info, plain)
    com as tabelas cujo conteúdo foi lido (linhas e SHA-256 igual ao do Worker), o estado de cada parte e o texto claro
    das partes lidas (SÓ em memória; nunca gravado)."""
    tables, info, plain = {}, {}, {}
    for part, raw in sorted(raw_parts.items()):
        bundle = json.loads(raw)
        if not isinstance(bundle, dict):
            fail(f"bundle_not_object part={part}")
        i = {"format": "legado_claro", "state": ST_PLAIN, "kid": None, "sha256": sha256_hex(raw)}
        if ENC_MARK in bundle:
            i["format"] = "cifrado"
            if ring:
                bundle = json.loads(open_envelope(bundle, day, part, ring))
                if not isinstance(bundle, dict) or ENC_MARK in bundle:
                    fail(f"bundle_not_object part={part}")
                i.update(state=ST_ENC_OK, kid=check_envelope(json.loads(raw), day, part)[0])
            else:
                i.update(state=ST_ENC_OPAQUE, kid=check_envelope(bundle, day, part)[0])
                info[part] = i
                continue
        info[part] = i
        plain[part] = bundle
        for name, js in bundle.items():
            if not TABLE_RE.match(name) or not isinstance(js, str):
                fail(f"invalid_table_entry part={part}")
            rows = json.loads(js)
            if not isinstance(rows, list):
                fail(f"table_not_array part={part}")
            if name in tables:
                fail(f"duplicate_table {name}")
            tables[name] = {"part": part, "rows": len(rows), "sha256": sha256_hex(js)}
    return tables, info, plain


def describe_bundles(raw_parts, day=None, ring=None):
    return describe_parts(raw_parts, day, ring)[0]


def content_state(info):
    st = {i["state"] for i in info.values()}
    return ST_ENC_OPAQUE if ST_ENC_OPAQUE in st else (ST_ENC_OK if ST_ENC_OK in st else ST_PLAIN)


def build_manifest(day, raw_parts, tables, ciphertext, plaintext, sources, info=None):
    info = info or {}
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
        # P20: estado de cada parte (legado_claro | envelope cifrado, conteúdo verificado ou não). Só metadados.
        "parts": {str(p): {k: v for k, v in i.items() if k != "sha256"} for p, i in sorted(info.items())},
        "content_state": content_state(info) if info else ST_PLAIN,
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


def check_expected(tables, args, info=None):
    if info and content_state(info) == ST_ENC_OPAQUE:
        # Sem a chave as contagens das partes cifradas não são lidas: registrado como não verificado, nunca "ok".
        note("BACKUP_PRESERVE_NAO_VERIFICADO", {"content_state": ST_ENC_OPAQUE, "expected_counts": "nao_verificado",
             "parts": {str(p): i["state"] for p, i in sorted(info.items())}})
        return
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
    ring = parse_keyring(os.environ.get("P20_BACKUP_KEYS"))
    tables, info, _plain = describe_parts(raw, args.day, ring)
    check_expected(tables, args, info)
    # Arquiva o VALOR ORIGINAL de cada parte (envelope cifrado fica cifrado): nenhum texto claro novo.
    plaintext = json.dumps({"schema": "zevanory-backup-archive/v1", "day": args.day,
                            "parts": {str(p): b.decode("utf-8") for p, b in raw.items()}}, separators=(",", ":")).encode("utf-8")
    blob = encrypt(plaintext, passphrase)
    if decrypt(blob, passphrase) != plaintext:
        fail("roundtrip_failed")
    manifest = build_manifest(args.day, raw, tables, blob, plaintext,
                              {bundle_key(args.day, p): {"expiration": keys[bundle_key(args.day, p)]} for p in range(PARTS)}, info)
    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, "archive.enc"), "wb") as f:
        f.write(blob)
    with open(os.path.join(args.out, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2, sort_keys=True)
    note("BACKUP_PRESERVE_ARCHIVE", {"day": args.day, "totals": manifest["totals"], "ciphertext_sha256": manifest["ciphertext_sha256"],
                                     "plaintext_sha256": manifest["plaintext_sha256"], "sources": manifest["sources"],
                                     "content_state": manifest["content_state"], "parts": manifest["parts"]})
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
    # Integridade de cada parte pelo SHA-256 do valor original (envelope ou legado), com ou sem chave.
    for p, b in raw.items():
        if sha256_hex(b) != (manifest.get("parts_sha256") or {}).get(str(p)):
            fail(f"part_hash_mismatch part={p}")
    ring = parse_keyring(os.environ.get("P20_BACKUP_KEYS"))
    tables, info, plain = describe_parts(raw, doc.get("day"), ring)
    # Partes cujo conteúdo o manifesto registrou (manifesto antigo, sem "parts": todas). Uma parte arquivada opaca e
    # decifrada agora é provada pela tag GCM e pela AAD; as demais precisam bater tabela a tabela com o manifesto.
    mparts = manifest.get("parts")
    # Parte sem chave agora fica opaca (provada só por SHA-256 + estrutura) e sai da comparação.
    known = {p for p in plain if mparts is None or (mparts.get(str(p)) or {}).get("state") != ST_ENC_OPAQUE}
    for p, i in info.items():  # rebaixamento: parte arquivada como envelope e agora em claro (valor trocado)
        if (mparts or {}).get(str(p), {}).get("format") == "cifrado" and i["format"] != "cifrado":
            fail(f"part_encryption_downgrade part={p}")
    got = {t: v for t, v in tables.items() if v["part"] in known}
    expected = {t: v for t, v in manifest["tables"].items() if v["part"] in known}
    if got != expected:
        fail("table_manifest_mismatch")
    state = content_state(info)
    result = {"day": doc["day"], "tables": len(tables), "rows": sum(t["rows"] for t in tables.values()), "hashes": "ok",
              "content_state": state, "parts": {str(p): i["state"] for p, i in sorted(info.items())}}
    if state == ST_ENC_OPAQUE:
        print("::warning title=BACKUP_PRESERVE_NAO_VERIFICADO::" + json.dumps(result["parts"], separators=(",", ":")), flush=True)
    if restore:
        tables_json = {}
        for b in plain.values():
            tables_json.update(b)
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
    # .strip(): segredo salvo com quebra de linha quebrava o cabeçalho HTTP no urllib (issue #849).
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
    if not token:
        fail("cloudflare_token_missing")
    return {"inspect": mode_inspect, "archive": mode_archive, "kv-extend": mode_kv_extend}[args.mode](args, token)


if __name__ == "__main__":
    main()
