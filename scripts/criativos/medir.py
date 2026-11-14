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
def _tess(png, escala, psm="11"):
    p = subprocess.run(["tesseract", "stdin", "stdout", "-l", "por", "--psm", psm, "tsv"], input=png, capture_output=True, check=True)
    rows = []
    for line in p.stdout.decode("utf-8", "replace").splitlines()[1:]:
        c = line.split("\t")
        if len(c) < 12 or not c[11].strip(): continue
        conf = float(c[10]); t = c[11].strip()
        if conf < 0: continue
        x, y, w, h = (round(int(v) / escala) for v in c[6:10]); rows.append({"t": t, "x": x, "y": y, "w": w, "h": h, "conf": conf})
    return rows
def sobrepoe(r, q):
    ix = max(0, min(r["x"] + r["w"], q["x"] + q["w"]) - max(r["x"], q["x"])); iy = max(0, min(r["y"] + r["h"], q["y"] + q["h"]) - max(r["y"], q["y"]))
    return ix * iy > 0.3 * max(1, min(r["w"] * r["h"], q["w"] * q["h"]))
def ocr(img):
    """OCR em quatro passadas unidas (cor psm 11, cor psm 3, cinza psm 11, cinza 2x psm 11); em sobreposição fica a
    leitura de maior confiança. Coordenadas na escala 1080x1920."""
    import io
    im = Image.open(io.BytesIO(img)); cinza = im.convert("L"); b1 = io.BytesIO(); cinza.save(b1, "PNG")
    big = cinza.resize((cinza.width * 2, cinza.height * 2), Image.LANCZOS); b2 = io.BytesIO(); big.save(b2, "PNG")
    todas = _tess(img, 1) + _tess(img, 1, "3") + _tess(b1.getvalue(), 1) + _tess(b2.getvalue(), 2)
    # Releitura: palavra vista com confiança baixa é recortada, ampliada 3x e lida de novo como linha única (psm 7).
    # Só conta como lida se a releitura for confiante; senão continua "não reconhecida".
    for r in todas:
        if 10 <= r["conf"] < 60 and sum(ch.isalnum() for ch in r["t"]) >= 3:
            x0, y0 = max(0, r["x"] - 12), max(0, r["y"] - 12); crop = cinza.crop((x0, y0, min(cinza.width, r["x"] + r["w"] + 12), min(cinza.height, r["y"] + r["h"] + 12)))
            crop = crop.resize((crop.width * 3, crop.height * 3), Image.LANCZOS); b3 = io.BytesIO(); crop.save(b3, "PNG")
            rel = [q for q in _tess(b3.getvalue(), 3, "7") if q["conf"] >= 60]
            if rel and sum(ch.isalnum() for ch in "".join(q["t"] for q in rel)) >= 0.6 * sum(ch.isalnum() for ch in r["t"]):
                r["conf"] = min(q["conf"] for q in rel); r["t"] = " ".join(q["t"] for q in rel)
    todas.sort(key=lambda r: -r["conf"]); final = []
    for r in todas:
        if not any(sobrepoe(r, q) for q in final): final.append(r)
    # Ordem de leitura (linhas de cima para baixo, esquerda para a direita), para as frases ficarem inteiras.
    final.sort(key=lambda r: (round((r["y"] + r["h"] / 2) / 28), r["x"]))
    return final
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
def estados_do_video(mp4, pasta, limiar=0.8):
    """NC-R01: o vídeo INTEIRO é varrido quadro a quadro (30 fps, em cinza reduzido); todo quadro cujo conteúdo muda
    em relação ao último estado guardado vira um novo estado e é extraído em resolução cheia para a medição.
    Assim nenhum texto exibido entre duas falas, numa transição ou por poucos quadros escapa."""
    import os, tempfile
    W, H = 270, 480
    p = subprocess.run(["ffmpeg", "-v", "error", "-i", mp4, "-vf", f"scale={W}:{H},format=gray", "-f", "rawvideo", "-"], capture_output=True, check=True)
    raw = np.frombuffer(p.stdout, dtype=np.uint8); n = raw.size // (W * H); fr = raw[: n * W * H].reshape(n, H, W).astype(np.int16)
    manter, ultimo = [], None
    for i in range(n):
        if ultimo is None or np.abs(fr[i] - fr[ultimo]).mean() > limiar: manter.append(i); ultimo = i
    os.makedirs(pasta, exist_ok=True)
    for f in os.listdir(pasta):  # estados de uma medição anterior na mesma pasta nunca entram nesta
        if f.startswith("estado-"): os.remove(os.path.join(pasta, f))
    sel = "+".join(f"eq(n\\,{i})" for i in manter)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", mp4, "-vf", f"select='{sel}'", "-vsync", "0", os.path.join(pasta, "estado-%04d.png")], check=True)
    arquivos = sorted(os.path.join(pasta, f) for f in os.listdir(pasta) if f.startswith("estado-"))
    if len(arquivos) != len(manter): raise SystemExit("medir_estados_incompletos")
    return arquivos, {"quadros_total": int(n), "estados": len(manter)}
