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


# CI (P20 v2): o arquivamento real pode ler um KV em arquivo (saída do Worker real em tests/helpers), nunca a produção.
KV_FIXTURE = None


def kv_list(token, prefix):
    if KV_FIXTURE is not None:
        return [{"name": k, "expiration": None} for k in sorted(KV_FIXTURE) if k.startswith(prefix)]
    out = json.loads(_cf("/keys", token, params={"prefix": prefix, "limit": 1000}))
    if out.get("success") is not True:
        fail("kv_list_failed")
    return [{"name": k["name"], "expiration": k.get("expiration")} for k in out.get("result", [])]


def kv_get(token, key):
    if KV_FIXTURE is not None:
        if key not in KV_FIXTURE:
            fail("kv_fixture_key_missing")
        return KV_FIXTURE[key].encode("utf-8")
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


# ---------------- relatório v2 autenticado (P20 v2, docs/p20/particoes-v2.md) ----------------
REPORT_KEY = "zpc:backup:v1:report"
REPORT_HKDF_INFO = b"zevanory-backup-report-v2"
AUTH_FIELDS = ["contract", "day", "plan_id", "plan", "parts", "parts_detail", "ok", "failures", "encryption"]
AUTH_OK, AUTH_NONE, AUTH_LEGACY = "autenticado", "nao_autenticado", "legado_nao_autenticado"


def canonical(v):
    """Mesmo JSON canônico de worker/backup-crypto.mjs (chaves ordenadas, sem espaços, sem float)."""
    if isinstance(v, float):
        fail("canonical_float")
    return json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def report_key_of(raw):
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=REPORT_HKDF_INFO).derive(raw)


def hmac_hex(k, text):
    import hmac as _h
    return _h.new(k, text.encode("utf-8"), hashlib.sha256).hexdigest()


def verify_report_v2(report_text, day, ring):
    """Confere o relatório consolidado v2. Devolve (relatório, estado). Com o conjunto de chaves: kid conhecido, HMAC
    do relatório INTEIRO e HMAC do plano (= plan_id), ou falha fechada. Sem chave: estado nao_autenticado (nunca completo)."""
    import hmac as _h
    try:
        r = json.loads(report_text)
    except ValueError:
        fail("report_malformed")
    if not isinstance(r, dict) or r.get("contract") != 2 or r.get("day") != day:
        fail("report_not_v2_for_day")
    plan, details = r.get("plan"), r.get("parts_detail")
    if not isinstance(plan, dict) or not isinstance(details, list) or not isinstance(plan.get("eligible"), list) or plan.get("parts") != r.get("parts") or len(details) != r.get("parts"):
        fail("report_v2_malformed")
    if r.get("ok") is not True or r.get("failures"):
        fail("report_not_ok")
    auth = r.get("auth") if isinstance(r.get("auth"), dict) else {}
    if not ring or auth.get("state") != AUTH_OK:
        return r, AUTH_NONE
    kid = auth.get("kid")
    if kid not in ring or auth.get("fields") != AUTH_FIELDS:
        fail("report_kid_unknown_or_fields")
    k = report_key_of(ring[kid])
    body = {f: r.get(f) for f in AUTH_FIELDS}
    if not _h.compare_digest(hmac_hex(k, canonical(body)), str(auth.get("hmac", ""))):
        fail("report_hmac_invalid")
    if not _h.compare_digest(hmac_hex(k, canonical(plan)), str(r.get("plan_id", ""))):
        fail("plan_hmac_invalid")
    return r, AUTH_OK


