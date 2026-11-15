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
# v3.9 (júri real 8,3, ensaio 43768114276: "conteúdo espremido na metade superior, área vazia entre y=1100 e 1470";
# "legendas isoladas no vazio inferior"): o conteúdo desce até CB=1290 e a legenda falada fica LOGO ABAIXO dele, em
# y=1310 (render.mjs, LEGENDA_Y), sempre no mesmo lugar (leitura estável nas transições); abaixo de 1470 = interface.
# v3.10 (ensaio real 43774298571, legibilidade 7,8: "legendas muito próximas do limite y=1470"; GPT-6: legenda mais
# alta e junto ao conteúdo): o conteúdo termina em CB=1250 e a legenda fica em y=1310 (LEGENDA_Y), 120 px acima da
# interface do Shorts.
CAP = ROOT / "assets/shorts-v3/lcx"; CB = 1250
def captura(d, nome, x, y, largura):
    s = Image.open(CAP / nome).convert("RGB"); s = s.resize((largura, round(s.height * largura / s.width)), Image.LANCZOS)
    d.rounded_rectangle((x - 8, y - 8, x + largura + 8, y + s.height + 8), 14, fill=(255, 255, 255)); d.im.paste(s, (x, y))
    med["provaReal"] = True
    return y + s.height + 8
PROV = json.loads((CAP / "planilha-proveniencia.json").read_text(encoding="utf-8"))
def largura_spec(arquivo):
    """largura desenhada = a declarada na spec (a mesma usada pela medição do vídeo)"""
    return next(int(p["largura"]) for p in spec["provas"] if Path(p["captura"]).name == Path(arquivo).name)
LARG_PROVA = SAFE_R - 64  # v3.9: a coluna real ocupa a largura útil (876)
def prova(d, nome, y):
    """v3.9 (júri: "duplicidade da mesma célula sem contexto", "linhas de zoom finas amadoras"; GPT-6: "cada célula uma
    vez, ampliada, com cabeçalhos e contexto"): só a COLUNA real do Calc a 400% — letra da coluna, cabeçalho, números das
    linhas e a célula selecionada na linha 5 —, ampliada por escala uniforme até a largura útil, num cartão branco.
    Nada é desenhado sobre os pixels da captura: o marcador amarelo fica FORA do cartão, à esquerda da linha da célula,
    e a origem fica escrita abaixo. Devolve o fim do bloco."""
    c = PROV["celulas"][nome]; arq = Path(c["coluna"]).name
    s0 = Image.open(CAP / arq).convert("RGB"); larg = largura_spec(c["coluna"]); alt = round(s0.height * larg / s0.width)
    x = (64 + SAFE_R - larg) // 2
    fim = captura(d, arq, x, y, larg)
    # linha da célula selecionada (a última da captura): o cabeçalho de linha vermelho-escuro do Calc marca a seleção
    px = s0.load(); ys = [j for j in range(s0.height) if px[2, j][:3] == (128, 0, 0)]
    e = alt / s0.height; l0, l1 = (y + round(min(ys) * e), y + round((max(ys) + 1) * e)) if ys else (y + alt - 60, y + alt)
    m = (l0 + l1) // 2; d.polygon([(x - 50, m - 26), (x - 50, m + 26), (x - 16, m)], fill=YEL)
    d.text((x, fim + 8), f"Aba {c['aba']} · célula {c['celula']} da planilha", font(42), MUTED)
    return fim + 64
def bloco_prova(nome, extra=0):
    """altura do cartão da coluna + origem (mesmas contas de prova())"""
    c = PROV["celulas"][nome]; k = Image.open(CAP / Path(c["coluna"]).name)
    return round(k.height * largura_spec(c["coluna"]) / k.width) + 8 + 64 + extra
def embaixo(y_min, altura, fim=CB):
    """v3.9: o bloco termina em CB, logo acima da legenda que o explica; a folga fica entre o título e o bloco"""
    return max(y_min, fim - altura)
