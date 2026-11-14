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
CAP = ROOT / "assets/shorts-v3/lcx"; CB = 1250
def captura(d, nome, x, y, largura):
    s = Image.open(CAP / nome).convert("RGB"); s = s.resize((largura, round(s.height * largura / s.width)), Image.LANCZOS)
    d.rounded_rectangle((x - 8, y - 8, x + largura + 8, y + s.height + 8), 14, fill=(255, 255, 255)); d.im.paste(s, (x, y))
    med["provaReal"] = True
    return y + s.height + 8
def q_gancho(d):
    d.text((64, 290), "LOJA · " + O["nome"].upper(), font(42), BLUE)
    y = rich(d, 64, 350, spec["falas"][0]["texto"], font(112), hl=("dinheiro", "desaparece?"))
    y = rich(d, 64, y + 10, "Faça o teste com a sua última venda.", font(54), color=MUTED)
    top, meio = y + 40, (64 + SAFE_R) // 2
    for x0, x1, rot, val, cor in ((64, meio - 14, "Vendas do mês", "↑", GREEN), (meio + 14, SAFE_R, "Sobrou no caixa", "?", YEL)):
        d.rounded_rectangle((x0, top, x1, CB), 36, fill=CARD)
        d.text((x0 + 36, top + 30), rot, font(44), MUTED)
        d.text(((x0 + x1) // 2, (top + 80 + CB) // 2), val, font(min(170, CB - top - 110)), cor, anchor="mm")
def q_venda(d):
    d.text((64, 290), "PASSO 1", font(46), BLUE)
    y = rich(d, 64, 350, "Pegue sua última venda.", font(108), hl=("última", "venda."))
    r0 = y + 40
    d.rounded_rectangle((64, r0, SAFE_R, CB), 32, fill=(245, 247, 250))
    d.text((120, r0 + 40), "EXEMPLO DE VENDA", font(42), (0, 120, 200))
    for k, (a, b) in enumerate([("Venda online", "Tênis"), ("Pagamento", "Cartão"), ("Data", "ontem")]):
        yy = r0 + 120 + k * 92; d.text((120, yy), a, font(52), (90, 100, 120)); d.text((SAFE_R - 56, yy), b, font(52), (20, 28, 40), anchor="ra")
    d.line((120, CB - 135, SAFE_R - 56, CB - 135), fill=(200, 205, 215), width=4)
    d.text((120, CB - 100), "Total recebido", font(58), (20, 28, 40)); d.text((SAFE_R - 56, CB - 112), brl(N["preco_venda"]), font(80), (0, 120, 200), anchor="ra")
def q_conta(d, etapa):
    d.text((64, 290), "A CONTA DE VERDADE", font(46), BLUE)
    rows = [("Recebeu", brl(N["preco_venda"]), TXT), ("Produto + frete", "− " + brl(N["custo_produto_frete"]), RED), (f"Taxa do cartão ({N['taxa_cartao_pct']}%)", "− " + brl(N["taxa_cartao"]), RED)]
    yy = 360
    for i, (a, b, c) in enumerate(rows):
        if i <= etapa:
            d.rounded_rectangle((64, yy, SAFE_R, yy + 195), 32, fill=CARD); d.text((110, yy + 28), a, font(48), MUTED); d.text((110, yy + 88), b, font(90), c)
        else:
            d.rounded_rectangle((64, yy, SAFE_R, yy + 195), 32, outline=(45, 60, 85), width=4)
        yy += 215
    if etapa >= 3:
        d.rounded_rectangle((64, yy, SAFE_R, CB), 32, fill=(10, 60, 40), outline=(40, 200, 120), width=5)
        d.text((110, yy + 28), "Margem antes das despesas fixas", font(48), (150, 240, 190)); d.text((110, CB - 30), brl(N["margem_antes_fixas"]), font(130), GREEN, anchor="ls")
    else:
        d.rounded_rectangle((64, yy, SAFE_R, CB), 32, outline=(45, 60, 85), width=4)
        d.text(((64 + SAFE_R) // 2, (yy + CB) // 2), "sobra = ?", font(64), MUTED, anchor="mm")
def q_planilha(d):
    d.text((64, 290), "PLANILHA REAL DO KIT", font(46), BLUE)
    y = rich(d, 64, 350, "A margem aparece na hora.", font(92), hl=("margem",)) + 30
    y = captura(d, "planilha-resultados.png", 64, y, SAFE_R - 64) + 40
    d.rounded_rectangle((64, y, SAFE_R, CB), 36, fill=CARD, outline=BLUE, width=5)
    d.text((110, y + 30), "Margem de contribuição", font(50), MUTED); d.text((110, CB - 30), N["margem_pct"], font(min(150, CB - y - 110)), TXT, anchor="ls")
def q_desconto(d):
    d.text((64, 290), "PLANILHA REAL DO KIT", font(46), BLUE)
    y = rich(d, 64, 350, "O seu limite de desconto.", font(92), hl=("limite",)) + 30
    y = captura(d, "planilha-desconto.png", 64, y, SAFE_R - 64) + 40
    meio = (64 + SAFE_R) // 2
    for x0, x1, a, b, c in ((64, meio - 14, f"Preço mínimo p/ meta de {N['meta_margem_pct']}%", brl(N["preco_minimo"]), YEL), (meio + 14, SAFE_R, "Desconto máximo", N["desconto_maximo"], RED)):
        d.rounded_rectangle((x0, y, x1, CB), 34, fill=CARD)
        rich(d, x0 + 34, y + 26, a, font(42), color=MUTED, lh=1.12, width=x1 - x0 - 60)
        d.text((x0 + 34, CB - 34), b, font(100), c, anchor="ls")
def q_oferta(d, fase):
    y = rich(d, 64, 290, O["beneficio"], font(88), hl=("margem",))
    top, bot = y + 36, (1110 if fase >= 2 else CB)
    d.rounded_rectangle((64, top, SAFE_R, bot), 40, fill=(14, 26, 44), outline=BLUE, width=5)
    py = bot - 175
    cv = Image.open(ROOT / O["capa"]).convert("RGB"); cv = cv.resize((300, round(cv.height * 300 / cv.width)), Image.LANCZOS)
    d.im.paste(cv, (SAFE_R - 336, top + 30)); med["provaReal"] = True
    d.text((104, top + 34), "Lucro &", font(80), TXT); d.text((104, top + 120), "Caixa", font(80), TXT)
    if fase < 2:
        for k, t in enumerate(O["itens"]):
            yy = top + 240 + k * 66; d.ellipse((106, yy + 12, 132, yy + 38), fill=GREEN); d.text((150, yy), t.split(" e ")[0].split(" semanal")[0], font(44), TXT)
    d.text((104, py), brl(O["preco"]), font(112), YEL)
    if fase < 2:  # no quadro do CTA o preço fica sozinho (as condições já apareceram no quadro anterior)
        for k, t in enumerate(("pagamento único", "arrependimento", "em 7 dias")):
            d.text((520, py + 4 + k * 50), t, font(44), (205, 215, 232))
    if fase >= 2:
        d.rounded_rectangle((64, 1130, SAFE_R, CB), 60, fill=BLUE); d.text(((64 + SAFE_R) // 2, 1190), "Link na descrição  ↓", font(62), BG, anchor="mm")
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
