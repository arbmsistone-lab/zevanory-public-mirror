#!/usr/bin/env python3
"""E-book de bolso para o Amazon KDP (Plano Mestre, canal 14) — ferramenta local de autoria.

Gera, SÓ a partir do manual real do kit (DOCX conferido por SHA-256), um EPUB 3 (formato aceito pelo KDP) e a capa
(JPEG 1600x2560, proporção 1,6 recomendada pelo KDP), mais metadados para o cadastro. A ZEVANORY não publica no KDP
(não existe API de publicação): o proprietário sobe os arquivos pelo site, com preço e dados fiscais decididos por ele.

O texto das lições é copiado do manual SEM reescrita (títulos, explicação, exemplo fictício, passos, atividade e
critério de conferência); só as seções de formulário ("Registro pessoal da atividade") são omitidas, porque tabelas
de preenchimento não funcionam no Kindle. Nada é inventado: o que não vem do manual vem do arquivo de configuração
(nota de uso e fechamento), revisado por PR.

Uso: python3 -I ebook_bolso.py <raiz-repo> <config.json> <manual.docx> <pasta-saida>
Os arquivos do kit (manual e saída) NÃO são versionados: são o produto pago.
"""
import hashlib, html, json, re, sys, uuid, zipfile
from datetime import date
from pathlib import Path


def ler_manual(docx_path):
    """Blocos (estilo, texto) do DOCX, na ordem; tabelas ignoradas (os formulários)."""
    import docx  # python-docx
    return [(p.style.name, p.text.strip()) for p in docx.Document(str(docx_path)).paragraphs]


def modulos(blocos):
    """{"01": {"titulo", "subtitulo", "secoes": [(titulo, [(estilo, texto)])]}} a partir dos Heading 1 "NN | ..."."""
    out, atual, secao = {}, None, None
    for estilo, t in blocos:
        if estilo == "Heading 1":
            atual = None
            if len(t) > 5 and t[:2].isdigit() and t[2:5] == " | ":
                atual = out.setdefault(t[:2], {"titulo": t[5:], "subtitulo": "", "secoes": []}); secao = None
            continue
        if atual is None or not t:
            continue
        if estilo == "Subtitle" and not atual["secoes"] and not atual["subtitulo"]:
            atual["subtitulo"] = t
        elif estilo == "Heading 2":
            secao = (t, []); atual["secoes"].append(secao)
        elif secao is not None:
            secao[1].append((estilo, t))
    return out


def selecionar(mods, cfg):
    falta = [m for m in cfg["modulos"] if m not in mods]
    if falta:
        raise SystemExit("kdp_modulo_ausente:" + ",".join(falta))
    sel = []
    for m in cfg["modulos"]:
        mod = mods[m]
        secoes = [(t, ps) for t, ps in mod["secoes"] if t not in cfg["omitir_secoes"]]
        if not secoes or not all(ps for _, ps in secoes):
            raise SystemExit("kdp_modulo_sem_texto:" + m)
        sel.append({"numero": m, "titulo": mod["titulo"], "subtitulo": mod["subtitulo"], "secoes": secoes})
    return sel


e = lambda s: html.escape(s, quote=True)
XHTML = ('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" '
         'xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="pt-BR" lang="pt-BR">\n<head><meta charset="UTF-8"/>'
         '<title>{t}</title><link rel="stylesheet" type="text/css" href="estilo.css"/></head>\n<body>\n{b}\n</body>\n</html>\n')
CSS = ("body{font-family:serif;line-height:1.45;margin:0 4%;}h1{font-size:1.5em;margin:1.2em 0 .3em;}"
       "h2{font-size:1.15em;margin:1.1em 0 .3em;}p.sub{font-style:italic;margin-top:0;}p.passo{margin:.25em 0 .25em 1em;}"
       "ul{margin:.3em 0 .3em 1.2em;}p.nota{margin:.4em 0 .6em 1em;padding:.3em .5em;border-left:3px solid #999;font-size:.95em;}p.aviso{font-size:.9em;}.capa{text-align:center;margin:0;}"
       ".capa img{max-width:100%;max-height:100%;}")


