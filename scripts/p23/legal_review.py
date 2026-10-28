#!/usr/bin/env python3
"""ZEVANORY | Revisão jurídica dos textos de consumo (M1, reauditoria do PR #946).

Uma única regra, usada em dois lugares:
  * scripts/p23/ecommerce_legal_gate.py (check de PR p23 / ecommerce-legal);
  * os workflows que PUBLICAM /termos e /reembolso (zevanory-sales-public-release.yml, job deploy, e
    central-production-deploy.yml, job deploy), com --publish-gate, antes de qualquer chamada à Cloudflare.

Impressão digital (legal_fingerprint), rodada 5: SHA-256 dos BYTES de tudo o que forma as páginas jurídicas como são
servidas pelo Worker de vendas: cada página (sales-public/termos, reembolso, privacidade e afiliados), todo asset que ela
referencia (CSS, JS, fontes, imagens, iframes; CSS seguido em url()/@import), resolvido no próprio artefato (asset
ausente, externo ou fora do artefato reprova), as fontes dessas páginas na raiz (termos/, reembolso/, privacidade/,
afiliados/) e os textos de consumo de data/politica-unica.json (sol_text, rule_7d, customer_wording, refund_channels,
legal_document_version). Qualquer byte diferente (texto, atributo, CSS, ::after, elemento escondido) muda a impressão
digital. Cada página servida também precisa ter exatamente um <main> fora de comentários.
No deploy, o portão roda logo antes de CADA passo que publica, com o código lido do gh-pages mesclado (git show), sobre
o artefato exato que vai ao ar; as rotas jurídicas do Worker servem esses bytes sem nenhuma alteração.

Aprovação válida (validate_approval), em data/politica-unica.json -> legal_review. Uma string livre não basta:
  * identidade AUTORIZADA: reviewer_id cadastrado em data/p23/legal-reviewers.json (nome, registro profissional,
    login do GitHub, autorizado pelo proprietário com data e commit da autorização); approved_by igual ao nome
    cadastrado, com nome e sobrenome (opcional ", OAB/UF 12345") e sem marcador de teste ou papel genérico;
  * conteúdo: reviewed_sha256 igual à impressão digital ATUAL (o texto revisado é o que vai ao ar);
  * versão: document_version igual a legal_document_version de data/politica-unica.json (a versão entra na impressão);
  * origem: reviewed_commit com o SHA (40 hex) do commit que contém o texto revisado; approved_at em data ISO, não futura;
  * registro auditável: record aponta para docs/legal/reviews/<reviewed_sha256>.json, versionado, com os mesmos
    reviewer_id, reviewed_sha256, reviewed_commit, document_version, approved_at e decision "APPROVED".
  Hoje o cadastro de revisores está VAZIO: nenhuma aprovação passa até o proprietário cadastrar quem revisa.

Portão de publicação (--publish-gate), fail-closed:
  * impressão digital igual à de data/p23/legal-published-baseline.json (texto que já está publicado): PASSA, mesmo
    com a revisão PENDENTE. Um deploy que não muda texto jurídico não fica preso e nada que já está no ar é retirado;
  * texto diferente do publicado: exige aprovação válida para ESTA impressão digital; sem ela, sai com código 1 e o
    deploy para antes de tocar a produção (o que está no ar continua como está).
Âncoras de confiança (M-A, rodada 3): no portão de publicação, o cadastro de revisores, a linha de base, os registros
de aprovação e o bloco legal_review são lidos do gh-pages JÁ MESCLADO (--anchors-ref refs/remotes/origin/gh-pages),
nunca da árvore em publicação, e conferidos no histórico do git:
  * o commit publicado tem de estar contido no gh-pages;
  * authorization_commit tem de ser um commit do gh-pages que introduziu exatamente aquela entrada do cadastro
    (com merge por squash, o cadastro entra num PR e a aprovação só pode citá-lo num PR seguinte);
  * reviewed_commit tem de ser um commit do gh-pages, e a impressão digital do texto NAQUELE commit tem de ser
    reviewed_sha256 (o hash é recalculado, não declarado);
  * a linha de base só vale se for o texto publicado antes da Release 2 (GENESIS_BASELINE, b7671272) ou o
    reviewed_sha256 de um registro de aprovação válido já no gh-pages.
Antes do merge, o check protegido legal-trust-anchors-protected (pull_request_target, código da base, PR lido só
como dado) reprova todo PR que altere uma âncora; o proprietário decide de forma explícita e deliberada (bypass).
Sol ORDEM 312 (rodada 12):
  * dois níveis de aprovação: PROFESSIONAL (status APPROVED, OAB) e INTERNAL_OWNER (status APPROVED_INTERNAL, type
    internal_owner, disclaimer "não constitui parecer jurídico", checklist P23 completo e auditoria independente);
    o portão imprime qual (LEGAL_APPROVAL_LEVEL); a interna nunca é apresentada como parecer;
  * sem congelamento: --apply-snapshot troca no diretório servido o texto jurídico não aprovado pelo último texto
    aprovado (reproduzido do commit de origem; gênese b7671272) e o portão passa se o conjunto SERVIDO for o de um
    texto aprovado (LEGAL_SERVED=APPROVED_HEAD|APPROVED_SNAPSHOT, LEGAL_PENDING); código que serve ou textos de
    consumo não aprovados bloqueiam só o deploy de vendas (o central não usa este portão);
  * emergência (workflow_dispatch mode=emergency, dono do repositório, motivo): só com os textos do snapshot aprovado.
Sem rede, sem segredos; só lê arquivos e o histórico do git local.
Uso: legal_review.py --root . --fingerprint | --publish-gate --anchors-ref <ref> | --apply-snapshot <dir> --anchors-ref <ref> | --check-approval
"""
from __future__ import annotations

import argparse, datetime as dt, hashlib, html, json, os, re, subprocess, sys, unicodedata
from pathlib import Path

# MED-2 (rodada 4): /privacidade e /afiliados também são textos jurídicos de consumo (LGPD; programa de afiliados) e
# entram na impressão digital, nas duas superfícies.
LEGAL_PAGES = ("sales-public/termos.html", "sales-public/reembolso.html", "termos/index.html", "reembolso/index.html",
               "sales-public/privacidade.html", "sales-public/afiliados.html", "privacidade/index.html", "afiliados/index.html")
POLICY_FIELDS = ("legal_document_version", "sol_text", "rule_7d", "customer_wording", "refund_channels")
BASELINE = "data/p23/legal-published-baseline.json"
REVIEWERS = "data/p23/legal-reviewers.json"
RECORDS = "docs/legal/reviews"
POLICY = "data/politica-unica.json"
# Texto jurídico publicado antes da Release 2 (gh-pages b7671272): a única linha de base aceita sem registro de aprovação.
GENESIS_BASELINE = "30d9b928d17b96d9cf596a878bc55692367516a59556bcf5d5c560aa3345b5c3"
GENESIS_COMMIT = "b7671272b1c0b35d1bb7a20fa2489bd7c5a0f224"  # Sol ORDEM 312: o snapshot de origem é reproduzível deste commit
CHECKLIST = "data/p23/ecommerce-legal-checklist.json"
REVOKED = "data/p23/legal-revoked.json"  # rodada 12 (LOW-3): aprovações revogadas pelo proprietário (âncora)
# Sol ORDEM 312: a aprovação INTERNAL (proprietário) é um controle temporário e nunca é apresentada como parecer.
INTERNAL_DISCLAIMER = "Aprovação interna do proprietário: controle temporário; não constitui parecer jurídico."
LEVEL_TEXT = {"PROFESSIONAL": "PROFESSIONAL (revisão de advogado(a) com registro na OAB)",
              "INTERNAL_OWNER": "INTERNAL_OWNER (" + INTERNAL_DISCLAIMER + " Checklist P23 e auditoria independente registrados.)",
              "GENESIS": "GENESIS (texto publicado antes da Release 2, reproduzível de b7671272)"}
