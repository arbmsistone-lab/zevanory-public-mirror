#!/usr/bin/env python3
"""ZEVANORY | Texto público sem jargão interno e sem erros conhecidos (auditoria do site, 2026-10-25).

A auditoria adversarial do site (S-01, Crítica; S-06, S-07, S-08; contra-auditada pelo Sol nas Ordens
256/261) achou, em páginas públicas e indexáveis do site de vendas, vocabulário interno de engenharia e
de governança ("FAIL_CLOSED", "UNCONFIGURED", "tenant", "SHA", "kill-switch", "ZEES-16", "gate global",
"Autonomous Sales Platform"...), alegações sem certificador ("Oferta certificada") e dois erros
repetidos ("7 dias corridos contado", "Açaíteria").

Este gate falha se QUALQUER texto público gerado voltar a ter um desses termos ou erros. Fonte: o site
de vendas gerado (sales-public/*.html e sales-public/llms.txt), em tudo o que o cliente ou o buscador
lê: texto visível, <title>, meta description/og/twitter, alt/aria-label/title/placeholder e os textos
do JSON-LD (FAQ e descrições aparecem nos resultados de busca). Scripts, estilos e URLs não contam.

Uso:  python3 scripts/ci/public_copy_gate.py              (verifica sales-public/)
      python3 scripts/ci/public_copy_gate.py --self-test  (prova que cada termo proibido reprova)
"""
from __future__ import annotations

import html as htmllib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "sales-public"

# (rótulo, regex). Rótulo = o que o relatório mostra; a regex roda sobre o texto público.
BANNED = [
    # Vocabulário interno de engenharia/governança (S-01).
    ("FAIL_CLOSED / fail-closed", re.compile(r"fail[_\s-]?closed", re.I)),
    ("UNCONFIGURED", re.compile(r"\bUNCONFIGURED\b")),
    ("READY (estado interno)", re.compile(r"\bREADY\b")),
    ("tenant", re.compile(r"\btenants?\b", re.I)),
    ("SHA", re.compile(r"\bSHA(?:-?\d+)?\b")),
    ("kill-switch", re.compile(r"\bkill[\s-]?switch", re.I)),
    ("ZEES-16", re.compile(r"\bZEES\b", re.I)),
    ("gate(s)", re.compile(r"\bgates?\b", re.I)),
    ("HTML semântico", re.compile(r"HTML sem[aâ]ntico", re.I)),
    ("zero dependência de JS", re.compile(r"depend[eê]ncia de JS", re.I)),
    ("Performance primeiro", re.compile(r"Performance primeiro", re.I)),
    ("Autonomous / Autopilot / Assist", re.compile(r"\b(?:Autonomous|Autopilot|Assist)\b", re.I)),
    ("Sales Platform", re.compile(r"Sales Platform", re.I)),
    ("deliberadamente bloqueada", re.compile(r"deliberadamente bloquead", re.I)),
    ("disponibilidade controlada", re.compile(r"disponibilidade controlada", re.I)),
    ("guardrails", re.compile(r"\bguardrails?\b", re.I)),
    ("ledger", re.compile(r"\bledger\b", re.I)),
    ("runbook", re.compile(r"\brunbook", re.I)),
    ("rollback", re.compile(r"\brollback\b", re.I)),
    ("failover", re.compile(r"\bfailover\b", re.I)),
    ("pipeline", re.compile(r"\bpipelines?\b", re.I)),
    ("release", re.compile(r"\breleases?\b", re.I)),
    ("fulfillment", re.compile(r"\bfulfil?lment\b", re.I)),
    ("dashboard", re.compile(r"\bdashboards?\b", re.I)),
    ("SLA", re.compile(r"\bSLA\b")),
    ("v1 (versão interna)", re.compile(r"\bv1\b")),
    ("adaptadores", re.compile(r"\badaptador(?:es)?\b", re.I)),
    ("E2E", re.compile(r"\bE2E\b")),
    ("prospecting/scoring/revenue", re.compile(r"\b(?:Prospecting|Scoring|Revenue)\b")),
    # Alegações sem fonte verificável (S-06).
    ("certificado/certificada (sem certificador)", re.compile(r"\bcertificad[oa]s?\b|\bcertifica[çc][aã]o\b", re.I)),
    ("prova do método", re.compile(r"prova do m[eé]todo", re.I)),
    # Erros de português que já saíram publicados (S-07, S-08).
    ("'dias corridos contado' (concordância: contados)", re.compile(r"dias corridos,? contado\b", re.I)),
    ("'Contado da assinatura' sem sujeito (contados)", re.compile(r"\bContado da assinatura")),
    # "açaiteria" (sem acento) é a grafia certa; só a forma com "í" reprova.
    ("'açaíteria' (grafia: açaiteria)", re.compile(r"a[çc]aíteria", re.I)),
]

