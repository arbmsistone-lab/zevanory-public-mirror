#!/usr/bin/env python3
"""Renderiza as prévias "página real do material" a partir dos zips v1.2 ENTREGUES (mesmo SHA do catálogo).

Mesma política das prévias atuais (docs/evidence/sales-ux/previews-manifest.json):
  - página de PDF: pdftoppm -r 110 -png; Pillow Lanczos; mesma dimensão final da prévia atual (640x828).
    As páginas v1.2 são A4 (a v1.1 era Carta): a página INTEIRA cabe em 640x828 com margem branca (sem corte).
  - planilha: LibreOffice headless --convert-to html (sem rede, sem JavaScript), screenshot do <table> da aba pelo
    Playwright; recorte no canto superior esquerdo (crop_box, px antes do redimensionamento) com a MESMA proporção
    da prévia atual; Lanczos para 720 de largura. Só valores renderizados; planilha VAZIA (modelo, sem exemplo).
  - WebP q78 method 6; AVIF q55.
Uso: render_previews.py <saida> <zip>... (os zips ficam fora do repositório; só as imagens saem daqui)
"""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

from PIL import Image

OUT = Path(sys.argv[1])
ZIPS = {Path(z).name: Path(z) for z in sys.argv[2:]}
OUT.mkdir(parents=True, exist_ok=True)


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def member(zname: str, suffix: str) -> tuple[str, bytes]:
    with zipfile.ZipFile(ZIPS[zname]) as z:
        names = [n for n in z.namelist() if n.endswith(suffix)]
        assert len(names) == 1, (zname, suffix, names)
        root = names[0].split("/", 1)[0] + "/"
        return names[0][len(root):], z.read(names[0])


def encode(im: Image.Image, iid: str) -> dict:
    out = {}
    for fmt, kw in (("webp", {"quality": 78, "method": 6}), ("avif", {"quality": 55})):
        p = OUT / f"{iid}.{fmt}"
        im.save(p, fmt.upper(), **kw)
        b = p.read_bytes()
        out[fmt] = {"file": f"assets/previews/{iid}.{fmt}", "sha256": sha(b), "bytes": len(b)}
    return out


def toc_page(pdf: Path, title: str) -> int:
    t = subprocess.run(["pdftotext", "-f", "2", "-l", "4", "-layout", str(pdf), "-"], capture_output=True, text=True, check=True).stdout
    return next(int(ln.split()[-1]) for ln in t.splitlines() if ln.strip().startswith(title))