CLOCK_SKEW = dt.timedelta(minutes=5)


class Tree:
    """Arquivos de um diretório (conteúdo em publicação, ou fixtures sem git)."""
    git = None

    def __init__(self, root):
        self.root = Path(root)

    def read(self, rel):
        try:
            return (self.root / rel).read_text(encoding="utf-8")
        except OSError:
            return None

    def read_bytes(self, rel):
        try:
            return (self.root / rel).read_bytes()
        except OSError:
            return None

    def names(self, rel):
        d = self.root / rel
        return sorted(p.name for p in d.iterdir()) if d.is_dir() else []


class GitRef:
    """Arquivos de um commit/ref do repositório local, lidos com git show (nunca da árvore de trabalho)."""

    def __init__(self, repo, ref):
        self.repo, self.ref = Path(repo), ref
        self.git = self

    def run(self, *args):
        r = subprocess.run(["git", "-C", str(self.repo), *args], capture_output=True, text=True, encoding="utf-8")
        return r.returncode, r.stdout

    def commit(self, ref=None):
        rc, out = self.run("rev-parse", "--verify", "--quiet", (ref or self.ref) + "^{commit}")
        return out.strip() if rc == 0 else None

    def read(self, rel, ref=None):
        rc, out = self.run("show", f"{ref or self.ref}:{rel}")
        return out if rc == 0 else None

    def read_bytes(self, rel, ref=None):
        r = subprocess.run(["git", "-C", str(self.repo), "show", f"{ref or self.ref}:{rel}"], capture_output=True)
        return r.stdout if r.returncode == 0 else None

    def names(self, rel):
        rc, out = self.run("ls-tree", "--name-only", f"{self.ref}:{rel}")
        return sorted(out.split()) if rc == 0 else []

    def is_ancestor(self, a, b=None):
        return self.commit(a) is not None and self.run("merge-base", "--is-ancestor", a, b or self.ref)[0] == 0

    def at(self, ref):
        return GitRef(self.repo, ref)


def _loads(text):
    try:
        return json.loads(text) if text is not None else None
    except ValueError:
        return None

def revoked_hashes(anchors) -> set[str]:
    d = _loads(anchors.read(REVOKED)) or {}
    return {str(r.get("sha256")) for r in (d.get("revoked") or []) if isinstance(r, dict) and re.fullmatch(r"[0-9a-f]{64}", str(r.get("sha256", "")))}


# Marcadores de teste, de exemplo ou de papel genérico: nunca identificam quem revisou.
FIXTURE = re.compile(r"(?i)\b(fixture|teste?s?|test|exemplo|example|dummy|fake|mock|placeholder|todo|tbd|xxx+|n/?a|"
                     r"pendente|pending|jurista|advogad[oa]|revisor[a]?|propriet[aá]rio|owner|admin|bot|ci|codex|claude|sol)\b")
NAME = re.compile(r"^[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'’.-]*(?: (?:d[aeo]s?|e|[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'’.-]*))+"
                  r"(?:,? \(?OAB/[A-Z]{2} ?\d{3,7}\)?)?$")


# ---------- impressão digital por BYTES do artefato (rodada 5) ----------
# Páginas jurídicas servidas pelo Worker de vendas, a partir do diretório de assets publicado (wrangler.sales.toml
# [assets] directory = ./sales-public). Os assets que elas referenciam são resolvidos nesse mesmo diretório.
ARTIFACT_DIR = "sales-public"
SERVED_LEGAL = ("termos", "reembolso", "privacidade", "afiliados")
LEGAL_SERVING_CODE = ("sales-worker.mjs", "worker/sales-public-worker.mjs", "worker/politica-unica.mjs", "wrangler.sales.toml")
# <link rel> que não carrega nada na página (só metadado): não é asset.
_LINK_NOT_ASSET = {"canonical", "alternate", "author", "license", "help", "prev", "next", "search", "me", "bookmark"}
_ASSET_ATTRS = {"script": ("src",), "img": ("src", "srcset"), "source": ("src", "srcset"), "iframe": ("src",),
                "frame": ("src",), "object": ("data",), "embed": ("src",), "video": ("src", "poster"), "audio": ("src",),
                "track": ("src",), "input": ("src",), "use": ("href", "xlink:href"), "image": ("href", "xlink:href")}


def _attrs(tag: str) -> dict:
    out = {}
    for m in re.finditer(r"([A-Za-z_:][-\w:.]*)\s*=\s*(?:\"([^\"]*)\"|'([^']*)'|([^\s>\"']+))", tag):
        value = next(g for g in m.groups()[1:] if g is not None)
        out[m.group(1).lower()] = html.unescape(value)
    return out


def _css_refs(css: str) -> list[str]:
    css = re.sub(r"/\*.*?\*/", " ", css, flags=re.S)
    refs = [m.group(2) for m in re.finditer(r"url\(\s*(['\"]?)(.*?)\1\s*\)", css, re.I)]
    refs += [m.group(2) for m in re.finditer(r"@import\s+(['\"])(.*?)\1", css, re.I)]
    return refs


def _html_refs(page: str) -> list[str]:
    refs: list[str] = []
    for m in re.finditer(r"<([A-Za-z][\w:-]*)\b([^>]*)>", page):
        name, a = m.group(1).lower(), _attrs(m.group(2))
        if name == "link":
            rels = set(a.get("rel", "").lower().split())
            if a.get("href") and not rels <= _LINK_NOT_ASSET:
                refs.append(a["href"])
        for at in _ASSET_ATTRS.get(name, ()):
            if a.get(at):
                refs += [c.strip().split()[0] for c in a[at].split(",") if c.strip()] if at == "srcset" else [a[at]]
        if a.get("style"):
            refs += _css_refs(a["style"])
    for m in re.finditer(r"<style\b[^>]*>(.*?)</style\s*>", page, re.S | re.I):
        refs += _css_refs(m.group(1))
    return refs


def _resolve(ref: str, base_url: str, origin_rel: str) -> str | None:
    """URL referenciada -> caminho dentro do artefato. None = não é arquivo (data:, #, mailto:); externo reprova."""
    ref = ref.strip()
    if not ref or ref.startswith(("#", "data:", "mailto:", "tel:", "javascript:", "about:")):
        return None
    if re.match(r"^([a-z][a-z0-9+.-]*:)?//", ref, re.I):
        raise SystemExit(f"LEGAL_ASSET_EXTERNAL {origin_rel}: {ref} (asset de fora do artefato não pode ser conferido)")
    path = ref.split("#", 1)[0].split("?", 1)[0]
    if not path.startswith("/"):
        path = base_url.rsplit("/", 1)[0] + "/" + path
    parts: list[str] = []
    for seg in path.split("/"):
        if seg in ("", "."):
            continue
        if seg == "..":
            if not parts:
                raise SystemExit(f"LEGAL_ASSET_OUTSIDE {origin_rel}: {ref}")
            parts.pop()
        else:
            parts.append(seg)
    return ARTIFACT_DIR + "/" + "/".join(parts)


