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
def q_gancho(d):
    d.text((64, 300), "LOJA · " + O["nome"].upper(), font(40), BLUE)
    y = rich(d, 64, 370, spec["falas"][0]["texto"], font(116), hl=("dinheiro", "desaparece?"))
    y = rich(d, 64, y + 20, "Faça o teste com a sua última venda.", font(54), color=MUTED)
    d.rounded_rectangle((64, y + 40, SAFE_R, y + 290), 36, fill=CARD)
    d.text((110, y + 75), "Vendas do mês", font(44), MUTED); d.text((110, y + 135), "subindo", font(90), TXT)
    d.text((560, y + 75), "Sobrou no caixa", font(44), MUTED); d.text((560, y + 135), "?", font(90), YEL)
def q_venda(d):
    d.text((64, 300), "PASSO 1", font(44), BLUE)
    y = rich(d, 64, 370, "Pegue sua última venda.", font(108), hl=("última", "venda."))
    r0 = y + 40; d.rounded_rectangle((150, r0, 850, r0 + 560), 24, fill=(245, 247, 250))
    for k, (a, b) in enumerate([("Venda online", "Tênis"), ("Pagamento", "Cartão"), ("Data", "ontem")]):
        yy = r0 + 70 + k * 110; d.text((200, yy), a, font(46), (90, 100, 120)); d.text((800, yy), b, font(46), (20, 28, 40), anchor="ra")
    d.line((200, r0 + 420, 800, r0 + 420), fill=(200, 205, 215), width=3)
    d.text((200, r0 + 450), "Total recebido", font(48), (20, 28, 40)); d.text((800, r0 + 450), brl(N["preco_venda"]), font(48), (0, 120, 200), anchor="ra")
    d.text((150, r0 + 580), "comprovante ilustrativo · sem dados pessoais", font(34), MUTED)
def q_conta(d, etapa):
    d.text((64, 300), "A CONTA DE VERDADE", font(44), BLUE)
    rows = [("Recebeu", brl(N["preco_venda"]), TXT), ("Produto + frete", "− " + brl(N["custo_produto_frete"]), RED), (f"Taxa do cartão ({N['taxa_cartao_pct']}%)", "− " + brl(N["taxa_cartao"]), RED)]
    yy = 380
    for i, (a, b, c) in enumerate(rows[:min(len(rows), etapa + 1)]):
        d.rounded_rectangle((64, yy, SAFE_R, yy + 190), 30, fill=CARD); d.text((104, yy + 30), a, font(46), MUTED); d.text((104, yy + 88), b, font(84), c); yy += 210
    if etapa >= 3:
        d.rounded_rectangle((64, yy, SAFE_R, yy + 230), 30, fill=(10, 60, 40), outline=(40, 200, 120), width=4)
        d.text((104, yy + 28), "Margem antes das despesas fixas", font(44), (150, 240, 190)); d.text((104, yy + 90), brl(N["margem_antes_fixas"]), font(110), GREEN)
def q_planilha(d):
    d.text((64, 300), "NA PLANILHA DO KIT", font(44), BLUE)
    y0 = rich(d, 64, 360, "A margem aparece na hora.", font(80), hl=("margem",)) + 40
    for k, seg in enumerate(["planilha-entradas.png", "planilha-resultados.png"]):
        s = Image.open(ROOT / "assets/shorts-v3/lcx" / seg).convert("RGB"); s = s.resize((SAFE_R - 64, int(s.height * (SAFE_R - 64) / s.width)), Image.LANCZOS)
        d.rounded_rectangle((60, y0 - 6, SAFE_R + 4, y0 + s.height + 6), 10, fill=(255, 255, 255)); d.im.paste(s, (64, y0)); y0 += s.height + 40
    med["provaReal"] = True
    d.text((64, y0 + 10), "captura real da planilha · exemplo ilustrativo", font(34), MUTED)
    d.rounded_rectangle((64, y0 + 80, SAFE_R, y0 + 300), 36, fill=CARD, outline=BLUE, width=4)
    d.text((104, y0 + 110), "Margem de contribuição", font(46), MUTED); d.text((104, y0 + 175), N["margem_pct"], font(100), TXT)
def q_desconto(d):
    d.text((64, 300), "NA PLANILHA DO KIT", font(44), BLUE)
    y1 = rich(d, 64, 360, "O seu limite de desconto.", font(80), hl=("limite",)) + 40
    for k, (a, b, c) in enumerate([(f"Preço mínimo p/ meta de {N['meta_margem_pct']}%", brl(N["preco_minimo"]), YEL), ("Desconto máximo", N["desconto_maximo"], RED)]):
        yy = y1 + k * 320; d.rounded_rectangle((64, yy, SAFE_R, yy + 280), 36, fill=CARD)
        d.text((104, yy + 35), a, font(46), MUTED); d.text((104, yy + 110), b, font(130), c)
    med["provaReal"] = True
    d.text((64, y1 + 640), "calculado pela planilha real do kit", font(34), MUTED)
def q_oferta(d, fase):
    y = rich(d, 64, 300, O["beneficio"], font(84), hl=("margem",))
    d.rounded_rectangle((64, y + 30, SAFE_R, y + 560), 40, fill=(14, 26, 44), outline=BLUE, width=5)
    cv = Image.open(ROOT / O["capa"]).convert("RGB"); cv.thumbnail((210, 280)); d.im.paste(cv, (SAFE_R - 250, y + 70))
    d.text((110, y + 70), O["nome"], font(80), TXT)
    for k, t in enumerate(O["itens"]):
        d.ellipse((110, y + 190 + k * 70, 136, y + 216 + k * 70), fill=GREEN); d.text((155, y + 180 + k * 70), t.split(" e ")[0].split(" semanal")[0], font(44), TXT)
    if fase >= 1:
        d.text((110, y + 420), brl(O["preco"]), font(100), YEL); d.text((470, y + 440), "pagamento único", font(38), MUTED); d.text((470, y + 485), "arrependimento em 7 dias", font(38), MUTED)
    if fase >= 2:
        d.rounded_rectangle((64, y + 600, SAFE_R, y + 720), 60, fill=BLUE); d.text(((64 + SAFE_R) // 2, y + 660), "Link na descrição  ↓", font(62), BG, anchor="mm")
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