def pdf_page(td: Path, data: bytes, page: int | str, iid: str, size=(640, 828)) -> tuple[Image.Image, int]:
    pdf = td / f"{iid}.pdf"
    pdf.write_bytes(data)
    n = toc_page(pdf, page) if isinstance(page, str) else page
    subprocess.run(["pdftoppm", "-r", "110", "-png", "-f", str(n), "-l", str(n), "-singlefile", str(pdf), str(td / iid)], check=True)
    im = Image.open(td / f"{iid}.png").convert("RGB")
    im.thumbnail(size, Image.LANCZOS)
    canvas = Image.new("RGB", size, "white")
    canvas.paste(im, ((size[0] - im.width) // 2, (size[1] - im.height) // 2))
    return canvas, n


def sheet_crop(td: Path, data: bytes, sheet: str, iid: str, crop_w: int, final=(720, 349)) -> tuple[Image.Image, list[int]]:
    from playwright.sync_api import sync_playwright
    x = td / f"{iid}.xlsx"
    x.write_bytes(data)
    subprocess.run(["soffice", f"-env:UserInstallation=file://{td / 'lo'}", "--headless", "--convert-to", "html", "--outdir", str(td), str(x)],
                   check=True, capture_output=True, timeout=300)
    html = td / f"{iid}.html"
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(java_script_enabled=False, viewport={"width": 1600, "height": 1200})
        pg.route("**/*", lambda r: r.continue_() if r.request.url.startswith("file:") else r.abort())
        pg.goto(html.as_uri())
        tables = pg.locator("table")
        heads = pg.locator("h1")
        idx = None
        for i in range(heads.count()):
            if heads.nth(i).inner_text().strip().endswith(sheet):
                idx = i - 1  # o 1º h1 é "Overview" (sem tabela)
        assert idx is not None, sheet
        shot = td / f"{iid}-full.png"
        tables.nth(idx).screenshot(path=str(shot))
        b.close()
    im = Image.open(shot).convert("RGB")
    crop_h = round(crop_w * final[1] / final[0])
    box = [0, 0, min(crop_w, im.width), min(crop_h, im.height)]
    im = im.crop(box).resize(final, Image.LANCZOS)
    return im, box


def main():
    IA, VE, CMB = "ZEVANORY_IA_na_Pratica_v1.2.zip", "ZEVANORY_Vendas_na_Pratica_v1.2.zip", "ZEVANORY_Combo_IA_e_Vendas_v1.2.zip"
    zsha = {n: sha(p.read_bytes()) for n, p in ZIPS.items()}
    imgs = []
    with tempfile.TemporaryDirectory(dir=OUT.parent) as td:
        td = Path(td)
        specs = [
            ("manual-ia-capa", IA, "Manual_v1.2.pdf", "pdf", 1, ["ia-na-pratica", "combo-ia-vendas"], "01_IA_na_Pratica_v1.2/"),
            ("manual-ia-aula-a1", IA, "Manual_v1.2.pdf", "pdf", "A1 —", ["ia-na-pratica"], None),
            ("planilha-ia-orcamento", IA, "Planilha_v1.2.xlsx", "sheet", ("Orçamento", 900, (720, 349)), ["ia-na-pratica"], None),
            ("manual-vendas-capa", VE, "Manual_v1.2.pdf", "pdf", 1, ["vendas-na-pratica"], None),
            ("manual-vendas-aula-b1", VE, "Manual_v1.2.pdf", "pdf", "B1 —", ["vendas-na-pratica", "combo-ia-vendas"], "02_Vendas_na_Pratica_v1.2/"),
            ("planilha-vendas-oportunidades", VE, "Planilha_v1.2.xlsx", "sheet", ("Oportunidades", 1120, (720, 341)), ["vendas-na-pratica", "combo-ia-vendas"], "02_Vendas_na_Pratica_v1.2/"),
        ]
        # Lucro & Caixa e Negócio Completo: só quando o zip FINAL (o que estiver no catálogo) for passado.
        LCX, NGC = "ZEVANORY_Lucro_e_Caixa_v1.2.zip", "ZEVANORY_Negocio_Completo_v1.2.zip"
        if LCX in ZIPS:
            specs += [("manual-lucro-capa", LCX, "Manual_v1.2.pdf", "pdf", 1, ["lucro-e-caixa"], None),
                      ("manual-lucro-modulo-1", LCX, "Manual_v1.2.pdf", "pdf", "Módulo 1 —", ["lucro-e-caixa"], None),
                      # A prévia atual oculta a coluna de leitura do Painel: conferir o novo layout e passar a caixa em
                      # LUCRO_REDACT=x0,y0,x1,y1 (px do recorte) antes de publicar.
                      ("planilha-lucro-painel", LCX, "Planilha_v1.2.xlsx", "sheet", ("Painel de Decisão", 1184, (720, 373)), ["lucro-e-caixa"], None)]
        if NGC in ZIPS:
            specs += [("plano-30-dias-capa", NGC, "Plano_30_Dias_v1.2.pdf", "pdf", 1, ["negocio-completo"], None),
                      ("painel-decisao-integrada", NGC, "Painel_Decisao_Integrada_v1.2.xlsx", "sheet", ("Painel de Decisão", 1184, (720, 182)), ["negocio-completo"], None)]
        for iid, zname, suffix, kind, arg, products, cprefix in specs:
            rel, data = member(zname, suffix)
            if kind == "pdf":
                im, page = pdf_page(td, data, arg, iid)
                loc, crop, note = {"page": page}, None, "página inteira em 640x828 com margem branca (A4)"
            else:
                sheet, cw, final = arg
                im, crop = sheet_crop(td, data, sheet, iid, cw, final)
                loc, note = {"sheet": sheet}, "pixels, left/top/right/bottom, applied before resize"
            enc = encode(im, iid)
            sources = [{"product": products[0], "zip": zname, "zip_sha256": zsha[zname], "path_in_zip": rel, "file_sha256": sha(data)}]
            if cprefix:
                crel, cdata = member(CMB, cprefix + rel)
                assert sha(cdata) == sha(data), iid + ": arquivo do Combo difere do avulso"
                sources.append({"product": "combo-ia-vendas", "zip": CMB, "zip_sha256": zsha[CMB], "path_in_zip": crel, "file_sha256": sha(cdata)})
            imgs.append({"id": iid, "products": products, "webp": enc["webp"], "avif": enc["avif"], "width": im.width, "height": im.height,
                         "sources": sources, "location": loc, "crop_box": crop, "crop_note": note if crop else None, "fit_note": None if crop else note})
            print(iid, im.size, loc, enc["webp"]["sha256"][:12])
    (OUT / "render.json").write_text(json.dumps({"zips": zsha, "images": imgs}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