def _check_main(raw: str, rel: str) -> None:
    s = re.sub(r"<!--.*?(?:-->|\Z)", " ", raw, flags=re.S)
    opened, closed = len(re.findall(r"<main\b", s, re.I)), len(re.findall(r"</main\s*>", s, re.I))
    if opened != 1 or closed != 1:
        raise SystemExit(f"LEGAL_FINGERPRINT_MAIN_INVALID {rel}: exige exatamente um <main> fora de comentários (abertos={opened}, fechados={closed})")
    # Rodada 6 (L-2): <base href> muda a resolução dos assets e meta refresh troca a página servida; nenhum dos dois
    # pode existir numa página jurídica.
    if re.search(r"<base\b", s, re.I):
        raise SystemExit(f"LEGAL_PAGE_FORBIDDEN {rel}: <base> não é aceito numa página jurídica")
    if re.search(r"<meta\b[^>]*http-equiv\s*=\s*[\"']?refresh", s, re.I):
        raise SystemExit(f"LEGAL_PAGE_FORBIDDEN {rel}: meta refresh não é aceito numa página jurídica")


def legal_artifact_files(src, sources: bool = True) -> list[tuple[str, bytes]]:
    """Todos os arquivos que formam as páginas jurídicas como são servidas: cada página jurídica do artefato, todo
    asset que ela referencia (CSS, JS, fontes, imagens, iframes), recursivamente (CSS -> url()/@import), e as fontes
    das páginas na raiz. Asset ausente, externo ou fora do artefato reprova (fail-closed)."""
    out: dict[str, bytes] = {}
    queue: list[tuple[str, str, str]] = []  # (caminho no artefato, url base, de onde veio)
    for name in SERVED_LEGAL:
        rel = f"{ARTIFACT_DIR}/{name}.html"
        queue.append((rel, f"/{name}", rel))
    while queue:
        rel, base_url, origin = queue.pop(0)
        if rel in out:
            continue
        data = src.read_bytes(rel)
        if data is None:
            raise SystemExit(f"LEGAL_ASSET_MISSING {origin}: {rel}")
        out[rel] = data
        text = data.decode("utf-8", "replace")
        if rel.endswith(".html"):
            if origin == rel:  # página jurídica servida (não um iframe referenciado)
                _check_main(text, rel)
            refs = _html_refs(text)
        elif rel.endswith(".css"):
            refs = _css_refs(text)
        else:
            refs = []
        for ref in refs:
            target = _resolve(ref, base_url, rel)
            if target:
                queue.append((target, "/" + target.removeprefix(ARTIFACT_DIR + "/"), rel))
    # Rodada 6: o código que SERVE as rotas jurídicas e a configuração dele também entram, por bytes (o pacote do
    # Worker é gerado só destes arquivos no job worker-bundle, que não roda outro código do repositório).
    for rel in LEGAL_SERVING_CODE:
        data = src.read_bytes(rel)
        if data is None:
            raise SystemExit(f"LEGAL_FINGERPRINT_SOURCE_MISSING {rel}")
        out[rel] = data
    for rel in (LEGAL_PAGES if sources else ()):
        if not rel.startswith(ARTIFACT_DIR + "/"):
            data = src.read_bytes(rel)
            if data is None:
                raise SystemExit(f"LEGAL_FINGERPRINT_SOURCE_MISSING {rel}")
            out[rel] = data
    return sorted(out.items())


def legal_fingerprint_src(src) -> str:
    return _digest(src, legal_artifact_files(src), b"")


def served_fingerprint(src) -> str:
    """Sol ORDEM 312: o que o Worker de vendas SERVE (páginas jurídicas e assets do artefato, o código que as serve e
    os textos de consumo), sem as fontes da raiz, que não vão ao ar. Um deploy só passa se isto for igual ao de um
    texto aprovado."""
    return _digest(src, legal_artifact_files(src, sources=False), b"zevanory-legal-served/v1\0")


def texts_fingerprint(src) -> str:
    """Só os TEXTOS servidos (páginas jurídicas, assets e textos de consumo), sem o código: usado no modo emergência,
    que nunca troca texto jurídico protegido."""
    files = [(r, d) for r, d in legal_artifact_files(src, sources=False) if r.startswith(ARTIFACT_DIR + "/")]
    return _digest(src, files, b"zevanory-legal-texts/v1\0")


def _digest(src, files, prefix: bytes) -> str:
    h = hashlib.sha256(prefix) if prefix else hashlib.sha256()
    for rel, data in files:
        h.update(rel.encode() + b"\0" + str(len(data)).encode() + b"\0" + data + b"\0")
    pol = _loads(src.read(POLICY))
    if not isinstance(pol, dict):
        raise SystemExit(f"LEGAL_FINGERPRINT_SOURCE_MISSING {POLICY}")
    for k in POLICY_FIELDS:
        if k not in pol and k not in ("refund_channels", "legal_document_version"):
            raise SystemExit(f"LEGAL_FINGERPRINT_FIELD_MISSING {k}")
        h.update(k.encode() + b"\0" + json.dumps(pol.get(k), ensure_ascii=False, sort_keys=True).encode() + b"\0")
    return h.hexdigest()


def legal_fingerprint(root: Path) -> str:
    return legal_fingerprint_src(Tree(root))


def _day(value) -> dt.date | None:
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?", value):
        return None
    try:
        return dt.date.fromisoformat(value[:10])
    except ValueError:
        return None


def _future(value, now: dt.datetime) -> bool:
    """Data só (AAAA-MM-DD): no máximo hoje (UTC). Data e hora: no máximo agora + 5 min de diferença de relógio."""
    if len(value) == 10:
        return dt.date.fromisoformat(value) > now.date()
    try:
        at = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return True
    if at.tzinfo is None:
        at = at.replace(tzinfo=dt.timezone.utc)
    return at > now + CLOCK_SKEW