# v3.8 (contra-auditoria GPT-6 + júri real 7,5 de legibilidade, ensaio 43731076486: "faixa borrada escura exagerada"):
# a área abaixo de y=1470 (interface do Shorts) fica com o MESMO fundo contínuo do quadro — sem desfoque, sem texto.
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
    y = rich(d, 64, 350, "Sua última venda.", font(84), hl=("última", "venda.")) + 26
    prova(d, "preco", embaixo(y, bloco_prova("preco")))
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
    faixa = 170; y = prova(d, "contribuicao", embaixo(356, bloco_prova("contribuicao", 10 + faixa))) + 10
    d.rounded_rectangle((64, y, SAFE_R, CB), 34, fill=(10, 60, 40), outline=(40, 200, 120), width=6)
    d.text(((64 + SAFE_R) // 2, (y + CB) // 2), "Sobram " + brl(N["margem_antes_fixas"]), font(min(110, CB - y - 40)), GREEN, anchor="mm")
def q_planilha(d):
    d.text((64, 290), "PLANILHA REAL · LIBREOFFICE CALC", font(44), BLUE)
    y = rich(d, 64, 350, "A margem, na hora.", font(80), hl=("margem,",)) + 14
    y = rich(d, 64, y, "Quanto sobra de cada venda, em porcentagem.", font(56), color=MUTED) + 26
    prova(d, "margem", embaixo(y, bloco_prova("margem")))
def q_desconto(d):
    d.text((64, 290), "PLANILHA REAL · LIBREOFFICE CALC", font(44), BLUE)
    y = rich(d, 64, 350, "Limite de desconto.", font(80), hl=("limite",)) + 14
    y = rich(d, 64, y, "Desconto maior que este derruba a margem abaixo da meta.", font(56), color=MUTED) + 26
    prova(d, "desconto", embaixo(y, bloco_prova("desconto")))
# v3.9 (júri: "mockup do kit pequeno, tipografia interna pouco legível"; GPT-6: 80% da largura, nome do kit legível no
# celular): título REAL da 1ª página do manual do kit (docx sha256 8515fb14…, LibreOffice -> PDF -> 300 dpi), só recorte
# e REDUÇÃO para 876 px (nenhum pixel ampliado); proveniência em planilha-proveniencia.json (manual_titulo).
MANUAL = "manual-titulo.png"
ALT_CAPA = round(Image.open(CAP / MANUAL).height * (SAFE_R - 64) / Image.open(CAP / MANUAL).width) + 16
def capa(d, y, largura=SAFE_R - 64):
    return captura(d, MANUAL, (64 + SAFE_R - largura) // 2, y, largura)
def q_oferta(d, fase):
    if fase == 0:  # benefício: o produto real (topo do manual) e o que vem nele
        y = rich(d, 64, 290, O["beneficio"], font(84), hl=("margem",)) + 30
        y = capa(d, y) + 40
        n = len(O["itens"]); h = (CB - y - 20 * (n - 1)) // n
        for k, t in enumerate(O["itens"]):  # cada item num cartão, ocupando a área até a legenda
            yy = y + k * (h + 20); d.rounded_rectangle((64, yy, SAFE_R, yy + h), 40, fill=CARD)
            d.ellipse((104, yy + h // 2 - 22, 148, yy + h // 2 + 22), fill=GREEN); d.text((180, yy + h // 2), t, font(56), TXT, anchor="lm")
        return
    if fase == 1:  # oferta: preço e condições, grandes e separados
        d.text((64, 290), "KIT COMPLETO", font(46), BLUE)
        d.text((64, 350), "Lucro & Caixa", font(112), TXT)
        d.rounded_rectangle((64, 510, SAFE_R, 790), 40, fill=(14, 26, 44), outline=YEL, width=6)
        d.text(((64 + SAFE_R) // 2, 650), brl(O["preco"]), font(170), YEL, anchor="mm")
        h = (CB - 830 - 24) // 2  # v3.9: as duas condições ocupam a área até a legenda
        for k, t in enumerate(("Pagamento único", "Arrependimento em 7 dias")):
            yy = 830 + k * (h + 24); d.rounded_rectangle((64, yy, SAFE_R, yy + h), 60, fill=CARD)
            d.ellipse((104, yy + h // 2 - 28, 160, yy + h // 2 + 28), fill=GREEN); d.text((190, yy + h // 2), t, font(60), TXT, anchor="lm")
        return
    d.text((64, 290), "LUCRO & CAIXA", font(46), BLUE)  # CTA
    # CTA (GPT-6, 15/11): links na descrição de Shorts não são clicáveis no YouTube -> "link do perfil"
    y = rich(d, 64, 350, "Kit Lucro & Caixa no link do perfil.", font(84), hl=("perfil.",)) + 24
    d.text((64, y), "por " + brl(O["preco"]), font(96), YEL); y += 130
    # v3.9: botão de altura fixa terminando em CB (logo acima da legenda); um botão alto demais o OCR da página inteira
    # trata como imagem e não lê o texto (prévia v3.9: "Link no perfil" sem leitura). A capa fica centrada no espaço.
    BOT = 190; capa(d, y + max(0, (CB - BOT - 24 - y - ALT_CAPA) // 2))
    d.rounded_rectangle((64, CB - BOT, SAFE_R, CB), 70, fill=BLUE)
    d.text(((64 + SAFE_R) // 2, CB - BOT // 2), "Link no perfil", font(76), BG, anchor="mm")
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