cobertura = None
if cfg.get("video"):
    cfg["quadros"], cobertura = estados_do_video(cfg["video"], cfg.get("pasta_estados") or (cfg["video"] + "-estados"))
def tinta_sem_leitura(im, caixas, B=24):
    """NC-R05: procura TEXTURA DE TEXTO que o OCR não leu (ex.: texto de baixo contraste, miúdo ou borrado). Blocos
    24x24 da área de conteúdo com densidade de bordas típica de letras, fora das palavras lidas e das capturas do
    produto, após remover linhas longas (bordas de cartões). Cinco ou mais blocos vizinhos na mesma faixa = linha de texto."""
    g = np.asarray(im.convert("L"), dtype=np.int16)
    e = np.zeros(g.shape, bool); e[:, 1:] |= np.abs(np.diff(g, axis=1)) > 18; e[1:, :] |= np.abs(np.diff(g, axis=0)) > 18
    for x, y, w, h in caixas: e[max(0, y - 10):y + h + 10, max(0, x - 16):x + w + 16] = False
    e[:TOP, :] = False; e[SAFE_B:, :] = False
    linhas = e.sum(1) > 300; e[linhas, :] = False; colunas = e.sum(0) > 300; e[:, colunas] = False
    H, W = e.shape; marc = np.zeros((H // B, W // B), bool)
    for by in range(H // B):
        for bx in range(W // B):
            f = e[by * B:(by + 1) * B, bx * B:(bx + 1) * B].mean()
            marc[by, bx] = 0.06 <= f <= 0.45
    grupos = []
    for by in range(marc.shape[0]):
        corr = 0
        for bx in range(marc.shape[1]):
            corr = corr + 1 if marc[by, bx] else 0
            if corr == 5: grupos.append([(bx - 4) * B, by * B])
    return grupos
quadros, alturas, fora, vazios, nao_reconhecido = [], [], 0, 0, 0
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
    # NC-R05: texto que o OCR enxerga mas não consegue ler com confiança (>=3 caracteres alfanuméricos, conf < 60,
    # na área de conteúdo) é conteúdo ilegível: reprova, em vez de ser descartado em silêncio.
    nao_lidos = [r["t"] for r in rows if r["conf"] < 60 and sum(ch.isalnum() for ch in r["t"]) >= 3 and r["y"] >= TOP and r["conf"] >= 10]
    rows = [r for r in rows if r["conf"] >= 60]
    lidas = [(r["x"], r["y"], r["w"], r["h"]) for r in rows]
    sem_leitura = tinta_sem_leitura(im, lidas + list(regioes[i]))
    nao_reconhecido += len(nao_lidos) + len(sem_leitura)
    palavras = [r for r in rows if sum(ch.isalnum() for ch in r["t"]) >= 1]
    conteudo = [r for r in palavras if r["y"] >= TOP]
    f = [r["t"] for r in palavras if r["x"] + r["w"] > SAFE_R + 10 or r["y"] + r["h"] > SAFE_B]
    fora += len(f)
    hs = [r["h"] for r in palavras if sum(ch.isalpha() for ch in r["t"]) >= 3 and r["conf"] >= 60]
    if hs: alturas.append(min(hs))
    if len(conteudo) < 2: vazios += 1
    quadros.append({"texto": " ".join(r["t"] for r in palavras), "palavras": len(palavras), "altura_min": min(hs) if hs else None, "fora": f[:10], "nao_lidos": nao_lidos[:10], "tinta_sem_leitura": sem_leitura[:10]})
medidas = {"alturaTextoMinPx": min(alturas) if alturas else 0, "foraAreaSegura": fora, "quadrosVazios": vazios, "textoNaoReconhecido": nao_reconhecido,
           "provaReal": bool(prova) and all(p["correlacao"] >= 0.8 for p in prova), "provas": prova, "origem": "medicao_independente_ocr", "cobertura": cobertura}
print(json.dumps({"quadros": quadros, "medidas": medidas}, ensure_ascii=False))
