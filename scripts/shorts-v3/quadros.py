#!/usr/bin/env python3
"""Shorts v3: desenha os quadros (1080x1920) de cada fala a partir da especificação (data/shorts-v3/*.json).
Uso: python3 -I quadros.py <raiz-repo> <spec.json> <pasta-saida>
Imprime JSON: {"quadros": {id: arquivo}, "medidas": {"fonteMinPx", "foraAreaSegura", "quadroVazio", "provaReal"}}.
Área segura do YouTube Shorts: nada essencial abaixo de y=1470 nem à direita de x=940."""
import json, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter
ROOT, SPEC, OUT = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
spec = json.loads(SPEC.read_text("utf-8")); OUT.mkdir(parents=True, exist_ok=True)
F = str(ROOT / "assets/fonts/Inter-ExtraBold.ttf")
W, H, SAFE_R, SAFE_B = 1080, 1920, 940, 1470
BG=(9,13,20); BLUE=(0,184,255); YEL=(255,214,10); TXT=(240,245,255); MUTED=(160,175,200); CARD=(20,30,46); RED=(255,120,120); GREEN=(90,230,150)
med = {"fonteMinPx": 999, "foraAreaSegura": 0, "quadroVazio": 0, "provaReal": False}
def font(s):
    med["fonteMinPx"] = min(med["fonteMinPx"], s); return ImageFont.truetype(F, s)
post = Image.open(ROOT / "assets/brand/export/post-01.png").convert("RGB"); mark = post.crop((80, 78, 152, 138))
class D:
    def __init__(s, im): s.im = im; s.d = ImageDraw.Draw(im)
    def text(s, xy, t, f, fill, anchor=None, essencial=True):
        s.d.text(xy, t, font=f, fill=fill, anchor=anchor)
        if essencial:
            b = s.d.textbbox(xy, t, font=f, anchor=anchor)
            if b[2] > SAFE_R + 2 or b[3] > SAFE_B: med["foraAreaSegura"] += 1
    def __getattr__(s, k): return getattr(s.d, k)
def base(progress):
    im = Image.new("RGB", (W, H), BG); glow = Image.new("RGB", (W, H), (0, 0, 0)); g = ImageDraw.Draw(glow)
    g.ellipse((-300, 1100, 700, 2100), fill=(0, 70, 110)); g.ellipse((600, -200, 1500, 700), fill=(30, 40, 90))
    im = Image.blend(im, glow.filter(ImageFilter.GaussianBlur(160)), 0.55)
    m = mark.resize((84, 70)); im.paste(m, (64, 74), m.convert("L").point(lambda v: 255 if v > 70 else 0))
    # v3.5 (júri real 8,5 — ensaio 43629467444): as barras decorativas abaixo de y=1470 foram retiradas ("terço
    # inferior ocupado por gráfico decorativo estático"); a área de conteúdo passa a ser usada pela prova real.
    d = D(im); d.text((170, 84), "ZEVANORY", font(50), TXT)
    d.rounded_rectangle((64, 170, SAFE_R, 182), 6, fill=(35, 45, 62)); d.rounded_rectangle((64, 170, 64 + int((SAFE_R - 64) * progress), 182), 6, fill=BLUE)
    return im, d
def wrap(d, text, f, width):
    out, line = [], ""
    for w in text.split():
        t = (line + " " + w).strip()
        if d.textlength(t, font=f) > width and line: out.append(line); line = w
        else: line = t
    return out + [line]
def rich(d, x, y, text, f, hl=(), color=TXT, lh=1.18, width=SAFE_R - 64):
    for ln in wrap(d, text, f, width):
        cx = x
        for w in ln.split():
            d.text((cx, y), w, f, YEL if w.strip(",.?!:").lower() in hl else color); cx += d.textlength(w + " ", font=f)
        y += int(f.size * lh)
    return y
N = spec["numeros"]; O = spec["oferta"]; brl = lambda v: "R$ " + f"{v:,}".replace(",", ".")
# v3.1 (júri real 8,2 — run 43538539233): conteúdo ocupa toda a área útil acima da faixa da legenda falada, planilha
# REAL em capturas grandes (LibreOffice pt-BR, 400 dpi), sem rótulos "ilustrativo", capa grande, textos longe da borda.
# Faixa y 1280–1460 = legenda falada (render.mjs, \pos(470,1380)); abaixo de 1470 = interface do Shorts.
CAP = ROOT / "assets/shorts-v3/lcx"; CB = 1150  # v3.4: legenda em y≈1240, conteúdo até 1150
def captura(d, nome, x, y, largura):
    s = Image.open(CAP / nome).convert("RGB"); s = s.resize((largura, round(s.height * largura / s.width)), Image.LANCZOS)
    d.rounded_rectangle((x - 8, y - 8, x + largura + 8, y + s.height + 8), 14, fill=(255, 255, 255)); d.im.paste(s, (x, y))
    med["provaReal"] = True
    return y + s.height + 8
