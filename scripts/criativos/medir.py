#!/usr/bin/env python3
"""Laboratório de Criativos — MEDIÇÃO INDEPENDENTE (NC-02). Mede o material RENDERIZADO, nunca o que o criativo
declara: lê o texto de cada quadro com OCR (tesseract, por), calcula a menor altura de texto, conta palavras fora da
área segura do YouTube Shorts, detecta quadro vazio e procura as capturas reais do produto por correlação de imagem.
Uso: python3 -I medir.py <entrada.json>   (entrada: {"quadros":[png...], "provas":[{"captura":png,"largura":px renderizados}...]})
Saída (stdout): JSON {"quadros":[{texto, palavras, altura_min, fora}], "medidas":{...}}."""
import json, subprocess, sys
import numpy as np
from PIL import Image
SAFE_R, SAFE_B, TOP = 940, 1470, 250
cfg = json.load(open(sys.argv[1], encoding="utf-8"))
def _tess(png, escala):
    p = subprocess.run(["tesseract", "stdin", "stdout", "-l", "por", "--psm", "11", "tsv"], input=png, capture_output=True, check=True)
    rows = []
    for line in p.stdout.decode("utf-8", "replace").splitlines()[1:]:
        c = line.split("\t")
        if len(c) < 12 or not c[11].strip(): continue
        conf = float(c[10]); t = c[11].strip()
        if conf < 60: continue
        x, y, w, h = (round(int(v) / escala) for v in c[6:10]); rows.append({"t": t, "x": x, "y": y, "w": w, "h": h, "conf": conf})
    return rows
def ocr(img):
    """OCR em 1x (texto grande) e 2x (texto miúdo), unidos; coordenadas na escala 1080x1920."""
    import io
    base = _tess(img, 1)
    big = Image.open(io.BytesIO(img)); big = big.resize((big.width * 2, big.height * 2), Image.LANCZOS); b = io.BytesIO(); big.save(b, "PNG")
    def sobrepoe(r, q):
        ix = max(0, min(r["x"] + r["w"], q["x"] + q["w"]) - max(r["x"], q["x"])); iy = max(0, min(r["y"] + r["h"], q["y"] + q["h"]) - max(r["y"], q["y"]))
        return ix * iy > 0.3 * min(r["w"] * r["h"], q["w"] * q["h"])
    return base + [r for r in _tess(b.getvalue(), 2) if not any(sobrepoe(r, q) for q in base)]
def ncc_max(img, tmpl):
    """Correlação cruzada normalizada máxima (FFT + somas integrais)."""
    I = img.astype(np.float64); T = tmpl.astype(np.float64); th, tw = T.shape; ih, iw = I.shape
    if th > ih or tw > iw: return (0.0, None)
    T = T - T.mean(); tn = np.sqrt((T ** 2).sum())
    if tn == 0: return (0.0, None)
    sh = (ih + th - 1, iw + tw - 1)
    corr = np.fft.irfft2(np.fft.rfft2(I, sh) * np.fft.rfft2(T[::-1, ::-1], sh), sh)[th - 1:ih, tw - 1:iw]
    def win(a):
        s = np.pad(a, ((1, 0), (1, 0))).cumsum(0).cumsum(1); return s[th:, tw:] - s[:-th, tw:] - s[th:, :-tw] + s[:-th, :-tw]
    n = th * tw; s1 = win(I); s2 = win(I * I); var = s2 - s1 * s1 / n
    # Janela quase lisa (sem textura) nunca casa com a captura: evita falso positivo em áreas de cor sólida.
    ok = var > n * 25.0; r = np.zeros_like(corr); r[ok] = corr[ok] / (np.sqrt(var[ok]) * tn)
    k = int(np.argmax(r)); y, x = divmod(k, r.shape[1])
    return float(r.flat[k]), (x, y, tw, th)
quadros, alturas, fora, vazios = [], [], 0, 0
frames = []
for path in cfg["quadros"]:
    im = Image.open(path).convert("RGB")
    if im.size != (1080, 1920): im = im.resize((1080, 1920), Image.LANCZOS)
    frames.append(im)
# Capturas reais do produto: correlação por quadro; a região encontrada é PROVA (imagem do produto), e seu texto
# miúdo não conta para a legibilidade do criativo (os números importantes precisam aparecer ampliados fora dela).
regioes = {i: [] for i in range(len(frames))}; prova = []
for pv in cfg.get("provas", []):
    t, larg = (pv["captura"], pv["largura"]) if isinstance(pv, dict) else (pv, 876)
    tm = Image.open(t).convert("L"); best = 0.0; half = larg / 2
    for i, im in enumerate(frames):
        g = im.convert("L").resize((540, 960), Image.LANCZOS)
        for w in sorted({round(half * f) for f in (0.995, 1.0, 1.013)}):
            tt = tm.resize((w, max(1, round(tm.height * w / tm.width))), Image.LANCZOS)
            v, box = ncc_max(np.asarray(g), np.asarray(tt))
            if v > best: best = v
            if v >= 0.8 and box: regioes[i].append(tuple(2 * c for c in box))
    prova.append({"captura": t, "correlacao": round(best, 3)})
for i, im in enumerate(frames):
    import io; buf = io.BytesIO(); im.save(buf, "PNG"); rows = ocr(buf.getvalue())
    dentro = lambda r: any(x - 8 <= r["x"] and r["x"] + r["w"] <= x + w + 8 and y - 8 <= r["y"] and r["y"] + r["h"] <= y + h + 8 for x, y, w, h in regioes[i])
    rows = [r for r in rows if not dentro(r)]
    palavras = [r for r in rows if sum(ch.isalnum() for ch in r["t"]) >= 1]
    conteudo = [r for r in palavras if r["y"] >= TOP]
    f = [r["t"] for r in palavras if r["x"] + r["w"] > SAFE_R + 10 or r["y"] + r["h"] > SAFE_B]
    fora += len(f)
    hs = [r["h"] for r in palavras if sum(ch.isalpha() for ch in r["t"]) >= 3 and r["conf"] >= 60]
    if hs: alturas.append(min(hs))
    if len(conteudo) < 2: vazios += 1
    quadros.append({"texto": " ".join(r["t"] for r in palavras), "palavras": len(palavras), "altura_min": min(hs) if hs else None, "fora": f[:10]})
medidas = {"alturaTextoMinPx": min(alturas) if alturas else 0, "foraAreaSegura": fora, "quadrosVazios": vazios,
           "provaReal": bool(prova) and all(p["correlacao"] >= 0.8 for p in prova), "provas": prova, "origem": "medicao_independente_ocr"}
print(json.dumps({"quadros": quadros, "medidas": medidas}, ensure_ascii=False))