_TEXT_ATTRS = re.compile(r'\s(?:alt|aria-label|title|placeholder)="([^"]*)"')
_META = re.compile(r'<meta\s+(?:name|property)="(?:description|og:title|og:description|twitter:title|twitter:description)"\s+content="([^"]*)"')


def _ld_strings(node, out: list[str]) -> None:
    if isinstance(node, dict):
        for k, v in node.items():
            if not k.startswith("@") and k not in ("url", "logo", "image", "sameAs"):
                _ld_strings(v, out)
    elif isinstance(node, list):
        for v in node:
            _ld_strings(v, out)
    elif isinstance(node, str) and not re.match(r"^https?://", node):
        out.append(node)


def public_text(page: str) -> str:
    """Tudo o que o cliente ou o buscador lê numa página HTML."""
    parts: list[str] = re.findall(r"<title>([^<]*)</title>", page) + _META.findall(page)
    for raw in re.findall(r'<script type="application/ld\+json">(.*?)</script>', page, re.S):
        try:
            _ld_strings(json.loads(raw), parts)
        except ValueError:
            parts.append(raw)
    body = re.sub(r"<(script|style)\b[^>]*>.*?</\1>", " ", page, flags=re.S | re.I)
    parts += _TEXT_ATTRS.findall(body)
    body = re.sub(r"<[^>]+>", " ", body)
    parts.append(body)
    return re.sub(r"\s+", " ", htmllib.unescape(" ".join(parts)))


def check(files: dict[str, str]) -> list[str]:
    problems: list[str] = []
    for name, content in sorted(files.items()):
        text = public_text(content) if name.endswith(".html") else re.sub(r"\(https?://[^)]*\)", " ", content)
        for label, rx in BANNED:
            for m in rx.finditer(text):
                ctx = text[max(0, m.start() - 40): m.end() + 40].strip()
                problems.append(f"{name}: {label}: «{ctx}»")
                break
    return problems


def load(out: Path = OUT) -> dict[str, str]:
    files = {p.name: p.read_text(encoding="utf-8") for p in sorted(out.glob("*.html"))}
    if (out / "llms.txt").is_file():
        files["llms.txt"] = (out / "llms.txt").read_text(encoding="utf-8")
    return files