PROV = json.loads((CAP / "planilha-proveniencia.json").read_text(encoding="utf-8"))
def celula(d, nome, y, largura=SAFE_R - 64):
    """v3.5: close-up REAL do LibreOffice Calc a 400% (célula selecionada, faixa das letras das colunas), recortado em
    torno do valor e ampliado só por escala uniforme; origem verificável escrita FORA do recorte."""
    largura = round(largura * float(spec.get("escala_celulas", 1)))  # só a calibração muda (caso negativo de célula miúda)
    c = PROV["celulas"][nome]; x = (64 + SAFE_R - largura) // 2
    fim = captura(d, Path(c["arquivo"]).name, x, y, largura)
    d.text((64, fim + 12), f"Aba {c['aba']} · célula {c['celula']} · zoom 400%", font(38), MUTED)
    return fim + 56
def tela(d, nome, y):
    """v3.5: TELA REAL do LibreOffice Calc (barra de fórmulas, colunas, linhas, abas, barra de status) com a célula
    selecionada; abaixo dela, uma seta amarela aponta do cabeçalho da coluna selecionada para o close-up."""
    c = PROV["celulas"][nome]; arq = CAP / Path(c["tela"]).name; s = Image.open(arq).convert("RGB")
    larg = SAFE_R - 64; esc = larg / s.width
    fim = captura(d, arq.name, 64, y, larg)
    px = s.load(); xs = next((v for v in ([i for i in range(s.width) if px[i, yy][:3] == (128, 0, 0)] for yy in range(0, 80)) if v), [])
    cx = 64 + round((min(xs) + max(xs)) / 2 * esc) if xs else (64 + SAFE_R) // 2
    seta(d, cx, fim + 2, fim + 40)
    return fim + 48
