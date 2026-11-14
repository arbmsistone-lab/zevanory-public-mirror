"""v3.4 A2 (NC-V34-01 + Comando Mestre §5): leitura INTEGRAL e EXATA do valor de uma célula real no vídeo.
Recebe os tokens do OCR feito SÓ dentro da região onde a captura foi encontrada e o valor exibido registrado na
proveniência (ex.: "R$ 39,00", "21,7%"). Aceita somente:
  - um token numérico IDÊNTICO à parte numérica (sem substring: "121,7%" não vale para "21,7%"); do passe geral com
    confiança >= 60, ou do passe só-de-dígitos (onde o tesseract não dá confiança útil) com igualdade exata;
  - se o valor tem "R$", um token "R$" na MESMA linha, imediatamente à esquerda do número.
Devolve a altura (px, 1080x1920) do número aceito, ou 0."""
import re

def _num(t):
    return re.sub(r"[^0-9,.%]", "", t)

def ler_valor(gerais, digitos, valor):
    partes = str(valor or "").split()
    if not partes:
        return 0
    alvo = _num(partes[-1])
    if not alvo or _num("".join(partes[-1:])) != partes[-1].replace(" ", ""):
        return 0
    quer_rs = len(partes) == 2 and partes[0] == "R$"
    if len(partes) > 2 or (len(partes) == 2 and not quer_rs):
        return 0
    todos = [dict(r, origem="g") for r in gerais] + [dict(r, origem="d") for r in digitos]
    nums = [r for r in todos if r["t"].strip() == partes[-1] and (r["origem"] == "d" or r["conf"] >= 60)]
    def mesma_linha(a, b):
        sob = min(a["y"] + a["h"], b["y"] + b["h"]) - max(a["y"], b["y"])
        return sob >= 0.5 * min(a["h"], b["h"])
    ok = []
    for n in nums:
        if quer_rs:
            rs = [r for r in todos if r["t"].strip() == "R$" and mesma_linha(r, n) and r["x"] + r["w"] <= n["x"] + 4 and n["x"] - (r["x"] + r["w"]) <= 1.5 * n["h"]]
            if not rs:
                continue
        ok.append(n["h"])
    return max(ok) if ok else 0