def capitulo(m, i, nota=None):
    b = [f'<section epub:type="chapter" id="cap{i}"><h1>{e(m["numero"])} | {e(m["titulo"])}</h1>']
    if m["subtitulo"]:
        b.append(f'<p class="sub">{e(m["subtitulo"])}</p>')
    for titulo, ps in m["secoes"]:
        b.append(f"<h2>{e(titulo)}</h2>")
        lista = []
        for estilo, t in ps:
            if estilo == "List Bullet":
                lista.append(f"<li>{e(t)}</li>"); continue
            if lista:
                b.append("<ul>" + "".join(lista) + "</ul>"); lista = []
            passo = re.match(r"^\d+\.\s", t)
            b.append(("<p class=\"passo\">" if passo else "<p>") + e(t) + "</p>")
            if passo and nota and t.startswith("1."):  # instrução editorial logo após o 1º passo (texto do manual intacto)
                b.append('<p class="nota"><b>Nota desta edição:</b> ' + e(nota) + "</p>"); nota = None
        if lista:
            b.append("<ul>" + "".join(lista) + "</ul>")
    b.append("</section>")
    return XHTML.format(t=e(m["titulo"]), b="\n".join(b))


def texto_simples(cfg, chave, titulo, id_):
    aviso = ' class="aviso"'
    link = cfg.get("link_kit", "")
    def par(t):
        x = e(t)
        if link:
            alvo = link.split("://", 1)[1]
            x = x.replace(e(alvo), f'<a href="{e(link)}">{e(alvo)}</a>')
        return "<p" + (aviso if "não garante" in t else "") + ">" + x + "</p>"
    ps = "".join(par(t) for t in cfg[chave])
    return XHTML.format(t=e(titulo), b=f'<section epub:type="chapter" id="{id_}"><h1>{e(titulo)}</h1>{ps}</section>')