def expected_parts_v2(r):
    """{parte: {"sha256", "tables": {t: {rows, sha}}}} declarado pelo relatório; tabela em duas partes ou fora do plano reprova."""
    out, seen = {}, set()
    eligible = set(r["plan"]["eligible"])
    for d in r["parts_detail"]:
        p, tabs = d.get("part"), d.get("tables") or {}
        if not isinstance(p, int) or p in out or not isinstance(tabs, dict):
            fail("report_part_malformed")
        for t in tabs:
            if t in seen or t not in eligible:
                fail(f"report_table_assignment_invalid {t}")
            seen.add(t)
        out[p] = {"sha256": d.get("bundle_sha256"), "key": d.get("bundle_key"), "tables": tabs}
    if seen != eligible:
        fail("report_coverage_incomplete")
    return out


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
    keys = neon_part_keys(token, args.day)
    report_text = read_report(token, args.day)
    if report_text is not None:
        rep = json.loads(report_text)
        expected = sorted(d.get("part") for d in rep.get("parts_detail") or [] if (d.get("tables") or {}))
        contract = 2
    else:
        expected, contract = list(range(PARTS)), 1
    note("BACKUP_PRESERVE_INSPECT", {"day": args.day, "contract": contract, "keys": sorted(keys),
         "expected": [bundle_key(args.day, p) for p in expected]})
    if set(expected) - set(keys):
        fail("missing_parts " + ",".join(bundle_key(args.day, p) for p in sorted(set(expected) - set(keys))))
    if set(keys) - set(expected):
        fail("extra_parts " + ",".join(bundle_key(args.day, p) for p in sorted(set(keys) - set(expected))))


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


def neon_part_keys(token, day):
    """Chaves de bundle do dia: {parte: expiração}. Qualquer chave fora do padrão exato do dia reprova."""
    prefix = f"zpc:backup:v1:neon:{day}:"
    out = {}
    for k in kv_list(token, prefix):
        m = re.match(r"^zpc:backup:v1:neon:" + re.escape(day) + r":part:(\d+)$", k["name"])
        if not m:
            fail("unexpected_bundle_key")
        out[int(m.group(1))] = k.get("expiration")
    return out


def read_report(token, day):
    """Relatório consolidado do dia (texto) ou None (ausente, legado v1 ou de outro dia). A existência é conferida pela
    listagem (sem ler valor); relatório listado e ilegível reprova (nunca cai no legado em silêncio)."""
    if REPORT_KEY not in {k["name"] for k in kv_list(token, REPORT_KEY)}:
        return None
    raw = kv_get(token, REPORT_KEY)
    try:
        r = json.loads(raw)
    except ValueError:
        fail("report_malformed")
    if isinstance(r, dict) and r.get("contract") == 2 and r.get("day") == day:
        return raw.decode("utf-8")
    return None


