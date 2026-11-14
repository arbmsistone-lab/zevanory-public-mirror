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
    # v3.3 (júri real 9,1 — run 43600430291): a faixa abaixo de y=1470 (interface do Shorts) não fica preta e vazia:
    # gráfico de barras decorativo da marca, sem texto (nada essencial; a medição de área segura continua valendo).
    dd = D(im)
    for k, (hb, cor) in enumerate(zip((300, 420, 360, 480, 440, 560), ((22, 52, 92), (26, 60, 104), (22, 52, 92), (26, 66, 112), (22, 56, 98), (30, 74, 124)))):
        x0 = 84 + k * 156; dd.rounded_rectangle((x0, 1900 - hb, x0 + 110, 1900), 18, fill=cor)
    dd.line((64, 1902, 1016, 1902), fill=(40, 70, 110), width=4)
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
def celula(d, nome, y, largura):
    """v3.4 (NC-V34-01): UMA célula real da planilha, ampliada só por escala uniforme, com a origem verificável
    (planilha, aba, célula) escrita FORA do recorte. Nenhum pixel do recorte é alterado."""
    largura = round(largura * float(spec.get("escala_celulas", 1)))  # só a calibração muda (caso negativo de célula miúda)
    c = PROV["celulas"][nome]; x = (64 + SAFE_R - largura) // 2
    fim = captura(d, Path(c["arquivo"]).name, x, y, largura)
    d.text((64, fim + 14), f"Planilha Lucro & Caixa · aba {c['aba']} · célula {c['celula']}", font(36), MUTED)
    return fim + 62
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
    y = rich(d, 64, 350, "Pegue sua última venda.", font(108), hl=("última", "venda."))
    celula(d, "preco", y + 40, 640)
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
    y = celula(d, "contribuicao", 360, 820) + 10
    d.rounded_rectangle((64, y, SAFE_R, CB), 36, fill=(10, 60, 40), outline=(40, 200, 120), width=6)
    d.text(((64 + SAFE_R) // 2, (y + CB) // 2), "Sobram " + brl(N["margem_antes_fixas"]), font(min(110, CB - y - 40)), GREEN, anchor="mm")
def q_planilha(d):
    d.text((64, 290), "PLANILHA REAL DO KIT", font(46), BLUE)
    y = rich(d, 64, 350, "A margem aparece na hora.", font(92), hl=("margem",)) + 30
    celula(d, "margem", y, 820)
def q_desconto(d):
    d.text((64, 290), "PLANILHA REAL DO KIT", font(46), BLUE)
    y = rich(d, 64, 350, "O seu limite de desconto.", font(92), hl=("limite",)) + 30
    celula(d, "desconto", y, 820)
def capa(d, x, y):
    cv = Image.open(ROOT / O["capa"]).convert("RGB"); cv = cv.resize((300, round(cv.height * 300 / cv.width)), Image.LANCZOS)
    d.im.paste(cv, (x, y)); med["provaReal"] = True
    return y + cv.height
def q_oferta(d, fase):
    if fase == 0:  # benefício: o produto e o que vem nele
        y = rich(d, 64, 290, O["beneficio"], font(90), hl=("margem",)) + 40
        d.rounded_rectangle((64, y, SAFE_R, CB), 40, fill=(14, 26, 44), outline=BLUE, width=5)
        fim = capa(d, 100, y + 40)
        d.text((440, y + 40), "Lucro &", font(78), TXT); d.text((440, y + 124), "Caixa", font(78), TXT)
        for k, t in enumerate(O["itens"]):
            yy = y + 250 + k * 92; d.ellipse((442, yy + 12, 470, yy + 40), fill=GREEN)
            d.text((490, yy), t.split(" e ")[0].split(" semanal")[0], font(44), TXT)
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
    y = rich(d, 64, 350, "Kit completo no link da descrição.", font(100), hl=("link",)) + 40
    fim = capa(d, 64, y)
    d.text((410, y + 20), "por", font(56), MUTED); d.text((410, y + 90), brl(O["preco"]), font(130), YEL)
    d.rounded_rectangle((64, max(fim + 40, CB - 170), SAFE_R, CB), 85, fill=BLUE)
    d.text(((64 + SAFE_R) // 2, (max(fim + 40, CB - 170) + CB) // 2), "Link na descrição", font(76), BG, anchor="mm")
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
