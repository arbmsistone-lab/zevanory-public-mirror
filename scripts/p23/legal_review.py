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
Sem rede, sem segredos; só lê arquivos e o histórico do git local.
Uso: legal_review.py --root . --fingerprint | --publish-gate --anchors-ref <ref> | --check-approval
"""
from __future__ import annotations

import argparse, datetime as dt, hashlib, html, json, re, subprocess, sys
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
GENESIS_BASELINE = "46675c70c28a34ac1a30051a645dbf258d6aa7905c539df9c2bb3807acef9f68"
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


def legal_artifact_files(src) -> list[tuple[str, bytes]]:
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
    for rel in LEGAL_PAGES:
        if not rel.startswith(ARTIFACT_DIR + "/"):
            data = src.read_bytes(rel)
            if data is None:
                raise SystemExit(f"LEGAL_FINGERPRINT_SOURCE_MISSING {rel}")
            out[rel] = data
    return sorted(out.items())


def legal_fingerprint_src(src) -> str:
    h = hashlib.sha256()
    for rel, data in legal_artifact_files(src):
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
    if review.get("status") != "APPROVED":
        errs.append("REVISÃO JURÍDICA PENDENTE; legal_review exige status APPROVED, approved_by, approved_at, reviewed_sha256 e reviewed_commit")
        return errs
    who = review.get("approved_by")
    who = who.strip() if isinstance(who, str) else ""
    if not who or not NAME.fullmatch(who) or FIXTURE.search(who):
        errs.append(f"legal_review.approved_by {review.get('approved_by')!r} não identifica uma pessoa (nome e sobrenome, opcional ', OAB/UF número'; sem marcador de teste ou papel genérico)")
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
        if (entry.get("name") != who or entry.get("authorized_by") != "proprietario" or auth_day is None
                or not re.fullmatch(r"[0-9a-f]{40}", str(entry.get("authorization_commit", "")))
                or not re.fullmatch(r"OAB/[A-Z]{2} ?\d{3,7}", str(entry.get("registro", "")))
                or not re.fullmatch(r"[A-Za-z0-9-]{1,39}", str(entry.get("github_login", "")))):
            errs.append(f"legal_review.reviewer_id {review.get('reviewer_id')!r}: cadastro incompleto ou nome diferente de approved_by (exige name, registro OAB, github_login, authorized_by=proprietario, authorized_at e authorization_commit)")
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
        if rec.get("decision") != "APPROVED":
            errs.append(f"registro {rec_path}: decision deve ser APPROVED")
        ac = entry.get("authorization_commit") if isinstance(entry, dict) else None
        if git is not None and isinstance(ac, str) and re.fullmatch(r"[0-9a-f]{40}", ac):
            # O registro entra no gh-pages DEPOIS do commit que cadastrou o revisor, nunca no mesmo commit: cadastro
            # e aprovação não nascem juntos (squash: um PR cada; rebase: commits distintos, ainda sob o check protegido).
            rc, out = git.run("log", "--format=%H", "--diff-filter=A", git.ref, "--", rec_path)
            added = out.split()[-1] if rc == 0 and out.split() else None
            if not added or added == ac or not git.is_ancestor(ac, added):
                errs.append(f"registro {rec_path}: tem de entrar no gh-pages num commit posterior ao authorization_commit {ac[:12]}")
    return errs


def approved_hashes(anchors, content) -> set[str]:
    """reviewed_sha256 de cada registro de aprovação válido nas âncoras (cada registro validado como aprovação)."""
    out = set()
    for name in anchors.names(RECORDS):
        rec = _loads(anchors.read(f"{RECORDS}/{name}"))
        if not isinstance(rec, dict) or name != f"{rec.get('reviewed_sha256')}.json":
            continue
        reg = _loads(anchors.read(REVIEWERS)) or {}
        entry = next((r for r in (reg.get("reviewers") or []) if isinstance(r, dict) and r.get("id") == rec.get("reviewer_id")), {})
        review = {"status": "APPROVED", "approved_by": entry.get("name"), "record": f"{RECORDS}/{name}", **rec}
        version_src = anchors.at(rec["reviewed_commit"]) if getattr(anchors, "git", None) and anchors.is_ancestor(str(rec.get("reviewed_commit"))) else content
        if not validate_approval(review, rec.get("reviewed_sha256"), anchors=anchors, content=version_src):
            out.add(rec["reviewed_sha256"])
    return out


def publish_gate(root: Path, anchors_ref: str | None = None) -> tuple[bool, list[str]]:
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
        return False, lines + ["::error title=LEGAL_PUBLISH_GATE::o commit publicado não está contido no gh-pages das âncoras (ou o ref não existe)", blocked]
    base = _loads(anchors.read(BASELINE)) or {}
    baseline = str(base.get("fingerprint", ""))
    lines.append(f"LEGAL_PUBLISHED_BASELINE={baseline} source_commit={base.get('source_commit')}")
    approved = approved_hashes(anchors, content)
    if baseline != GENESIS_BASELINE and baseline not in approved:
        return False, lines + ["::error title=LEGAL_PUBLISH_GATE::linha de base não é o texto pré-Release 2 nem o hash de um registro de aprovação válido no gh-pages", blocked]
    if fp == baseline:
        return True, lines + ["LEGAL_PUBLISH_GATE=PASS_UNCHANGED (texto jurídico idêntico ao já publicado; revisão não exigida para este deploy)"]
    pol = _loads(anchors.read(POLICY)) or {}
    errs = validate_approval(pol.get("legal_review"), fp, anchors=anchors, content=content)
    if errs:
        return False, lines + [f"::error title=LEGAL_PUBLISH_GATE::{e}" for e in errs] + [blocked]
    return True, lines + ["LEGAL_PUBLISH_GATE=PASS_APPROVED"]


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
    ap.add_argument("--anchors-ref", default=None, help="ref do gh-pages mesclado de onde vêm as âncoras (obrigatório com --publish-gate)")
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
    ok, lines = publish_gate(root, a.anchors_ref)
    print("\n".join(lines))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