def mode_archive(args, token):
    passphrase = passphrase_or_fail()
    ring = parse_keyring(os.environ.get("P20_BACKUP_KEYS"))
    keys = neon_part_keys(token, args.day)
    report_text = read_report(token, args.day)
    if report_text is not None:
        # P20 v2: exatamente as partes declaradas no relatório autenticado; ausente, extra ou com hash diferente reprova.
        rep, auth_state = verify_report_v2(report_text, args.day, ring)
        exp = expected_parts_v2(rep)
        with_bundle = {p for p, e in exp.items() if e["tables"]}
        if set(keys) - with_bundle:
            fail("extra_part " + ",".join(str(p) for p in sorted(set(keys) - with_bundle)))
        if with_bundle - set(keys):
            fail("missing_part " + ",".join(str(p) for p in sorted(with_bundle - set(keys))))
        raw = {}
        for p in sorted(with_bundle):
            if exp[p]["key"] != bundle_key(args.day, p):
                fail(f"report_bundle_key_mismatch part={p}")
            raw[p] = kv_get(token, bundle_key(args.day, p))
            if sha256_hex(raw[p]) != exp[p]["sha256"]:
                fail(f"part_hash_mismatch part={p}")
        tables, info, _plain = describe_parts(raw, args.day, ring)
        if content_state(info) != ST_ENC_OPAQUE:
            declared = {t: {"part": p, "rows": v["rows"], "sha256": v["sha"]} for p, e in exp.items() for t, v in e["tables"].items()}
            if tables != declared:
                fail("table_report_mismatch")
        else:
            auth_state = AUTH_NONE
        contract = 2
    else:
        # Legado v1 (3 partes, sem plano autenticado): arquivado, mas NUNCA declarado completo/autenticado.
        raw = {}
        for p in range(PARTS):
            if p not in keys:
                fail("missing_part " + bundle_key(args.day, p))
            raw[p] = kv_get(token, bundle_key(args.day, p))
        if set(keys) - set(range(PARTS)):
            fail("extra_part " + ",".join(str(p) for p in sorted(set(keys) - set(range(PARTS)))))
        tables, info, _plain = describe_parts(raw, args.day, ring)
        check_expected(tables, args, info)
        auth_state, contract = AUTH_LEGACY, 1
    # Arquiva o VALOR ORIGINAL de cada parte (envelope cifrado fica cifrado): nenhum texto claro novo.
    doc = {"schema": "zevanory-backup-archive/v1", "day": args.day, "parts": {str(p): b.decode("utf-8") for p, b in raw.items()}}
    if report_text is not None:
        doc["report"] = report_text
    plaintext = json.dumps(doc, separators=(",", ":")).encode("utf-8")
    blob = encrypt(plaintext, passphrase)
    if decrypt(blob, passphrase) != plaintext:
        fail("roundtrip_failed")
    manifest = build_manifest(args.day, raw, tables, blob, plaintext,
                              {bundle_key(args.day, p): {"expiration": keys.get(p)} for p in sorted(raw)}, info)
    manifest.update({"contract": contract, "auth_state": auth_state,
                     "complete": contract == 2 and auth_state == AUTH_OK and content_state(info) != ST_ENC_OPAQUE})
    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, "archive.enc"), "wb") as f:
        f.write(blob)
    with open(os.path.join(args.out, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2, sort_keys=True)
    note("BACKUP_PRESERVE_ARCHIVE", {"day": args.day, "totals": manifest["totals"], "ciphertext_sha256": manifest["ciphertext_sha256"],
                                     "plaintext_sha256": manifest["plaintext_sha256"], "sources": manifest["sources"],
                                     "content_state": manifest["content_state"], "parts": manifest["parts"],
                                     "contract": contract, "auth_state": auth_state, "complete": manifest["complete"]})
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
    if doc.get("report") is not None:
        # P20 v2: o relatório embutido continua autenticado e a cobertura é a do plano.
        rep, st = verify_report_v2(doc["report"], doc.get("day"), ring)
        expected_parts_v2(rep)
        if manifest.get("auth_state") == AUTH_OK and st != AUTH_OK:
            fail("report_auth_downgrade")
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
    report_text = read_report(token, args.day)
    parts = sorted(d.get("part") for d in json.loads(report_text).get("parts_detail") or [] if (d.get("tables") or {})) if report_text else list(range(PARTS))
    for p in parts:
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
    ap.add_argument("--kv-fixture", default="")
    args = ap.parse_args(argv)
    if not DAY_RE.match(args.day):
        fail("invalid_day")
    if args.mode == "verify":
        return mode_verify(args)
    global KV_FIXTURE
    if args.kv_fixture:
        # Só CI: KV em arquivo (gerado pelo Worker real). Nunca combinado com a escrita na produção.
        if args.mode == "kv-extend":
            fail("kv_fixture_not_allowed_for_kv_extend")
        with open(args.kv_fixture, encoding="utf-8") as f:
            KV_FIXTURE = json.load(f)
        if not isinstance(KV_FIXTURE, dict) or not all(isinstance(v, str) for v in KV_FIXTURE.values()):
            fail("kv_fixture_malformed")
        token = "fixture"
    else:
        # .strip(): segredo salvo com quebra de linha quebrava o cabeçalho HTTP no urllib (issue #849).
        token = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
    if not token:
        fail("cloudflare_token_missing")
    return {"inspect": mode_inspect, "archive": mode_archive, "kv-extend": mode_kv_extend}[args.mode](args, token)


if __name__ == "__main__":
    main()