def validate_approval(review, fingerprint: str, today: dt.date | None = None, root: Path | None = None,
                      anchors=None, content=None, now: dt.datetime | None = None) -> list[str]:
    """Valida o bloco de aprovação. anchors = de onde vêm cadastro e registros (Tree da mesma árvore no P23 de PR;
    GitRef do gh-pages no portão de publicação, com as conferências de histórico)."""
    now = now or dt.datetime.now(dt.timezone.utc)
    if today is not None:
        now = dt.datetime.combine(today, dt.time(23, 59), dt.timezone.utc)
    review = review if isinstance(review, dict) else {}
    root = Path(root) if root else Path(__file__).resolve().parents[2]
    anchors = anchors or Tree(root)
    content = content or Tree(root)
    git = getattr(anchors, "git", None)
    errs: list[str] = []
    if review.get("status") not in ("APPROVED", "APPROVED_INTERNAL"):
        errs.append("REVISÃO JURÍDICA PENDENTE; legal_review exige status APPROVED (profissional, OAB) ou APPROVED_INTERNAL (interna do proprietário, type internal_owner), approved_by, approved_at, reviewed_sha256 e reviewed_commit")
        return errs
    internal = review.get("status") == "APPROVED_INTERNAL"
    if internal and review.get("type") != "internal_owner":
        errs.append("legal_review: APPROVED_INTERNAL exige type \"internal_owner\"")
    if not internal and review.get("type") not in (None, "professional"):
        errs.append("legal_review: status APPROVED é só para a revisão profissional (OAB); a interna usa APPROVED_INTERNAL")
    who = review.get("approved_by")
    who = who.strip() if isinstance(who, str) else ""
    if not who or not NAME.fullmatch(who) or FIXTURE.search(who):
        errs.append(f"legal_review.approved_by {review.get('approved_by')!r} não identifica uma pessoa (nome e sobrenome, opcional ', OAB/UF número'; sem marcador de teste ou papel genérico)")
    if internal and "OAB" in who.upper():
        errs.append("legal_review: aprovação interna não pode citar OAB (não é revisão profissional)")
    if internal:
        errs += _internal_errors(review, None, anchors, who, where="legal_review")
    day = _day(review.get("approved_at"))
    if day is None:
        errs.append(f"legal_review.approved_at {review.get('approved_at')!r} não é uma data ISO (AAAA-MM-DD)")
    elif _future(review["approved_at"], now):
        errs.append(f"legal_review.approved_at {review.get('approved_at')!r} está no futuro")
    sha = review.get("reviewed_sha256")
    if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{64}", sha):
        errs.append("legal_review.reviewed_sha256 ausente ou inválido (SHA-256 do texto revisado: legal_review.py --fingerprint)")
    elif sha != fingerprint:
        errs.append(f"legal_review.reviewed_sha256 {sha[:12]}… não corresponde ao texto atual {fingerprint[:12]}…: o texto mudou depois da revisão")
    elif sha in revoked_hashes(anchors):
        errs.append(f"legal_review.reviewed_sha256 {sha[:12]}… foi revogado pelo proprietário ({REVOKED})")
    commit = review.get("reviewed_commit")
    if not isinstance(commit, str) or not re.fullmatch(r"[0-9a-f]{40}", commit):
        errs.append("legal_review.reviewed_commit ausente ou inválido (SHA de 40 caracteres do commit com o texto revisado)")
    elif git is not None:
        # O hash é recalculado no commit revisado, que tem de estar no gh-pages.
        if not git.is_ancestor(commit):
            errs.append(f"legal_review.reviewed_commit {commit[:12]} não é um commit do gh-pages")
        else:
            try:
                at_commit = legal_fingerprint_src(git.at(commit))
            except SystemExit as e:
                at_commit = str(e)
            if at_commit != sha:
                errs.append(f"legal_review.reviewed_commit {commit[:12]}: o texto desse commit não tem a impressão digital {str(sha)[:12]}…")
    # Versão do documento revisado.
    pol = _loads(content.read(POLICY)) or {}
    version = pol.get("legal_document_version")
    if not isinstance(version, str) or not version.strip() or review.get("document_version") != version:
        errs.append(f"legal_review.document_version {review.get('document_version')!r} difere da versão publicada {version!r}")
    # Identidade autorizada (cadastro mantido pelo proprietário, lido das âncoras).
    reg = _loads(anchors.read(REVIEWERS))
    reviewers = reg.get("reviewers") if isinstance(reg, dict) else None
    entry = next((r for r in (reviewers or []) if isinstance(r, dict) and r.get("id") == review.get("reviewer_id")), None)
    if entry is None:
        errs.append(f"legal_review.reviewer_id {review.get('reviewer_id')!r} não está no cadastro de revisores autorizados ({REVIEWERS})")
    else:
        auth_day = _day(entry.get("authorized_at"))
        kind_ok = (entry.get("type") == "internal_owner" and not entry.get("registro")) if internal else \
            (entry.get("type") in (None, "professional") and re.fullmatch(r"OAB/[A-Z]{2} ?\d{3,7}", str(entry.get("registro", ""))))
        if (entry.get("name") != who or entry.get("authorized_by") != "proprietario" or auth_day is None
                or not re.fullmatch(r"[0-9a-f]{40}", str(entry.get("authorization_commit", "")))
                or not kind_ok
                or not re.fullmatch(r"[A-Za-z0-9-]{1,39}", str(entry.get("github_login", "")))):
            errs.append(f"legal_review.reviewer_id {review.get('reviewer_id')!r}: cadastro incompleto, de outro nível ou nome diferente de approved_by (profissional: registro OAB; interna: type internal_owner sem OAB; ambos: name, github_login, authorized_by=proprietario, authorized_at e authorization_commit)")
        elif day is not None and auth_day > day:
            errs.append("legal_review: aprovação anterior à autorização do revisor")
        elif git is not None:
            # A autorização é um commit do gh-pages que introduziu esta entrada; ela não pode vir no mesmo PR da aprovação.
            ac = entry.get("authorization_commit")
            other = {k: v for k, v in entry.items() if k != "authorization_commit"}
            reg_at = _loads(git.read(REVIEWERS, ac)) if git.is_ancestor(ac) else None
            introduced = isinstance(reg_at, dict) and any(isinstance(r, dict) and r == other for r in (reg_at.get("reviewers") or []))
            parent = _loads(git.read(REVIEWERS, ac + "^")) if introduced else None
            existed = isinstance(parent, dict) and any(isinstance(r, dict) and r.get("id") == entry.get("id") for r in (parent.get("reviewers") or []))
            if not introduced or existed:
                errs.append(f"legal_review.reviewer_id {review.get('reviewer_id')!r}: authorization_commit {str(ac)[:12]} não é o commit do gh-pages que cadastrou este revisor")
    # Registro auditável versionado (das âncoras).
    rec_path = review.get("record")
    want = f"{RECORDS}/{sha}.json" if isinstance(sha, str) else None
    rec = _loads(anchors.read(rec_path)) if isinstance(rec_path, str) and rec_path == want else None
    if not isinstance(rec, dict):
        errs.append(f"legal_review.record ausente: exige o registro {want or RECORDS + '/<reviewed_sha256>.json'} versionado no repositório")
    else:
        for k in ("reviewer_id", "reviewed_sha256", "reviewed_commit", "document_version", "approved_at"):
            if rec.get(k) != review.get(k):
                errs.append(f"registro {rec_path}: {k} {rec.get(k)!r} difere de legal_review ({review.get(k)!r})")
        want_decision = "APPROVED_INTERNAL" if internal else "APPROVED"
        if rec.get("decision") != want_decision:
            errs.append(f"registro {rec_path}: decision deve ser {want_decision}")
        if (rec.get("type") or "professional") != ("internal_owner" if internal else "professional"):
            errs.append(f"registro {rec_path}: type difere do nível da aprovação")
        if internal:
            errs += _internal_errors(rec, rec, anchors, who, where=f"registro {rec_path}", rec_path=rec_path)
        ac = entry.get("authorization_commit") if isinstance(entry, dict) else None
        if git is not None and isinstance(ac, str) and re.fullmatch(r"[0-9a-f]{40}", ac):
            # O registro entra no gh-pages DEPOIS do commit que cadastrou o revisor, nunca no mesmo commit: cadastro
            # e aprovação não nascem juntos (squash: um PR cada; rebase: commits distintos, ainda sob o check protegido).
            rc, out = git.run("log", "--format=%H", "--diff-filter=A", git.ref, "--", rec_path)
            added = out.split()[-1] if rc == 0 and out.split() else None
            if not added or added == ac or not git.is_ancestor(ac, added):
                errs.append(f"registro {rec_path}: tem de entrar no gh-pages num commit posterior ao authorization_commit {ac[:12]}")
    return errs