def capa(raiz, cfg, saida):
    from PIL import Image, ImageDraw, ImageFont, ImageFilter
    W, H = cfg["capa"]["largura"], cfg["capa"]["altura"]
    BG, AZUL, AMAR, TXT, MUT = (9, 13, 20), (0, 184, 255), (255, 214, 10), (240, 245, 255), (160, 175, 200)
    F = str(raiz / "assets/fonts/Inter-ExtraBold.ttf")
    reg = next((p for p in ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",) if Path(p).exists()), F)
    im = Image.new("RGB", (W, H), BG); glow = Image.new("RGB", (W, H)); g = ImageDraw.Draw(glow)
    g.ellipse((-500, 1500, 1100, 3100), fill=(0, 70, 110)); g.ellipse((900, -400, 2300, 1000), fill=(30, 40, 90))
    im = Image.blend(im, glow.filter(ImageFilter.GaussianBlur(240)), 0.6); d = ImageDraw.Draw(im)
    post = Image.open(raiz / "assets/brand/export/post-01.png").convert("RGB"); mark = post.crop((80, 78, 152, 138)).resize((168, 140))
    im.paste(mark, (120, 150), mark.convert("L").point(lambda v: 255 if v > 70 else 0))
    d.text((320, 175), "ZEVANORY", font=ImageFont.truetype(F, 96), fill=TXT)
    d.rounded_rectangle((120, 360, W - 120, 376), 8, fill=AZUL)
    y = 560
    for linha, cor in (("Lucro &", TXT), ("Caixa", AMAR), ("de Bolso", TXT)):
        d.text((120, y), linha, font=ImageFont.truetype(F, 250), fill=cor); y += 290
    fs = ImageFont.truetype(F, 84); y += 80
    palavras, linha = cfg["subtitulo"].split(), ""
    for w in palavras:
        t = (linha + " " + w).strip()
        if d.textlength(t, font=fs) > W - 240 and linha:
            d.text((120, y), linha, font=fs, fill=MUT); y += 104; linha = w
        else:
            linha = t
    d.text((120, y), linha, font=fs, fill=MUT); y += 104
    for k, t in enumerate(("Faturamento × caixa", "Margem e markup", "Taxa da maquininha", "Plano de 30 dias")):
        yy = 1900 + k * 120; d.ellipse((130, yy + 22, 186, yy + 78), fill=(90, 230, 150)); d.text((220, yy), t, font=ImageFont.truetype(reg, 72), fill=TXT)
    d.text((120, H - 150), cfg["autor"], font=ImageFont.truetype(F, 64), fill=AZUL)
    p = saida / "capa.jpg"; im.save(p, "JPEG", quality=92); return p


def main(raiz, cfg_path, docx_path, saida):
    raiz, saida = Path(raiz), Path(saida); saida.mkdir(parents=True, exist_ok=True)
    cfg = json.loads(Path(cfg_path).read_text("utf-8"))
    fonte = Path(docx_path).read_bytes()
    if hashlib.sha256(fonte).hexdigest() != cfg["fonte"]["sha256"]:
        raise SystemExit("kdp_manual_divergente")  # só o manual registrado vira livro
    sel = selecionar(modulos(ler_manual(docx_path)), cfg)
    capa_p = capa(raiz, cfg, saida)
    ident = "urn:uuid:" + str(uuid.uuid5(uuid.NAMESPACE_URL, "zevanory-kdp:" + cfg["sku"] + ":" + cfg["fonte"]["sha256"]))
    paginas = [("capa.xhtml", "Capa", XHTML.format(t="Capa", b='<div class="capa"><img src="capa.jpg" alt="Capa: ' + e(cfg["titulo"]) + '"/></div>')),
               ("nota.xhtml", "Antes de começar", texto_simples(cfg, "nota_de_uso", "Antes de começar", "nota"))]
    paginas += [(f"cap{i + 1:02d}.xhtml", f'{m["numero"]} | {m["titulo"]}', capitulo(m, i + 1, cfg.get("notas_edicao", {}).get(m["numero"]))) for i, m in enumerate(sel)]
    paginas.append(("fim.xhtml", "Próximos passos", texto_simples(cfg, "fechamento", "Próximos passos", "fim")))
    nav = XHTML.format(t="Sumário", b='<nav epub:type="toc" id="toc"><h1>Sumário</h1><ol>' + "".join(
        f'<li><a href="{a}">{e(t)}</a></li>' for a, t, _ in paginas[1:]) + "</ol></nav>")
    hoje = date.today().isoformat()
    opf = ('<?xml version="1.0" encoding="UTF-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id" xml:lang="pt-BR">\n'
           '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n'
           f'<dc:identifier id="id">{ident}</dc:identifier><dc:title>{e(cfg["titulo"])}</dc:title>'
           f'<dc:creator>{e(cfg["autor"])}</dc:creator><dc:language>{cfg["idioma"]}</dc:language><dc:publisher>{e(cfg["autor"])}</dc:publisher>'
           f'<dc:description>{e(cfg["kdp"]["descricao"])}</dc:description><meta property="dcterms:modified">{hoje}T00:00:00Z</meta>'
           '<meta name="cover" content="capa-img"/>\n</metadata>\n<manifest>\n'
           '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
           '<item id="css" href="estilo.css" media-type="text/css"/>'
           '<item id="capa-img" href="capa.jpg" media-type="image/jpeg" properties="cover-image"/>'
           + "".join(f'<item id="p{i}" href="{a}" media-type="application/xhtml+xml"/>' for i, (a, _, _) in enumerate(paginas))
           + '\n</manifest>\n<spine>' + "".join(f'<itemref idref="p{i}"/>' for i in range(len(paginas))) + '</spine>\n</package>\n')
    epub = saida / "lucro-e-caixa-de-bolso.epub"
    with zipfile.ZipFile(epub, "w") as z:
        z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", '<?xml version="1.0"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
                   '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>\n', zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/content.opf", opf, zipfile.ZIP_DEFLATED); z.writestr("OEBPS/nav.xhtml", nav, zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/estilo.css", CSS, zipfile.ZIP_DEFLATED); z.write(capa_p, "OEBPS/capa.jpg", zipfile.ZIP_DEFLATED)
        for a, _, x in paginas:
            z.writestr("OEBPS/" + a, x, zipfile.ZIP_DEFLATED)
    meta = {"titulo": cfg["titulo"], "subtitulo": cfg["subtitulo"], "autor": cfg["autor"], "idioma": cfg["idioma"], "edicao": cfg["edicao"],
            "descricao": cfg["kdp"]["descricao"], "palavras_chave": cfg["kdp"]["palavras_chave"], "categorias_sugeridas": cfg["kdp"]["categorias_sugeridas"],
            "fonte_sha256": cfg["fonte"]["sha256"], "modulos": [m["numero"] + " | " + m["titulo"] for m in sel],
            "arquivos": {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in (epub, capa_p)},
            "pendente_proprietario": ["conta KDP e dados fiscais", "preço e royalties", "territórios", "subir EPUB e capa no site do KDP"]}
    (saida / "kdp-metadados.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), "utf-8")
    # pacote de envio (bytes preservados): a MESMA capa que está dentro do EPUB, conferida por hash
    with zipfile.ZipFile(epub) as z:
        if hashlib.sha256(z.read("OEBPS/capa.jpg")).hexdigest() != meta["arquivos"]["capa.jpg"]:
            raise SystemExit("kdp_capa_divergente")
    with zipfile.ZipFile(saida / "pacote-kdp.zip", "w", zipfile.ZIP_STORED) as z:
        for p in (epub, capa_p, saida / "kdp-metadados.json"):
            z.write(p, p.name)
    print(json.dumps({"epub": str(epub), "capa": str(capa_p), "modulos": meta["modulos"]}, ensure_ascii=False))


if __name__ == "__main__":
    main(*sys.argv[1:5])