def q_gancho(d):
    d.text((64, 290), "LOJA · " + O["nome"].upper(), font(42), BLUE)
    y = rich(d, 64, 350, spec["falas"][0]["texto"], font(112), hl=("dinheiro", "desaparece?"))
    y = rich(d, 64, y + 10, "Faça o teste com a sua última venda.", font(54), color=MUTED)
    top, meio = y + 40, (64 + SAFE_R) // 2
    for x0, x1, rot, val, cor in ((64, meio - 14, "Vendas do mês", "↑", GREEN), (meio + 14, SAFE_R, "Sobrou no caixa", "?", YEL)):
        d.rounded_rectangle((x0, top, x1, CB), 36, fill=CARD)
        d.text((x0 + 36, top + 30), rot, font(44), MUTED)
        cx, cy, t = (x0 + x1) // 2, (top + 80 + CB) // 2, min(170, CB - top - 110)
        if val == "↑":  # seta desenhada (não é texto): a medição não a confunde com letra ilegível
            d.polygon([(cx, cy - t // 2), (cx - t // 2, cy), (cx - t // 6, cy), (cx - t // 6, cy + t // 2), (cx + t // 6, cy + t // 2), (cx + t // 6, cy), (cx + t // 2, cy)], fill=cor)
        else:
            d.text((cx, cy), val, font(t), cor, anchor="mm")
def q_venda(d):
    d.text((64, 290), "PASSO 1 · EXEMPLO DE VENDA: TÊNIS", font(44), BLUE)
    y = rich(d, 64, 350, "Pegue sua última venda.", font(84), hl=("última", "venda.")) + 26
    celula(d, "preco", tela(d, "preco", y))
def seta(d, x, y0, y1, cor=YEL):
    d.line((x, y0, x, y1 - 26), fill=cor, width=10); d.polygon([(x - 26, y1 - 30), (x + 26, y1 - 30), (x, y1)], fill=cor)
def q_conta(d, etapa):
    d.text((64, 290), "A CONTA DE VERDADE", font(46), BLUE)
    rows = [("Recebeu", brl(N["preco_venda"]), TXT), ("Produto + frete", "− " + brl(N["custo_produto_frete"]), RED), (f"Taxa do cartão ({N['taxa_cartao_pct']}%)", "− " + brl(N["taxa_cartao"]), RED)]
    if etapa < 3:  # a conta cresce linha a linha, ocupando a área toda (sem caixas vazias)
        vis = rows[:etapa + 1]; gap = 26; h = (CB - 360 - gap * (len(vis) - 1)) // len(vis); yy = 360
        for a, b, c in vis:
            d.rounded_rectangle((64, yy, SAFE_R, yy + h), 34, fill=CARD)
            fv = min(130, h - 120); y0 = yy + (h - (64 + 20 + fv)) // 2  # rótulo + valor centralizados no cartão
            d.text((110, y0), a, font(54), MUTED); d.text((110, y0 + 84), b, font(fv), c)
            yy += h + gap
        return
    y = celula(d, "contribuicao", tela(d, "contribuicao", 350)) + 4
    d.rounded_rectangle((64, y, SAFE_R, CB), 36, fill=(10, 60, 40), outline=(40, 200, 120), width=6)
    d.text(((64 + SAFE_R) // 2, (y + CB) // 2), "Sobram " + brl(N["margem_antes_fixas"]), font(min(110, CB - y - 30)), GREEN, anchor="mm")
def q_planilha(d):
    d.text((64, 290), "PLANILHA REAL · LIBREOFFICE CALC", font(44), BLUE)
    y = rich(d, 64, 350, "A margem aparece na hora.", font(80), hl=("margem",)) + 26
    celula(d, "margem", tela(d, "margem", y))
def q_desconto(d):
    d.text((64, 290), "PLANILHA REAL · LIBREOFFICE CALC", font(44), BLUE)
    y = rich(d, 64, 350, "O seu limite de desconto.", font(80), hl=("limite",)) + 26
    celula(d, "desconto", tela(d, "desconto", y))
MANUAL = "manual-topo.png"  # v3.5: topo REAL da capa do manual (recorte sem retoque), em largura total e legível
def capa(d, y, largura=SAFE_R - 64):
    return captura(d, MANUAL, (64 + SAFE_R - largura) // 2, y, largura)
def q_oferta(d, fase):
    if fase == 0:  # benefício: o produto real (topo do manual) e o que vem nele
        y = rich(d, 64, 290, O["beneficio"], font(84), hl=("margem",)) + 30
        y = capa(d, y) + 30
        for k, t in enumerate(O["itens"]):
            yy = y + k * 76; d.ellipse((70, yy + 14, 102, yy + 46), fill=GREEN); d.text((124, yy), t, font(50), TXT)
        return
    if fase == 1:  # oferta: preço e condições, grandes e separados
        d.text((64, 290), "KIT COMPLETO", font(46), BLUE)
        d.text((64, 350), "Lucro & Caixa", font(112), TXT)
        d.rounded_rectangle((64, 510, SAFE_R, 790), 40, fill=(14, 26, 44), outline=YEL, width=6)
        d.text(((64 + SAFE_R) // 2, 650), brl(O["preco"]), font(170), YEL, anchor="mm")
        for k, t in enumerate(("Pagamento único", "Arrependimento em 7 dias")):
            yy = 820 + k * 170; d.rounded_rectangle((64, yy, SAFE_R, yy + 150), 75, fill=CARD)
            d.ellipse((104, yy + 47, 160, yy + 103), fill=GREEN); d.text((190, yy + 75), t, font(56), TXT, anchor="lm")
        return
    d.text((64, 290), "LUCRO & CAIXA", font(46), BLUE)  # CTA
    y = rich(d, 64, 350, "Kit completo no link da descrição.", font(84), hl=("link",)) + 24
    d.text((64, y), "por " + brl(O["preco"]), font(96), YEL); y += 130
    y = capa(d, y) + 24
    d.rounded_rectangle((64, y, SAFE_R, CB), 70, fill=BLUE)
    d.text(((64 + SAFE_R) // 2, (y + CB) // 2), "Link na descrição", font(min(76, CB - y - 30)), BG, anchor="mm")
quadros = {"gancho": q_gancho, "venda": q_venda, "conta-1": lambda d: q_conta(d, 1), "conta-2": lambda d: q_conta(d, 2), "conta-3": lambda d: q_conta(d, 3),
           "planilha": q_planilha, "desconto": q_desconto, "beneficio": lambda d: q_oferta(d, 0), "oferta": lambda d: q_oferta(d, 1), "cta": lambda d: q_oferta(d, 2)}
falas = spec["falas"]; out = {}
for i, f in enumerate(falas):
    im, d = base((i + 1) / len(falas)); quadros[f["quadro"]](d)
    # quadro vazio = área de conteúdo sem desenho (variação de cor desprezível entre y=280 e 1470)
    box = im.crop((64, 280, SAFE_R, SAFE_B)).convert("L"); ext = box.getextrema()
    if ext[1] - ext[0] < 40: med["quadroVazio"] += 1
    p = OUT / f"quadro-{i + 1:02d}-{f['quadro']}.png"; im.save(p); out[f["quadro"]] = str(p)
print(json.dumps({"quadros": out, "medidas": med}, ensure_ascii=False))