def _strings(obj):
    if isinstance(obj, str):
        yield obj
    elif isinstance(obj, dict):
        for v in obj.values():
            yield from _strings(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _strings(v)


AUDIT_DIR = "docs/legal/audits"
AUDITOR_KINDS = ("independent_ai_auditor", "human")


def _norm(name) -> str:
    t = unicodedata.normalize("NFKD", str(name or "")).encode("ascii", "ignore").decode().casefold()
    return re.sub(r"[^a-z0-9]+", " ", t).strip()


def _audit_errors(rec, anchors, who: str, where: str, rec_path) -> list[str]:
    """Rodada 12 (MED-2): a auditoria independente é um arquivo VERSIONADO no gh-pages (docs/legal/audits/), com sha256
    conferido, que entrou antes do registro de aprovação e declara escopo e SHA auditado; o auditor é de um tipo
    declarado e não é quem aprova nem um revisor cadastrado (nomes comparados normalizados)."""
    errs = []
    audit = rec.get("audit_report") if isinstance(rec.get("audit_report"), dict) else {}
    ref, sha = str(audit.get("ref", "")).strip(), str(audit.get("sha256", ""))
    auditor, kind = str(audit.get("auditor", "")).strip(), audit.get("auditor_kind")
    if not re.fullmatch(AUDIT_DIR + r"/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:md|txt|json)", ref):
        return errs + [f"{where}: audit_report.ref tem de ser um arquivo versionado em {AUDIT_DIR}/ (URL externa não é aceita)"]
    if not re.fullmatch(r"[0-9a-f]{64}", sha):
        errs.append(f"{where}: audit_report.sha256 ausente ou inválido")
    data = anchors.read_bytes(ref)
    if data is None or hashlib.sha256(data).hexdigest() != sha:
        errs.append(f"{where}: audit_report {ref} ausente nas âncoras ou com sha256 diferente")
    else:
        text = data.decode("utf-8", "replace")
        if not re.search(r"(?i)\b(escopo|scope)\b", text) or not re.search(r"\b[0-9a-f]{40}\b", text):
            errs.append(f"{where}: o relatório de auditoria tem de declarar o escopo e o SHA (40 hex) auditado")
    if kind not in AUDITOR_KINDS:
        errs.append(f"{where}: audit_report.auditor_kind tem de ser um de {AUDITOR_KINDS}")
    reg = _loads(anchors.read(REVIEWERS)) or {}
    names = {_norm(who)} | {_norm(r.get("name")) for r in (reg.get("reviewers") or []) if isinstance(r, dict)}
    if not auditor or _norm(auditor) in names:
        errs.append(f"{where}: audit_report.auditor tem de ser independente (diferente de quem aprova e de todo revisor cadastrado)")
    elif kind == "human" and (not NAME.fullmatch(auditor) or FIXTURE.search(auditor)):
        errs.append(f"{where}: auditor humano tem de ser identificado por nome e sobrenome")
    git = getattr(anchors, "git", None)
    if git is not None and data is not None and isinstance(rec_path, str):
        def added(path):
            rc, out = git.run("log", "--format=%H", "--diff-filter=A", git.ref, "--", path)
            return out.split()[-1] if rc == 0 and out.split() else None
        a, r = added(ref), added(rec_path)
        if not a or not r or a == r or not git.is_ancestor(a, r):
            errs.append(f"{where}: o relatório de auditoria tem de entrar no gh-pages num commit ANTERIOR ao do registro de aprovação")
    return errs


def _internal_errors(block, rec, anchors, who: str, where: str, rec_path=None) -> list[str]:
    """Aprovação interna (Sol ORDEM 312): aviso exato de que não é parecer; e, no registro, o checklist P23 inteiro
    respondido e a referência a um relatório de auditoria independente."""
    errs = []
    if block.get("disclaimer") != INTERNAL_DISCLAIMER:
        errs.append(f"{where}: aprovação interna exige disclaimer exatamente {INTERNAL_DISCLAIMER!r}")
    others = {k: v for k, v in block.items() if k != "disclaimer"}
    if any(re.search(r"(?i)parecer|opini[aã]o jur[ií]dica|legal opinion", x) for x in _strings(others)):
        errs.append(f"{where}: aprovação interna não pode se apresentar como parecer ou opinião jurídica")
    if rec is None:
        return errs
    ck = _loads(anchors.read(CHECKLIST)) or {}
    ids = [i.get("id") for i in ck.get("items", []) if isinstance(i, dict) and i.get("id")]
    answers = rec.get("checklist") if isinstance(rec.get("checklist"), dict) else {}
    if not ids:
        errs.append(f"{where}: checklist P23 ({CHECKLIST}) ausente nas âncoras")
    for i in ids:
        a = answers.get(i)
        if not isinstance(a, dict) or a.get("answer") not in ("conforme", "nao_aplicavel") or not str(a.get("evidence", "")).strip():
            errs.append(f"{where}: checklist P23 item {i} sem resposta conforme/nao_aplicavel com evidência")
    extra = sorted(set(answers) - set(ids))
    if extra:
        errs.append(f"{where}: checklist com itens que não existem no P23: {extra[:5]}")
    errs += _audit_errors(rec, anchors, who, where, rec_path)
    return errs


def approval_records(anchors, content) -> list[dict]:
    """Registros de aprovação válidos nas âncoras: [{sha, commit, level}]."""
    out = []
    for name in anchors.names(RECORDS):
        rec = _loads(anchors.read(f"{RECORDS}/{name}"))
        if not isinstance(rec, dict) or name != f"{rec.get('reviewed_sha256')}.json":
            continue
        reg = _loads(anchors.read(REVIEWERS)) or {}
        entry = next((r for r in (reg.get("reviewers") or []) if isinstance(r, dict) and r.get("id") == rec.get("reviewer_id")), {})
        internal = rec.get("decision") == "APPROVED_INTERNAL"
        review = {"approved_by": entry.get("name"), "record": f"{RECORDS}/{name}", **rec,
                  "status": "APPROVED_INTERNAL" if internal else "APPROVED"}
        version_src = anchors.at(rec["reviewed_commit"]) if getattr(anchors, "git", None) and anchors.is_ancestor(str(rec.get("reviewed_commit"))) else content
        if not validate_approval(review, rec.get("reviewed_sha256"), anchors=anchors, content=version_src):
            out.append({"sha": rec["reviewed_sha256"], "commit": rec["reviewed_commit"], "level": "INTERNAL_OWNER" if internal else "PROFESSIONAL"})
    return out


def approved_hashes(anchors, content) -> set[str]:
    return {r["sha"] for r in approval_records(anchors, content)}


class Overlay(Tree):
    """Árvore do commit (base/) com o diretório servido (sales-public/) vindo do artefato."""

    def __init__(self, root, serve_dir):
        super().__init__(root)
        self.serve = Path(serve_dir)

    def _p(self, rel):
        return self.serve / rel[len(ARTIFACT_DIR) + 1:] if rel.startswith(ARTIFACT_DIR + "/") else self.root / rel

    def read(self, rel):
        try:
            return self._p(rel).read_text(encoding="utf-8")
        except OSError:
            return None

    def read_bytes(self, rel):
        try:
            return self._p(rel).read_bytes()
        except OSError:
            return None


def _level_line(level: str) -> str:
    return f"LEGAL_APPROVAL_LEVEL={LEVEL_TEXT[level]}"


def _baseline(anchors, content, rehearsal: bool):
    base, src = _loads(anchors.read(BASELINE)), "gh-pages"
    if base is None and rehearsal:  # ensaio antes do merge da Release 2: o gh-pages ainda não tem o arquivo
        base, src = _loads(content.read(BASELINE)), "commit despachado (ausente no gh-pages)"
    return base or {}, src


def approved_snapshots(anchors, content, rehearsal: bool = False) -> tuple[list[dict], list[str]]:
    """Textos aprovados que podem ser servidos (Sol ORDEM 312): a linha de base publicada (gênese b7671272 ou um texto
    aprovado) e cada registro de aprovação válido. Cada um tem de ser REPRODUZÍVEL: a impressão digital recalculada
    no commit de origem (no gh-pages) é a declarada. Ordenados do mais novo para o mais antigo."""
    base, _ = _baseline(anchors, content, rehearsal)
    recs = approval_records(anchors, content)
    levels = {r["sha"]: r["level"] for r in recs}
    cands, errs = [], []
    fp, commit = str(base.get("fingerprint", "")), str(base.get("source_commit", ""))
    if fp:
        if fp == GENESIS_BASELINE and commit != GENESIS_COMMIT:
            errs.append(f"LEGAL_SNAPSHOT_NOT_REPRODUCIBLE linha de base de origem tem de apontar para {GENESIS_COMMIT[:12]}")
        elif fp == GENESIS_BASELINE or fp in levels:
            cands.append({"sha": fp, "commit": commit, "level": "GENESIS" if fp == GENESIS_BASELINE else levels[fp], "from": "baseline"})
    cands += [{**r, "from": "record"} for r in recs]
    gone = revoked_hashes(anchors)
    errs += [f"LEGAL_SNAPSHOT_REVOKED {c['sha'][:12]} (revogado em {REVOKED}; nunca servido)" for c in cands if c["sha"] in gone]
    cands = [c for c in cands if c["sha"] not in gone]
    out, seen = [], set()
    for c in cands:
        if c["sha"] in seen:
            continue
        try:
            ok = bool(re.fullmatch(r"[0-9a-f]{40}", c["commit"])) and anchors.is_ancestor(c["commit"])
            src = anchors.at(c["commit"]) if ok else None
            if not ok or legal_fingerprint_src(src) != c["sha"]:
                errs.append(f"LEGAL_SNAPSHOT_NOT_REPRODUCIBLE {c['sha'][:12]}@{c['commit'][:12]}: a impressão digital recalculada no commit não é a declarada (ou o commit não está no gh-pages)")
                continue
            rc, n = anchors.run("rev-list", "--count", c["commit"])
            out.append({**c, "served": served_fingerprint(src), "texts": texts_fingerprint(src), "order": int(n.strip() or 0), "src": src})
            seen.add(c["sha"])
        except SystemExit as e:
            errs.append(f"LEGAL_SNAPSHOT_NOT_REPRODUCIBLE {c['sha'][:12]}@{c['commit'][:12]}: {e}")
    return sorted(out, key=lambda c: -c["order"]), errs


def _pending(root: Path, snap) -> list[str]:
    """O que o commit em deploy muda no texto jurídico servido em relação ao snapshot aprovado (aguarda aprovação)."""
    try:
        head = GitRef(root, "HEAD")
        mine, served = dict(legal_artifact_files(head, sources=False)), dict(legal_artifact_files(snap, sources=False))
        out = sorted(k for k in set(mine) | set(served) if mine.get(k) != served.get(k))
        pa, pb = _loads(head.read(POLICY)) or {}, _loads(snap.read(POLICY)) or {}
        return out + [f"{POLICY}#{k}" for k in POLICY_FIELDS if pa.get(k) != pb.get(k)]
    except SystemExit as e:
        return [f"(não calculado: {e})"]


def emergency_context():
    """Modo emergência (Sol ORDEM 312, item 3): só workflow_dispatch no gh-pages com mode=emergency, motivo com pelo
    menos 20 caracteres e disparado pelo DONO do repositório. Lido do evento que o próprio GitHub grava no runner."""
    if os.environ.get("GITHUB_EVENT_NAME") != "workflow_dispatch":
        return None
    try:
        ev = json.loads(Path(os.environ.get("GITHUB_EVENT_PATH", "")).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    inputs = ev.get("inputs") or {}
    if inputs.get("mode") != "emergency":
        return None
    reason = str(inputs.get("reason") or "").strip()
    # Rodada 12 (LOW-2): num re-run, sender é quem disparou a primeira vez; quem dispara AGORA é o triggering actor.
    actor = str(os.environ.get("GITHUB_TRIGGERING_ACTOR") or (ev.get("sender") or {}).get("login") or "")
    owner = str(((ev.get("repository") or {}).get("owner") or {}).get("login") or "")
    problems = []
    if os.environ.get("GITHUB_REF") != "refs/heads/gh-pages":
        problems.append("só no gh-pages")
    if len(reason) < 20:
        problems.append("motivo com pelo menos 20 caracteres")
    if not owner or actor != owner:
        problems.append(f"só o dono do repositório ({owner or '?'}) pode disparar; disparado por {actor or '?'}")
    return {"reason": reason, "actor": actor, "problems": problems}


def _decide(root: Path, content, fp: str, anchors, rehearsal: bool) -> tuple[bool, list[str], str]:
    """Decide o que pode ir ao ar (sem a conferência de contenção, feita antes). Devolve (ok, linhas, veredito)."""
    base, src = _baseline(anchors, content, rehearsal)
    baseline = str(base.get("fingerprint", ""))
    lines = [f"LEGAL_PUBLISHED_BASELINE={baseline} source_commit={base.get('source_commit')} origem={src}"]
    recs = approval_records(anchors, content)
    if baseline in revoked_hashes(anchors):
        return False, lines + [f"::error title=LEGAL_PUBLISH_GATE::a linha de base {baseline[:12]} foi revogada ({REVOKED})"], "BLOCKED"
    if baseline != GENESIS_BASELINE and baseline not in {r["sha"] for r in recs}:
        return False, lines + ["::error title=LEGAL_PUBLISH_GATE::linha de base não é o texto pré-Release 2 nem o hash de um registro de aprovação válido no gh-pages"], "BLOCKED"
    def served_label():
        pend = _pending(root, content)  # o que do commit não está sendo servido (vazio: serve o próprio commit)
        return ("APPROVED_SNAPSHOT" if pend else "APPROVED_HEAD"), (", ".join(pend) if pend else "(nenhum)")
    if fp == baseline:
        level = "GENESIS" if fp == GENESIS_BASELINE else next(r["level"] for r in recs if r["sha"] == fp)
        label, pend0 = served_label()
        return True, lines + [f"LEGAL_SERVED={label} {fp}", _level_line(level), f"LEGAL_PENDING={pend0}",
                              "LEGAL_PUBLISH_GATE=PASS_UNCHANGED (texto jurídico idêntico ao já publicado; revisão não exigida para este deploy)"], "PASS_UNCHANGED"
    pol = _loads(anchors.read(POLICY)) or {}
    errs = validate_approval(pol.get("legal_review"), fp, anchors=anchors, content=content)
    if not errs:
        level = "INTERNAL_OWNER" if pol["legal_review"].get("status") == "APPROVED_INTERNAL" else "PROFESSIONAL"
        label, pend0 = served_label()
        return True, lines + [f"LEGAL_SERVED={label} {fp}", _level_line(level), f"LEGAL_PENDING={pend0}", "LEGAL_PUBLISH_GATE=PASS_APPROVED"], "PASS_APPROVED"
    # Texto do commit sem aprovação: só passa se o que vai ao ar for um snapshot aprovado (Sol ORDEM 312, item 2).
    snaps, serrs = approved_snapshots(anchors, content, rehearsal)
    lines += [f"::error title=LEGAL_SNAPSHOT::{e}" for e in serrs]
    served, texts = served_fingerprint(content), texts_fingerprint(content)
    ref_snap = next((c for c in snaps if c["served"] == served), None) or next((c for c in snaps if c["texts"] == texts), None) or (snaps[0] if snaps else None)
    pending = _pending(root, ref_snap["src"] if ref_snap else anchors)  # sem snapshot reproduzível: em relação ao gh-pages
    pend = f"LEGAL_PENDING={', '.join(pending) if pending else '(nenhum)'} ({len(pending)} item(ns) do commit aguardam aprovação e não vão ao ar)"
    match = next((c for c in snaps if c["served"] == served), None)
    if match:
        return True, lines + [f"LEGAL_HEAD_FINGERPRINT={fp} (não aprovado; NÃO é servido)",
                              f"LEGAL_SERVED=APPROVED_SNAPSHOT {match['sha']} commit={match['commit']}", _level_line(match["level"]), pend,
                              f"::notice title=LEGAL_SERVED::APPROVED_SNAPSHOT {match['sha'][:12]}; pendente: {', '.join(pending[:15])}",
                              "LEGAL_PUBLISH_GATE=PASS_APPROVED_SNAPSHOT"], "PASS_APPROVED_SNAPSHOT"
    texts_match = next((c for c in snaps if c["texts"] == texts), None)
    em = None if rehearsal else emergency_context()
    if em is not None:
        if em["problems"]:
            return False, lines + [pend, f"::error title=LEGAL_EMERGENCY::modo emergência recusado: {'; '.join(em['problems'])}"], "BLOCKED"
        if texts_match:
            return True, lines + [f"LEGAL_HEAD_FINGERPRINT={fp} (não aprovado)",
                                  f"LEGAL_SERVED=EMERGENCY_SNAPSHOT {texts_match['sha']} commit={texts_match['commit']}", _level_line(texts_match["level"]), pend,
                                  f"::warning title=LEGAL_EMERGENCY::deploy de emergência por {em['actor']}: arquivos jurídicos e textos de consumo servidos = snapshot aprovado {texts_match['sha'][:12]}; o código que serve as rotas NÃO está aprovado e, em tese, poderia alterar a resposta em tempo de execução (sobreposição auditada do proprietário). Motivo: {em['reason'][:300]}",
                                  "LEGAL_PUBLISH_GATE=PASS_EMERGENCY_SNAPSHOT"], "PASS_EMERGENCY_SNAPSHOT"
        return False, lines + [pend, "::error title=LEGAL_EMERGENCY::o modo emergência nunca troca texto jurídico: as páginas, os assets e os textos de consumo servidos têm de ser os de um snapshot aprovado"], "BLOCKED"
    if texts_match:
        why = ("LEGAL_SERVING_UNAPPROVED: os textos servidos são o snapshot aprovado, mas o código que serve as rotas jurídicas "
               "(sales-worker.mjs, worker/sales-public-worker.mjs, worker/politica-unica.mjs, wrangler.sales.toml) mudou sem aprovação. "
               "Só o deploy do Worker de vendas fica bloqueado; o central só confere os textos de consumo (--consumer-gate). Aprovação (profissional ou interna) ou modo emergência.")
    else:
        why = ("LEGAL_UNAPPROVED_TEXT_SERVED: o que iria ao ar não é um texto aprovado (aplique o snapshot com --apply-snapshot; "
               "textos de consumo de data/politica-unica.json alterados também exigem aprovação)")
    return False, lines + [pend] + [f"::error title=LEGAL_PUBLISH_GATE::{e}" for e in errs] + [f"::error title=LEGAL_PUBLISH_GATE::{why}"], "BLOCKED"


def publish_gate(root: Path, anchors_ref: str | None = None, rehearsal: bool = False) -> tuple[bool, list[str]]:
    content = Tree(root)
    fp = legal_fingerprint_src(content)
    lines = [f"LEGAL_FINGERPRINT={fp}"]
    blocked = "LEGAL_PUBLISH_GATE=BLOCKED (nada foi publicado; a produção segue com o texto anterior)"
    if not anchors_ref:
        return False, lines + ["::error title=LEGAL_PUBLISH_GATE::--anchors-ref ausente: as âncoras de confiança têm de vir do gh-pages mesclado", blocked]
    anchors = GitRef(root, anchors_ref)
    anchor_sha, head = anchors.commit(), anchors.commit("HEAD")
    lines.append(f"LEGAL_ANCHORS={anchors_ref}@{anchor_sha} DEPLOYED={head}")
    if not anchor_sha or not head or not anchors.is_ancestor(head):
        extra = []
        if rehearsal and anchor_sha:  # ensaio: o veredito que o portão daria, sempre seguido da recusa
            try:
                _, dl, verdict = _decide(root, content, fp, anchors, True)
                extra = [l.replace("LEGAL_", "LEGAL_REHEARSAL_", 1) if l.startswith("LEGAL_") else l.replace("::error title=", "::notice title=REHEARSAL_") for l in dl]
                extra += [f"LEGAL_REHEARSAL_VERDICT={verdict}", f"::notice title=LEGAL_REHEARSAL_VERDICT::{verdict}"]
            except (SystemExit, Exception) as e:
                extra = [f"LEGAL_REHEARSAL_VERDICT=UNAVAILABLE ({e})", f"::notice title=LEGAL_REHEARSAL_VERDICT::UNAVAILABLE ({e})"]
        return False, lines + extra + ["::error title=LEGAL_PUBLISH_GATE::o commit publicado não está contido no gh-pages das âncoras (ou o ref não existe)", blocked]
    ok, dl, _ = _decide(root, content, fp, anchors, False)
    return ok, lines + dl + ([] if ok else [blocked])


def consumer_fingerprint(src) -> str:
    """Rodada 12 (MED-3a): só os textos de consumo de data/politica-unica.json (regra dos 7 dias, reembolso, suporte),
    que o Worker central também serve."""
    pol = _loads(src.read(POLICY))
    if not isinstance(pol, dict):
        raise SystemExit(f"LEGAL_FINGERPRINT_SOURCE_MISSING {POLICY}")
    h = hashlib.sha256(b"zevanory-consumer-texts/v1\0")
    for k in POLICY_FIELDS:
        h.update(k.encode() + b"\0" + json.dumps(pol.get(k), ensure_ascii=False, sort_keys=True).encode() + b"\0")
    return h.hexdigest()


def _consumer_decide(root: Path, content, anchors, rehearsal: bool) -> tuple[bool, list[str], str]:
    cfp = consumer_fingerprint(content)
    lines = [f"LEGAL_CONSUMER_FINGERPRINT={cfp}"]
    pol = _loads(anchors.read(POLICY)) or {}
    fp = legal_fingerprint_src(content)
    base, _ = _baseline(anchors, content, rehearsal)
    if (fp == str(base.get("fingerprint", "")) and fp not in revoked_hashes(anchors)) or not validate_approval(pol.get("legal_review"), fp, anchors=anchors, content=content):
        return True, lines + ["LEGAL_CONSUMER_TEXTS=APPROVED_HEAD", "LEGAL_CONSUMER_GATE=PASS"], "PASS"
    snaps, serrs = approved_snapshots(anchors, content, rehearsal)
    match = next((c for c in snaps if consumer_fingerprint(c["src"]) == cfp), None)
    if match:
        return True, lines + [f"LEGAL_CONSUMER_TEXTS=APPROVED_SNAPSHOT {match['sha']} commit={match['commit']}", _level_line(match["level"]), "LEGAL_CONSUMER_GATE=PASS"], "PASS"
    ref = snaps[0]["src"] if snaps else anchors
    pa, pb = _loads(content.read(POLICY)) or {}, _loads(ref.read(POLICY)) or {}
    changed = [f"{POLICY}#{k}" for k in POLICY_FIELDS if pa.get(k) != pb.get(k)]
    return False, lines + [f"::error title=LEGAL_CONSUMER_GATE::{e}" for e in serrs] + [f"LEGAL_CONSUMER_PENDING={', '.join(changed) or '(?)'}",
            "::error title=LEGAL_CONSUMER_GATE::os textos de consumo de data/politica-unica.json que o Worker central serve mudaram sem aprovação "
            "(profissional ou interna); só por isso o deploy central fica bloqueado. Nada mais do central passa por este portão."], "BLOCKED"


def consumer_gate(root: Path, anchors_ref: str | None, rehearsal: bool = False) -> tuple[bool, list[str]]:
    """Portão mínimo do central (Sol ORDEM 312, MED-3a, opção mais segura): bloqueia SÓ se os textos de consumo mudaram
    sem aprovação. Mesmas âncoras e conferência de contenção do portão de vendas."""
    content = Tree(root)
    blocked = "LEGAL_CONSUMER_GATE=BLOCKED (nada foi publicado)"
    if not anchors_ref:
        return False, ["::error title=LEGAL_CONSUMER_GATE::--anchors-ref ausente", blocked]
    anchors = GitRef(root, anchors_ref)
    anchor_sha, head = anchors.commit(), anchors.commit("HEAD")
    lines = [f"LEGAL_ANCHORS={anchors_ref}@{anchor_sha} DEPLOYED={head}"]
    if not anchor_sha or not head or not anchors.is_ancestor(head):
        extra = []
        if rehearsal and anchor_sha:
            try:
                _, dl, verdict = _consumer_decide(root, content, anchors, True)
                extra = [l.replace("LEGAL_", "LEGAL_REHEARSAL_", 1) if l.startswith("LEGAL_") else l.replace("::error title=", "::notice title=REHEARSAL_") for l in dl]
                extra += [f"LEGAL_REHEARSAL_VERDICT={verdict}", f"::notice title=LEGAL_REHEARSAL_VERDICT::central consumer texts {verdict}"]
            except (SystemExit, Exception) as e:
                extra = [f"LEGAL_REHEARSAL_VERDICT=UNAVAILABLE ({e})"]
        return False, lines + extra + ["::error title=LEGAL_CONSUMER_GATE::o commit publicado não está contido no gh-pages das âncoras (ou o ref não existe)", blocked]
    ok, dl, _ = _consumer_decide(root, content, anchors, False)
    return ok, lines + dl + ([] if ok else [blocked])


def apply_snapshot(root: Path, serve_dir: Path, anchors_ref: str, rehearsal: bool = False) -> tuple[int, list[str]]:
    """Sol ORDEM 312, item 2: se o texto jurídico do commit não está aprovado, troca no diretório servido as páginas
    jurídicas e os assets delas pelos bytes do ÚLTIMO texto aprovado (reproduzidos do commit de origem). Nada mais
    muda; um asset compartilhado com bytes diferentes recusa (fail-closed)."""
    content = Overlay(root, serve_dir)
    anchors = GitRef(root, anchors_ref)
    fp = legal_fingerprint_src(content)
    lines = [f"LEGAL_FINGERPRINT={fp}"]
    base, _ = _baseline(anchors, content, rehearsal)
    pol = _loads(anchors.read(POLICY)) or {}
    if fp == str(base.get("fingerprint", "")) or not validate_approval(pol.get("legal_review"), fp, anchors=anchors, content=content):
        return 0, lines + ["LEGAL_SNAPSHOT=NOT_NEEDED (o texto do commit é o aprovado; vai ao ar como está)"]
    snaps, errs = approved_snapshots(anchors, content, rehearsal)
    if not snaps:
        return 1, lines + [f"::error title=LEGAL_SNAPSHOT::{e}" for e in errs] + ["::error title=LEGAL_SNAPSHOT::nenhum texto aprovado reproduzível para servir"]
    lines += [f"::warning title=LEGAL_SNAPSHOT::{e} (ignorado)" for e in errs]
    last = snaps[0]
    files = [(r, d) for r, d in legal_artifact_files(last["src"], sources=False) if r.startswith(ARTIFACT_DIR + "/")]
    pages = {f"{ARTIFACT_DIR}/{n}.html" for n in SERVED_LEGAL}
    conflicts = [r for r, d in files if r not in pages and content.read_bytes(r) not in (None, d)]
    if conflicts:
        return 1, lines + [f"::error title=LEGAL_SNAPSHOT::asset compartilhado com bytes diferentes do snapshot (não sobrescrito): {', '.join(conflicts[:10])}"]
    for r, d in files:
        t = serve_dir / r[len(ARTIFACT_DIR) + 1:]
        t.parent.mkdir(parents=True, exist_ok=True)
        t.write_bytes(d)
    pending = _pending(root, last["src"])
    return 0, lines + [f"LEGAL_SNAPSHOT_APPLIED={last['sha']} commit={last['commit']} arquivos={len(files)}", _level_line(last["level"]),
                       f"LEGAL_PENDING={', '.join(pending) if pending else '(nenhum)'}",
                       f"::notice title=LEGAL_SNAPSHOT::texto jurídico do commit não aprovado; servido o snapshot aprovado {last['sha'][:12]}"]


def main(argv=None) -> int:
    # -I ignora PYTHONIOENCODING: no Windows o console é cp1252 e a mensagem com acento sairia ilegível.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=".")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--fingerprint", action="store_true")
    g.add_argument("--publish-gate", action="store_true")
    g.add_argument("--check-approval", action="store_true")
    g.add_argument("--artifact-files", action="store_true", help="lista os arquivos que entram na impressão digital")
    g.add_argument("--consumer-gate", action="store_true", help="portão mínimo do central: só os textos de consumo de data/politica-unica.json")
    g.add_argument("--apply-snapshot", metavar="DIR", help="diretório servido (sales-public do artefato): troca o texto jurídico não aprovado pelo último snapshot aprovado")
    ap.add_argument("--anchors-ref", default=None, help="ref do gh-pages mesclado de onde vêm as âncoras (obrigatório com --publish-gate)")
    ap.add_argument("--rehearsal", action="store_true", help="só no ensaio (dry-run): imprime o veredito da impressão digital mesmo quando o commit não está no gh-pages; o resultado continua recusado")
    a = ap.parse_args(argv)
    root = Path(a.root).resolve()
    if a.artifact_files:
        for rel, data in legal_artifact_files(Tree(root)):
            print(rel)
        return 0
    if a.fingerprint:
        print(legal_fingerprint(root))
        return 0
    if a.check_approval:
        pol = json.loads((root / "data/politica-unica.json").read_text(encoding="utf-8"))
        errs = validate_approval(pol.get("legal_review"), legal_fingerprint(root), root=root)
        for e in errs:
            print("::error title=LEGAL_REVIEW::" + e)
        print("LEGAL_REVIEW=" + ("FAIL" if errs else "PASS"))
        return 1 if errs else 0
    if a.consumer_gate:
        ok, lines = consumer_gate(root, a.anchors_ref, rehearsal=a.rehearsal)
        print("\n".join(lines))
        return 0 if ok else 1
    if a.apply_snapshot:
        if not a.anchors_ref:
            print("::error title=LEGAL_SNAPSHOT::--anchors-ref obrigatório")
            return 1
        rc, lines = apply_snapshot(root, Path(a.apply_snapshot).resolve(), a.anchors_ref, rehearsal=a.rehearsal)
        print("\n".join(lines))
        return rc
    ok, lines = publish_gate(root, a.anchors_ref, rehearsal=a.rehearsal)
    print("\n".join(lines))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
