#!/usr/bin/env python3
"""Varredura de preço (auditoria #954 HIGH-1): prova que data/products.json governa TODO preço do repositório.

    python3 scripts/price_surface_scan.py            # CI: PRICE_SCAN=OK ou FAIL
    python3 scripts/price_surface_scan.py --selftest # prova que a varredura pega um preço literal plantado

Método: copia os arquivos versionados para um diretório temporário, troca os preços em data/products.json por
valores-sentinela (que não existem em lugar nenhum), roda scripts/sync_canonical_prices.py e scripts/build_sales_public.py
na cópia e procura o preço REAL (e os valores derivados: total separado, economia, comissão de afiliado) em todos os
arquivos de texto. Qualquer ocorrência fora de EXCECOES é uma superfície com preço próprio, que não acompanharia uma
mudança de preço: o script falha e diz onde. Não usa rede nem credencial.
"""
from __future__ import annotations

import fnmatch
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Arquivos que podem citar um valor igual a um preço sem ser superfície de preço. Cada um com o motivo.
EXCECOES = {
    "docs/**": "registro histórico, de design ou de evidência (não publicado no site nem usado pelo Worker)",
    "data/commitments.json": "registro histórico de compromissos e readbacks datados",
    "evidence/**": "relatórios de evidência datados (o que valia naquela data)",
    "tests/ci/p16-target-lifecycle.test.mjs": "L13: link de compra de OUTRO SKU com valor arbitrário (o teste prova que o gate recusa)",
    "tests/site-chat.test.mjs": "entrada do validador do chat (prova que o chat RECUSA citar preço por conta própria)",
    "tests/creative-autonomy.test.mjs": "criativo de exemplo do avaliador (entrada do teste, não publicado)",
    "tests/site-crawl-gate.test.mjs": "página-stub do teste do crawler",
    "tests/youtube-daily-short.test.mjs": "entrada do conversor de fala (R$ por extenso)",
    "scripts/whatsapp_conversation_test.mjs": "respostas falsas da IA para o validador do canal aposentado",
    "scripts/ci/mutants_site_chat_allow.json": "justificativa de mutante que cita a entrada do validador",
    "scripts/price_surface_scan.py": "este arquivo",
}
TEXT_EXT = {".html", ".htm", ".mjs", ".js", ".json", ".py", ".txt", ".md", ".yml", ".yaml", ".xml", ".csv", ".toml", ".svg"}
SENTINEL_BASE = 1201  # 1201, 1302, 1403, ...: nenhum aparece no repositório


def tracked(root: Path) -> list[str]:
    out = subprocess.run(["git", "ls-files", "-z"], cwd=root, capture_output=True, check=True).stdout.decode()
    return [p for p in out.split("\0") if p]


def excepted(rel: str) -> bool:
    return any(fnmatch.fnmatch(rel, pat) or (pat.endswith("/**") and rel.startswith(pat[:-2])) for pat in EXCECOES)


def brl(v: int) -> str:
    return f"{v:,}".replace(",", ".")


def real_values(d: dict) -> tuple[set[int], set[str]]:
    by = {p["slug"]: p["price"] for p in d["products"]}
    sub = int(d["subscription"]["price"])
    ints = set(by.values()) | {sub}
    for slug, parts in (("combo-ia-vendas", ["ia-na-pratica", "vendas-na-pratica"]), ("negocio-completo", ["ia-na-pratica", "vendas-na-pratica", "lucro-e-caixa"])):
        sep = sum(by[s] for s in parts)
        ints |= {sep, sep - by[slug]}
    cents = {f"{brl(v // 2)},{50 if v % 2 else 0:02d}" for v in set(by.values()) | {sub}}  # comissão de 50%
    return ints, {c for c in cents if not c.endswith(",00")}


MONEY = re.compile(r"R\$\s?(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d\d))?")
FIELD = re.compile(r"\b(price_brl|table_price_brl|pilot_price_brl|serverPrice|amount_brl|unit_price|SANDBOX_AMOUNT_BRL)\"?\s*[:=]\s*\"?(\d+)(?:\.0+)?\b")


def leftovers(root: Path, files: list[str], ints: set[int], cents: set[str]) -> list[str]:
    found = []
    for rel in files:
        if excepted(rel) or Path(rel).suffix.lower() not in TEXT_EXT:
            continue
        try:
            text = (root / rel).read_text(encoding="utf-8")
        except (UnicodeDecodeError, FileNotFoundError):
            continue
        for n, line in enumerate(text.splitlines(), 1):
            for m in MONEY.finditer(line):
                v, c = int(m.group(1).replace(".", "")), m.group(2)
                if (v in ints and c in (None, "00")) or (c and f"{m.group(1)},{c}" in cents):
                    found.append(f"{rel}:{n}: {line[max(0, m.start() - 50):m.end() + 20].strip()}")
            for m in FIELD.finditer(line):
                if int(m.group(2)) in ints:
                    found.append(f"{rel}:{n}: {line[max(0, m.start() - 30):m.end() + 10].strip()}")
    return found


def run(plant: str | None = None) -> tuple[bool, list[str]]:
    d = json.loads((ROOT / "data/products.json").read_text(encoding="utf-8"))
    ints, cents = real_values(d)
    files = tracked(ROOT)
    with tempfile.TemporaryDirectory(prefix="price-scan-") as tmp:
        work = Path(tmp)
        for rel in files:
            src = ROOT / rel
            if src.is_file():
                dst = work / rel
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
        sent = json.loads(json.dumps(d))
        for i, p in enumerate(sent["products"]):
            p["price"] = SENTINEL_BASE + 101 * i
        sent["subscription"]["price"] = SENTINEL_BASE + 101 * len(sent["products"])
        (work / "data/products.json").write_text(json.dumps(sent, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        if plant:  # autoteste: um preço literal fora do sincronizador
            f = work / plant
            f.write_text(f.read_text(encoding="utf-8") + f"\n<!-- oferta: R$ {sorted(ints)[0]} -->\n", encoding="utf-8")
        steps = [[sys.executable, "-B", "scripts/sync_canonical_prices.py"], [sys.executable, "-B", "scripts/build_sales_public.py"]]
        for cmd in steps:
            r = subprocess.run(cmd, cwd=work, capture_output=True, text=True)
            if r.returncode != 0:
                return False, [f"{' '.join(cmd[2:])} falhou com preços-sentinela: {(r.stdout + r.stderr)[-600:]}"]
        return True, leftovers(work, files, ints, cents)


def main(argv: list[str]) -> int:
    if "--selftest" in argv:
        ok, found = run(plant="kit-afiliado/index.html")
        caught = ok and any(x.startswith("kit-afiliado/index.html:") and "oferta: R$" in x for x in found)
        print(f"PRICE_SCAN_SELFTEST={'OK' if caught else 'FAIL'}")
        return 0 if caught else 1
    ok, found = run()
    for x in found:
        print("::error title=preco-literal::" + x)
    print(f"PRICE_SCAN={'OK' if ok and not found else 'FAIL'} ocorrencias={len(found)} excecoes={len(EXCECOES)}")
    return 0 if ok and not found else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