# Cada mutante reinjeta numa página gerada UMA frase que já foi publicada; o gate precisa reprovar todas.
MUTANTS = [
    ("zevanory-cfo.html", "<li>FAIL_CLOSED por padrão.</li>"),
    ("zevanory-cfo.html", "<p>A v1 inicia adaptadores como UNCONFIGURED.</p>"),
    ("zevanory-cfo.html", "<li>Adaptadores só ficam READY com evidência associada.</li>"),
    ("zevanory-cfo.html", "<li>Venda permanece bloqueada até Legal, Pagamento, Entrega, Suporte e ZEES-16 aplicáveis estarem comprovados.</li>"),
    ("arbm-contador-saloes.html", "<p>Conta por tenant, aceite versionado de termos.</p>"),
    ("arbm-contador-saloes.html", "<p>Fonte, release, SHA, versão Cloudflare.</p>"),
    ("arbm-contador-saloes.html", "<p>O kill-switch global de vendas da ZEVANORY continua obrigatório.</p>"),
    ("arbm-contador-saloes.html", "<h2>Venda permanece deliberadamente bloqueada.</h2>"),
    ("arbm-contador-saloes.html", "<p class=\"microcopy\">Oferta certificada no nível do produto.</p>"),
    ("arbm-contador-saloes.html", "<p>O fluxo E2E de conta, recuperação, exportação e encerramento foi certificado.</p>"),
    ("arbm-contador-saloes.html", "<p>Runbook de incidentes, recuperação, rollback e privacidade.</p>"),
    ("zevanory-sales.html", "<p class=\"kicker\">ZEVANORY · Autonomous Sales Platform</p>"),
    ("zevanory-sales.html", "<span>Assist antes de Autopilot e Autonomous.</span>"),
    ("zevanory-sales.html", "<h3>SALES AUTOPILOT</h3>"),
    ("zevanory-sales.html", "<li>Observabilidade, failover e auditoria.</li>"),
    ("zevanory-sales.html", "<p>Pagamento reconciliado e fulfillment completam a prova comercial.</p>"),
    ("zevanory-sales.html", "<h2>Um pipeline que sabe onde cada oportunidade está.</h2>"),
    ("lucro-e-caixa.html", "<strong>Gate antes da venda</strong><span>Checkout só após validação completa.</span>"),
    ("lucro-e-caixa.html", "<strong>Performance primeiro</strong><span>HTML semântico e zero dependência de JS para renderizar.</span>"),
    ("lucro-e-caixa.html", "<span class=\"status-pill\">Disponibilidade controlada</span>"),
    ("solucoes.html", "<p>A própria ZEVANORY é prova do método.</p>"),
    ("termos.html", "<p>Pode desistir em 7 dias corridos contado da assinatura do contrato.</p>"),
    ("reembolso.html", "<p>o SLA específico de direitos LGPD permanece separado.</p>"),
    ("lucro-e-caixa.html", "<span>Contado da assinatura ou do recebimento, com devolução integral.</span>"),
    ("ia-por-ramo.html", "<h2>Açaíteria e sorveteria</h2>"),
    ("ia-para-acaiteria.html", "<title>IA para açaíteria e sorveteria: guia prático | ZEVANORY</title>"),
    ("ia-para-acaiteria.html", '<img src="/x.webp" alt="Balcão de uma açaíteria">'),
    ("zevanory-sales.html", '<script type="application/ld+json">{"@type":"FAQPage","mainEntity":[{"@type":"Question","name":"A contratação já está liberada?","acceptedAnswer":{"@type":"Answer","text":"Não enquanto o gate comercial global estiver fechado."}}]}</script>'),
    ("llms.txt", "- [IA para açaíteria e sorveteria](https://vendas.zevanory.api.br/ia-para-acaiteria)\n"),
]


def self_test() -> int:
    files = load()
    base = check(files)
    if base:
        print("SELF-TEST precondição: o site gerado já reprova:\n  " + "\n  ".join(base))
        return 1
    survivors = []
    for name, snippet in MUTANTS:
        if name not in files:
            survivors.append(f"{name}: página ausente")
            continue
        mutated = dict(files)
        anchor = "</main>" if "</main>" in files[name] else ("</body>" if name.endswith(".html") else "")
        mutated[name] = files[name].replace(anchor, snippet + anchor, 1) if anchor else files[name] + snippet
        if not check(mutated):
            survivors.append(f"{name}: texto antigo NÃO reprovou: {snippet[:70]}")
    # Controles: palavras corretas que não podem reprovar (falso positivo).
    clean = dict(files)
    clean["solucoes.html"] = files["solucoes.html"].replace("</main>", "<p>açaiteria e sorveteria; assistente de IA; Open Finance; botijão P13; 7 dias corridos contados da assinatura; Assistência técnica.</p></main>", 1)
    false_pos = check(clean)
    if false_pos:
        survivors.append("falso positivo em texto correto: " + "; ".join(false_pos))
    if survivors:
        print("SELF-TEST FAIL\n  " + "\n  ".join(survivors))
        return 1
    print(f"PUBLIC_COPY_SELF_TEST=PASS mutants_killed={len(MUTANTS)}/{len(MUTANTS)} false_positives=0")
    return 0


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return self_test()
    out = Path(argv[argv.index("--dir") + 1]) if "--dir" in argv else OUT
    files = load(out)
    if not files:
        print(f"PUBLIC_COPY_GATE=FAIL nenhuma página em {out}")
        return 1
    problems = check(files)
    if problems:
        print("PUBLIC_COPY_GATE=FAIL")
        for p in problems:
            print("  " + p)
        return 1
    print(f"PUBLIC_COPY_GATE=PASS files={len(files)} rules={len(BANNED)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
