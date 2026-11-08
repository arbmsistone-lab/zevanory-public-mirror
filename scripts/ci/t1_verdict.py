#!/usr/bin/env python3
"""Veredito estrito T1_EXCLUSIVITY (roteiro seção 15, condições 1-7, l.1645-1652) e itens VC-H do P17 (l.1217,
l.579, controle 13), ligado à evidência que existe NESTE SHA.

Regras (condição 7):
  - cada condição vira uma lista de verificações; a condição só é PROVEN se TODAS forem PROVEN;
  - T1_EXCLUSIVITY = PROVEN só se as sete forem PROVEN; P17_VCH = PROVEN só se todos os itens forem PROVEN;
  - evidência ausente, ilegível, desconhecida ou que dependa do proprietário (painel da Cloudflare, tokens
    efetivos, autorização escrita, ensaio de rollback executado) = NOT_PROVEN com o motivo e a ação;
  - aviso nunca equivale a PASS; não existe estado intermediário;
  - cada evidência leva o caminho e o sha256 do conteúdo; o veredito leva o SHA do HEAD.
Sem rede, sem segredos, sem escrita: lê arquivos do repositório e, se existirem neste SHA, executa localmente o
detector ampliado (scripts/deploy/t1-write-scan.mjs --check) e os testes negativos (tests/t1-write-scan.test.mjs).

Declaração do proprietário (opcional, ops/t1-owner-evidence.json): é TEXTO, não autenticação. Um item declarado
aparece como "declarado, não verificável offline" e continua NOT_PROVEN; ele só indica qual run/registro um
auditor deve conferir.

Uso: python3 scripts/ci/t1_verdict.py [--root DIR] [--json | --markdown] [--strict]
Exit: 0 (veredito emitido, qualquer resultado); 1 com --strict e algo NOT_PROVEN; 2 erro de execução.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

PROVEN, NOT_PROVEN = "PROVEN", "NOT_PROVEN"
SHARED_TOKENS = ("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_PUBLIC_OWNER_API_TOKEN")
# Workers e rotas que servem a venda (VC-H, l.1217): vitrine/checkout, páginas de venda, roteador.
SALES_SERVICES = ("zevanory", "zevanory-sales-public", "zevanory-public-router")
NAMED_ROUTES = ("mercadopago-exact-sha-recovery.yml", "mercadopago-production-token-rotate.yml",
                "financial-e2e-stripe.yml", "public-router-deploy.yml")
# Padrões do detector anterior (tests/publisher-inventory.test.mjs), usados só quando o inventário ampliado não existe.
OLD_PUBLISH = [
    re.compile(r"npx(?: --yes)? wrangler(?:@[\d.]+)? (?:deploy|rollback|versions deploy)\b(?![^\n]*--dry-run)"),
    re.compile(r"npx(?: --yes)? wrangler(?:@[\d.]+)? secret (?:put|delete|bulk)\b"),
    re.compile(r"-X (?:POST|PUT|PATCH|DELETE)\b[^\n]*workers/scripts|workers/scripts[^\n]*-X (?:POST|PUT|PATCH|DELETE)\b"),
    re.compile(r"node [^\n]*cloudflare-authoritative-repair\.mjs"),
    re.compile(r"worker_secret_rotate\.py[^\n]*--apply"),
]
# Guard reconhecido no modo sem inventário ampliado: promotion_guard ou o escritor de segredos marcado (T3).
GUARD = re.compile(r"promotion_guard\.py --service |worker_secret_rotate\.py[^\n]*--apply")
SELF_FILES = ("scripts/ci/t1_verdict.py", "tests/test_t1_verdict.py", ".github/workflows/t1-exclusivity-verdict.yml")


class Repo:
    def __init__(self, root: Path):
        self.root = root

    def path(self, rel: str) -> Path:
        return self.root / rel

    def exists(self, rel: str) -> bool:
        return self.path(rel).is_file()

    def text(self, rel: str) -> str | None:
        try:
            return self.path(rel).read_text(encoding="utf-8").replace("\r\n", "\n")
        except (OSError, UnicodeDecodeError):
            return None

    def evidence(self, rel: str) -> dict:
        try:
            return {"path": rel, "sha256": hashlib.sha256(self.path(rel).read_bytes()).hexdigest()}
        except OSError:
            return {"path": rel, "sha256": None}

    def json(self, rel: str):
        t = self.text(rel)
        if t is None:
            return None
        try:
            return json.loads(t)
        except ValueError:
            return None

    def head(self) -> str | None:
        git = shutil.which("git")
        if not git:
            return None
        try:
            p = subprocess.run([git, "-C", str(self.root), "rev-parse", "HEAD"], capture_output=True, text=True, timeout=20)
        except (OSError, subprocess.TimeoutExpired):
            return None
        sha = p.stdout.strip()
        return sha if p.returncode == 0 and re.fullmatch(r"[0-9a-f]{40}", sha) else None

    def workflows(self) -> list[str]:
        d = self.path(".github/workflows")
        return sorted(p.name for p in d.glob("*.y*ml")) if d.is_dir() else []

    def node(self, args: list[str], timeout: int = 300):
        node = shutil.which("node")
        if not node:
            return None
        try:
            return subprocess.run([node, *args], cwd=self.root, capture_output=True, text=True, timeout=timeout)
        except (OSError, subprocess.TimeoutExpired):
            return None


def check(cid, status, what, evidence=(), reason="", owner_action=""):
    out = {"id": cid, "status": status, "what": what, "evidence": list(evidence)}
    if status != PROVEN:
        out["reason"] = reason or "sem evidência neste SHA"
        if owner_action:
            out["owner_action"] = owner_action
    return out


def owner_declared(repo: Repo, key: str) -> str:
    decl = repo.json("ops/t1-owner-evidence.json")
    item = decl.get(key) if isinstance(decl, dict) else None
    return f" Declarado em ops/t1-owner-evidence.json ({key}), não verificável offline." if item else ""


def registry_owner(reg: dict) -> dict:
    owner = {}
    for svc, s in (reg.get("services") or {}).items():
        for w in [s.get("canonical"), *(s.get("config_publishers") or []), *(s.get("pending_owner_authorization") or [])]:
            if w:
                owner[w] = svc
    for w in (reg.get("unserialized_known") or {}):
        owner.setdefault(w, "unserialized")
    return owner


def top_group(text: str) -> str | None:
    m = re.search(r"^concurrency:\s*\n\s+group:\s*(.+)$", text, re.M)
    return m.group(1).strip().strip("'\"") if m else None


def first_line(text: str, regexes) -> int | None:
    best = None
    for n, ln in enumerate(text.split("\n"), 1):
        if re.match(r"^\s*#", ln):
            continue
        if any(r.search(ln) for r in regexes):
            best = n
            break
    return best


def scanner(repo: Repo) -> dict:
    """Detector ampliado (PR #990) se existir neste SHA: --check e --json, localmente."""
    rel = "scripts/deploy/t1-write-scan.mjs"
    if not repo.exists(rel):
        return {"present": False}
    chk = repo.node([rel, "--check"])
    js = repo.node([rel, "--json"])
    scan = None
    if js is not None and js.returncode == 0:
        try:
            scan = json.loads(js.stdout)
        except ValueError:
            scan = None
    return {"present": True, "check_ok": bool(chk is not None and chk.returncode == 0),
            "check_out": (chk.stdout.strip().splitlines() or [""])[-1] if chk is not None else "node indisponível",
            "scan": scan, "evidence": [repo.evidence(rel), repo.evidence("ops/publishers.json")]}


def negative_tests(repo: Repo) -> dict:
    rel = "tests/t1-write-scan.test.mjs"
    if not repo.exists(rel):
        return {"present": False}
    text = repo.text(rel) or ""
    run = repo.node(["--test", rel])
    out = (run.stdout if run is not None else "") or ""
    ok = run is not None and run.returncode == 0 and re.search(r"^# fail 0$", out, re.M) is not None
    return {"present": True, "ok": ok, "text": text, "evidence": [repo.evidence(rel)]}


def p21_cutover_check(repo: Repo) -> dict:
    """4c (P21/R18): interruptor ops/token-cutover.json. PROVEN só com TODOS os serviços em cutover=true e o contrato
    estático (scripts/ci/p21_token_cutover.py check) aprovado neste SHA; cutover=false = token legado em uso."""
    rel, tool = "ops/token-cutover.json", "scripts/ci/p21_token_cutover.py"
    what = "token dedicado por serviço em uso (interruptor P21 com cutover=true em todos os serviços)"
    action = "criar cada token dedicado, cadastrar o segredo e virar o serviço para cutover=true por PR (docs/p21/tokens-por-worker.md)"
    cfg = repo.json(rel)
    ev = [repo.evidence(rel), repo.evidence(tool)]
    if not isinstance(cfg, dict) or not isinstance(cfg.get("services"), dict) or not cfg["services"]:
        return check("4c", NOT_PROVEN, what, ev, "interruptor ops/token-cutover.json ausente ou ilegível neste SHA", action)
    false = sorted(n for n, s in cfg["services"].items() if not (isinstance(s, dict) and s.get("cutover") is True))
    ok, out = False, "ferramenta ausente"
    py = shutil.which("python3") or sys.executable
    if repo.exists(tool) and py:
        try:
            p = subprocess.run([py, str(repo.path(tool)), "check", "--root", str(repo.root)], capture_output=True, text=True, timeout=120)
            ok, out = p.returncode == 0, ((p.stdout.strip().splitlines() or [""])[-1])
        except (OSError, subprocess.TimeoutExpired) as e:
            out = type(e).__name__
    if false or not ok:
        why = []
        if false:
            why.append(f"{len(false)} serviço(s) com cutover=false (token legado da conta inteira em uso): {', '.join(false)}")
        if not ok:
            why.append(f"contrato estático do interruptor reprovado: {out}")
        return check("4c", NOT_PROVEN, what, ev, "; ".join(why), action)
    return check("4c", PROVEN, what + f": {len(cfg['services'])} serviço(s), contrato aprovado ({out})", ev)


def evaluate(root: Path) -> dict:
    repo = Repo(root)
    reg = repo.json("ops/publishers.json") or {}
    owner = registry_owner(reg)
    services = reg.get("services") or {}
    wp = reg.get("write_paths") if isinstance(reg.get("write_paths"), dict) else None
    sc = scanner(repo)
    neg = negative_tests(repo)
    wfs = repo.workflows()
    texts = {w: repo.text(f".github/workflows/{w}") or "" for w in wfs}
    reg_ev = repo.evidence("ops/publishers.json")
    conds = {}

    # 1. Inventário exaustivo.
    c1 = []
    if not sc["present"]:
        c1.append(check("1a", NOT_PROVEN, "inventário exaustivo no repositório (todas as classes de escrita)", [reg_ev],
                        "detector ampliado ausente neste SHA: o detector atual só vê `npx wrangler deploy|rollback|versions deploy|secret` e "
                        "`-X ... workers/scripts` na mesma linha (não vê versions secret, kv, d1, rotas, curl quebrado, heredoc nem scripts chamados)",
                        "revisar e mesclar o PR do detector ampliado (#990)"))
    elif not (sc["check_ok"] and wp):
        c1.append(check("1a", NOT_PROVEN, "inventário exaustivo no repositório", sc["evidence"], f"t1-write-scan --check: {sc['check_out']}"))
    else:
        n = len((sc["scan"] or {}).get("workflows", {})) + len((sc["scan"] or {}).get("scripts", {}))
        c1.append(check("1a", PROVEN, f"inventário exaustivo no repositório: {n} caminhos detectados, todos registrados", sc["evidence"]))
    c1.append(check("1b", NOT_PROVEN, "caminhos fora do repositório (Workers Builds, painel, operações manuais no painel)", [],
                    "não legível por análise estática do repositório." + owner_declared(repo, "workers_builds"),
                    "no painel da Cloudflare: listar Workers Builds conectados a cada Worker de produção e desconectá-los (ou registrá-los como reserva sob autoridade); exportar o inventário de tokens"))
    conds["1"] = c1

    # 2. Cobertura expressa das rotas nomeadas.
    c2 = []
    for w in NAMED_ROUTES:
        t = texts.get(w)
        svc = owner.get(w)
        if t is None or not t:
            c2.append(check(f"2:{w}", NOT_PROVEN, f"{w} coberto", [], "workflow ausente neste SHA"))
            continue
        ev = [repo.evidence(f".github/workflows/{w}"), reg_ev]
        if svc in (None, "unserialized"):
            c2.append(check(f"2:{w}", NOT_PROVEN, f"{w} coberto", ev, "fora do registro de serviços"))
            continue
        pending = w in (services.get(svc, {}).get("pending_owner_authorization") or [])
        grp_ok = top_group(t) == services.get(svc, {}).get("group") or bool(services.get(svc, {}).get("t1_unchanged"))
        if pending:
            c2.append(check(f"2:{w}", NOT_PROVEN, f"{w} coberto", ev, f"registrado em {svc} como pending_owner_authorization: fora do grupo do serviço e sem guard (fluxo financeiro)",
                            f"autorização escrita do proprietário para pôr {w} no grupo {services[svc].get('group')} e sob o guard"))
        elif not grp_ok:
            c2.append(check(f"2:{w}", NOT_PROVEN, f"{w} coberto", ev, f"fora do grupo {services[svc].get('group')}"))
        else:
            c2.append(check(f"2:{w}", PROVEN, f"{w} registrado no serviço {svc} e no grupo {services[svc].get('group')}", ev))
    c2.append(check("2:workers-builds", NOT_PROVEN, "Workers Builds de reserva cobertos", [], "fora do repositório." + owner_declared(repo, "workers_builds"),
                    "desconectar Workers Builds ou registrá-los como rota de reserva com autoridade verificável"))
    conds["2"] = c2

    # 3. Guard antes de qualquer escrita, em toda rota publicadora.
    c3 = []
    if wp:
        prod = {k: v for k, v in (wp.get("workflows") or {}).items() if v.get("scope") in ("production", "isolated")}
        gaps = sorted(k for k, v in prod.items() if v.get("t1") != "guarded")
        ok = sc.get("check_ok") and not gaps
        c3.append(check("3a", PROVEN if ok else NOT_PROVEN, f"guard antes da escrita nas {len(prod)} rotas com credencial",
                        sc.get("evidence", [reg_ev]),
                        f"{len(gaps)} rota(s) sem guard T1 antes da escrita (t1=gap): " + ", ".join(gaps[:40]) + ("" if sc.get("check_ok") else "; detector --check falhou"),
                        "aprovar a extensão do guard (promotion_guard / worker_secret_rotate / lista fechada de KV) a cada rota; fluxos financeiros só com autorização escrita"))
    else:
        missing = []
        for w, t in texts.items():
            if w not in owner or not t:
                continue
            first = first_line(t, OLD_PUBLISH)
            g = first_line(t, [GUARD])
            if first is not None and (g is None or g > first):
                missing.append(w)
        c3.append(check("3a", NOT_PROVEN, "guard antes da escrita em toda rota publicadora", [reg_ev],
                        f"inventário ampliado ausente; pelo detector anterior, {len(missing)} publicador(es) registrado(s) escrevem sem promotion_guard antes: " + ", ".join(sorted(missing)),
                        "mesclar o detector ampliado (#990) e estender o guard"))
    conds["3"] = c3

    # 4. Privilégios efetivos de todo token capaz de escrever.
    users = sorted(w for w, t in texts.items() if any(f"secrets.{s}" in t for s in SHARED_TOKENS))
    writers = set(owner) | set((wp or {}).get("workflows", {}).keys())
    shared_writers = sorted(w for w in users if w in writers)
    c4 = [check("4a", NOT_PROVEN, "nenhuma rota de escrita usa o token compartilhado da conta", [reg_ev],
                f"{len(shared_writers)} workflow(s) de escrita usam {'/'.join(SHARED_TOKENS)} (alcance da conta inteira)",
                "criar um token por Worker (Account API token, Specified Workers, Editor), trocar cada publicador para o seu token e revogar os compartilhados"),
          check("4b", NOT_PROVEN, "permissões efetivas lidas de cada token de escrita", [repo.evidence(".github/workflows/t1-publisher-guard.yml")],
                "a leitura das políticas (job credential-scope) exige credencial e rede; não é verificável por este veredito offline." + owner_declared(repo, "token_scope"),
                "rodar credential-scope em gh-pages e anexar o run com EDIT_PROVEN/SCOPE_READY de cada token; incluir os tokens de sonda")]
    c4.append(p21_cutover_check(repo))
    conds["4"] = c4

    # 5. Testes negativos em CI.
    sub = {"5a": ("sem guard faz o gate falhar", ["[WS6.3]", "[WS6.2]"]),
           "5b": ("workflow publicador não registrado faz o gate falhar", ["[WS6.1]"]),
           "5d": ("troca de alvo de produção faz o gate falhar", ["[WS6.4]"])}
    wired = any("node --test tests/t1-write-scan.test.mjs" in t and re.search(r"^\s+pull_request", t, re.M) for t in texts.values())
    c5 = []
    for cid, (what, markers) in sub.items():
        if not neg["present"]:
            c5.append(check(cid, NOT_PROVEN, what, [], "testes negativos ausentes neste SHA", "mesclar #990"))
        elif not all(m in neg["text"] for m in markers) or not neg["ok"] or not wired:
            c5.append(check(cid, NOT_PROVEN, what, neg["evidence"], f"marcadores {markers} ausentes, teste falhou localmente ou não roda em pull_request"))
        else:
            c5.append(check(cid, PROVEN, what + f" ({', '.join(markers)}, executado agora: # fail 0)", neg["evidence"]))
    c5.insert(2, check("5c", NOT_PROVEN, "token excessivo faz o gate falhar", neg.get("evidence", []),
                       "o gate recusa token por Worker usado por outro serviço (WS6.5), mas ainda ACEITA o token compartilhado da conta em todo publicador (estado atual, registrado como lacuna)",
                       "depois dos tokens por Worker: tornar falha o uso de CLOUDFLARE_API_TOKEN/CLOUDFLARE_PUBLIC_OWNER_API_TOKEN em rota de escrita"))
    conds["5"] = c5

    # 6. Reserva e recuperação sob autoridade verificável.
    c6 = []
    rec = "mercadopago-exact-sha-recovery.yml"
    pend = rec in (services.get("zevanory", {}).get("pending_owner_authorization") or [])
    c6.append(check("6a", NOT_PROVEN if pend or rec not in texts else PROVEN, f"rota de recuperação {rec} sob a autoridade do guard",
                    [repo.evidence(f".github/workflows/{rec}"), reg_ev], "pending_owner_authorization: recuperação fora do grupo e sem guard",
                    "autorização escrita para serializar e pôr a recuperação sob o guard (controlar, não destruir)"))
    rb = services.get("zevanory-product-control-portable", {}).get("exceptions", {}).get("rollback")
    central = texts.get("central-production-deploy.yml", "")
    c6.append(check("6b", PROVEN if rb and "rollback --name zevanory" in central else NOT_PROVEN, "caminhos de rollback documentados nos publicadores canônicos",
                    [reg_ev, repo.evidence(".github/workflows/central-production-deploy.yml")], "rollback documentado ausente"))
    c6.append(check("6c", NOT_PROVEN, "rollback da esteira oficial ensaiado (execução real registrada)", [],
                    "nenhum registro de ensaio executado neste SHA." + owner_declared(repo, "rollback_rehearsal"),
                    "agendar e executar o ensaio de rollback (central e vendas) e anexar o run e o readback"))
    conds["6"] = c6

    # 7. Veredito estrito ligado à evidência e ao SHA (este mecanismo).
    head = repo.head()
    vw = texts.get("t1-exclusivity-verdict.yml", "")
    vw_ok = bool(vw) and re.search(r"^\s+pull_request", vw, re.M) and re.search(r"^permissions:\s*\n\s+contents: read\s*$", vw, re.M) and "secrets." not in vw
    present = all(repo.exists(f) for f in SELF_FILES)
    c7 = [check("7a", PROVEN if head and present and vw_ok else NOT_PROVEN, "veredito por SHA, sem estado intermediário, rodando em pull_request somente leitura",
                [repo.evidence(f) for f in SELF_FILES], ("SHA do HEAD ilegível; " if not head else "") + ("arquivos do veredito ausentes; " if not present else "") + ("workflow do veredito ausente, sem pull_request, com permissão além de contents: read ou com segredo" if not vw_ok else ""))]
    conds["7"] = c7

    # P17 VC-H (l.1217, l.579, controle 13).
    sales = texts.get("zevanory-sales-public-release.yml", "")
    def guarded_before(t, svc):
        f = first_line(t, [re.compile(r"npx(?: --yes)? wrangler(?:@[\d.]+)? deploy\b(?![^\n]*--dry-run)[^\n]*--config wrangler\.(?:sales\.deploy|central-fix)")])
        g = first_line(t, [re.compile(rf"promotion_guard\.py --service {re.escape(svc)}\b")])
        return f is not None and g is not None and g < f
    vch = [
        check("V1", PROVEN if guarded_before(central, "zevanory") and guarded_before(sales, "zevanory-sales-public") else NOT_PROVEN,
              "esteira oficial com guard antes do deploy (zevanory, zevanory-sales-public)",
              [repo.evidence(".github/workflows/central-production-deploy.yml"), repo.evidence(".github/workflows/zevanory-sales-public-release.yml")],
              "promotion_guard ausente ou depois do deploy canônico"),
        check("V2", PROVEN if "--verify-promoted" in central and "--verify-promoted" in sales else NOT_PROVEN, "readback R7 pós-promoção (tag Cloudflare + endpoint público)",
              [repo.evidence(".github/workflows/central-production-deploy.yml"), repo.evidence(".github/workflows/zevanory-sales-public-release.yml")], "--verify-promoted ausente"),
        check("V3", PROVEN if any(re.search(r"wrangler(?:@[\d.]+)? deploy --dry-run --strict", t) for t in texts.values()) and repo.exists("scripts/audit/sales-visual-gate.mjs") else NOT_PROVEN,
              "dry-run estrito (#826) e gate visual (#828) presentes", [repo.evidence("scripts/audit/sales-visual-gate.mjs")], "dry-run estrito ou gate visual ausente"),
        check("V4", PROVEN if repo.exists("tests/publisher-inventory.test.mjs") and "node --test tests/publisher-inventory.test.mjs" in texts.get("t1-publisher-guard.yml", "") else NOT_PROVEN,
              "um publicador canônico por serviço (teste em CI)", [repo.evidence("tests/publisher-inventory.test.mjs")], "teste do registro ausente ou fora do CI"),
        check("V5", NOT_PROVEN, "rollback da esteira oficial ensaiado ao menos uma vez antes da abertura (controle 13; l.579 trimestral)", [],
              "sem registro de ensaio." + owner_declared(repo, "rollback_rehearsal"), "executar e registrar o ensaio de rollback (run + readback antes/depois)"),
    ]
    sales_gaps = []
    if wp:
        for k, v in (wp.get("workflows") or {}).items():
            if v.get("scope") == "production" and v.get("t1") != "guarded" and (v.get("service") in SALES_SERVICES or str(v.get("service", "")).startswith("kv:sales")):
                sales_gaps.append(k)
    vch.append(check("V6", NOT_PROVEN, "nenhuma rota publicadora não controlada alcança os Workers da venda",
                     sc.get("evidence", [reg_ev]),
                     ("inventário ampliado ausente; " if not wp else f"{len(sales_gaps)} rota(s) sem guard T1 que escrevem nos Workers/chaves da venda: {', '.join(sorted(sales_gaps))}; ")
                     + "token compartilhado alcança todos os Workers da conta (condição 4)",
                     "tokens por Worker para zevanory, zevanory-sales-public e zevanory-public-router; guard nas rotas listadas; revisor no environment gh-pages-automacao"))

    def roll(checks):
        return PROVEN if checks and all(c["status"] == PROVEN for c in checks) else NOT_PROVEN

    cond_status = {k: roll(v) for k, v in conds.items()}
    return {
        "schema": "t1-verdict/v1",
        "sha": head,
        "T1_EXCLUSIVITY": PROVEN if head and all(s == PROVEN for s in cond_status.values()) and len(cond_status) == 7 else NOT_PROVEN,
        "conditions": {k: {"status": cond_status[k], "checks": v} for k, v in conds.items()},
        "P17_VCH": roll(vch),
        "p17_vch": vch,
    }


TITLES = {"1": "Inventário exaustivo", "2": "Cobertura expressa das rotas nomeadas", "3": "Guard antes de qualquer escrita",
          "4": "Privilégios efetivos dos tokens", "5": "Testes negativos em CI", "6": "Reserva e recuperação sob autoridade",
          "7": "Veredito estrito por SHA"}


def markdown(v: dict) -> str:
    out = [f"## T1_EXCLUSIVITY = **{v['T1_EXCLUSIVITY']}**  ·  P17 VC-H = **{v['P17_VCH']}**", "",
           f"SHA: `{v['sha'] or 'ILEGÍVEL'}` — veredito offline (sem rede, sem segredo). Qualquer item sem prova = NOT_PROVEN.", "",
           "| Condição | Verificação | Estado | Motivo / ação do proprietário |", "|---|---|---|---|"]
    def row(label, c):
        why = c.get("reason", "")
        if c.get("owner_action"):
            why += f" **Ação:** {c['owner_action']}"
        return f"| {label} | {c['what']} | {c['status']} | {why.replace('|', '/')} |"
    for k, cond in v["conditions"].items():
        for c in cond["checks"]:
            out.append(row(f"{k}. {TITLES[k]} ({cond['status']})", c))
    out += ["", "| P17 VC-H | Verificação | Estado | Motivo / ação |", "|---|---|---|---|"]
    for c in v["p17_vch"]:
        out.append(row(c["id"], c))
    return "\n".join(out) + "\n"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=str(Path(__file__).resolve().parents[2]))
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--markdown", action="store_true")
    ap.add_argument("--strict", action="store_true")
    a = ap.parse_args(argv)
    try:
        v = evaluate(Path(a.root))
    except Exception as e:  # noqa: BLE001 - erro de execução nunca vira veredito
        print(f"::error title=T1_VERDICT_ERROR::{type(e).__name__}: {e}")
        return 2
    if a.json:
        print(json.dumps(v, indent=1, ensure_ascii=False))
    if a.markdown:
        print(markdown(v))
    # Com --json a linha-resumo vai para stderr, para o stdout continuar JSON válido.
    print(f"T1_EXCLUSIVITY={v['T1_EXCLUSIVITY']} P17_VCH={v['P17_VCH']} sha={v['sha']} "
          + " ".join(f"C{k}={c['status']}" for k, c in v["conditions"].items()), file=sys.stderr if a.json else sys.stdout)
    return 1 if a.strict and (v["T1_EXCLUSIVITY"] != PROVEN or v["P17_VCH"] != PROVEN) else 0


if __name__ == "__main__":
    sys.exit(main())
