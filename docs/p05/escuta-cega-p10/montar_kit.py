#!/usr/bin/env python3
"""P05 — kit de ESCUTA CEGA do P10, protocolo v2 (AVAL do Sol). Roda na máquina do condutor; NÃO publica nada e NÃO
grava áudio no repositório.

Itens (três fontes DISTINTAS, nunca o mesmo WAV em dois itens):
  - PENDENTE  : o clipe FLEURS do P10 com a transcrição oficial;
  - LIMPO     : outro clipe FLEURS (outro arquivo) com a transcrição oficial — esperado: nenhuma diferença;
  - TROCADO   : um TERCEIRO clipe FLEURS com 2 palavras do TEXTO trocadas de propósito — esperado: as 2 diferenças.
Cada um dos 5 avaliadores recebe um PACOTE PRÓPRIO: ordem própria e nomes de arquivo próprios (tokens aleatórios), de modo que
pacotes não podem ser comparados entre si para descobrir o papel de cada item.
Gabarito SELADO com sal secreto: selo = HMAC-SHA256(sal, JSON canônico do gabarito). O condutor publica o SELO antes da
escuta e revela o SAL e o gabarito só depois de recebidas todas as folhas (o hash puro seria enumerável).

Uso: montar_kit.py --out DIR [--avaliadores 5]   (o sal é gerado por secrets.token_hex e gravado só em DIR/SAL_SECRETO.txt)
"""
import argparse, hashlib, hmac, json, os, random, secrets, tarfile, urllib.request

BASE = "https://huggingface.co/datasets/google/fleurs/resolve/main/data/pt_br"
PENDENTE = ("train", "10010073088196743714.wav")
LIMPO = ("test", "14854034260357180334.wav")    # positivo com 0 erro no consenso em todas as rodadas
TROCADO = ("test", "12857830854717968324.wav")  # outro positivo limpo (fonte diferente do LIMPO)
TROCAS = {"de": "do", "a": "o", "que": "e", "uma": "a", "para": "pra", "com": "sem", "mais": "menos", "os": "as", "no": "na", "um": "o"}


def canonical(o):
    return json.dumps(o, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def seal(salt_hex, gabarito):
    return hmac.new(bytes.fromhex(salt_hex), canonical(gabarito).encode("utf-8"), hashlib.sha256).hexdigest()


def verify_seal(salt_hex, gabarito, selo):
    return hmac.compare_digest(seal(salt_hex, gabarito), selo)


def altera(texto, rng):
    ws = texto.split()
    idx = [i for i, w in enumerate(ws) if w.lower() in TROCAS]
    if len(idx) < 2:
        raise ValueError("texto sem 2 palavras trocáveis")
    rng.shuffle(idx)
    feitas = []
    for i in sorted(idx[:2]):
        feitas.append({"posicao": i, "no_audio": ws[i], "no_texto": TROCAS[ws[i].lower()]})
        ws[i] = TROCAS[ws[i].lower()]
    return " ".join(ws), feitas


def build_packages(itens, out, avaliadores=5, salt_hex=None, rng=None):
    """itens: lista de dicts {papel, wav, texto, esperado}. Fontes devem ser distintas (bytes diferentes).
    Cria out/avaliador_N/{<token>.wav, folha.md} com ordem e nomes próprios; devolve (gabarito, selo, sal)."""
    rng = rng or random.SystemRandom()
    digests = [hashlib.sha256(open(i["wav"], "rb").read()).hexdigest() for i in itens]
    if len(set(digests)) != len(digests):
        raise ValueError("fontes repetidas: cada item precisa de um WAV distinto")
    salt_hex = salt_hex or secrets.token_hex(32)
    gabarito = {"avaliadores": {}, "fontes": {i["papel"]: d for i, d in zip(itens, digests)}}
    for n in range(1, avaliadores + 1):
        pasta = os.path.join(out, f"avaliador_{n}")
        os.makedirs(pasta, exist_ok=True)
        ordem = list(itens)
        rng.shuffle(ordem)
        folha = [f"# Escuta cega — P05 · avaliador {n}", "",
                 "Ouça cada arquivo com fone, quantas vezes quiser. Sublinhe toda palavra em que o áudio é DIFERENTE do texto",
                 "(palavra trocada, faltando ou a mais). Não converse com outros avaliadores. Data: ______", ""]
        mapa = {}
        for item in ordem:
            token = secrets.token_hex(6)
            dst = os.path.join(pasta, f"{token}.wav")
            with open(item["wav"], "rb") as f, open(dst, "wb") as g:
                g.write(f.read())
            mapa[token] = {"papel": item["papel"], "esperado": item["esperado"]}
            folha += [f"## Arquivo {token}.wav", "", item["texto"], "", "Diferenças encontradas: ____________________________", ""]
        with open(os.path.join(pasta, "folha.md"), "w", encoding="utf-8") as f:
            f.write("\n".join(folha))
        gabarito["avaliadores"][str(n)] = mapa
    return gabarito, seal(salt_hex, gabarito), salt_hex


def decide(respostas, gabarito, minimo=4):
    """respostas: {avaliador: {token: set de palavras marcadas no TEXTO}}. Regra pré-registrada (v2):
    P10 = VERDADEIRO NEGATIVO (rejeição correta, desvio confirmado) só se ≥ 4/5 avaliadores VÁLIDOS marcam 'desta' e 'podem'
    no pendente E os controles se comportam como esperado (limpo sem marcação; trocado com as 2 trocas). Caso contrário: fallback."""
    validos, acertos = 0, 0
    for av, mapa in gabarito["avaliadores"].items():
        r = respostas.get(av, {})
        papel = {v["papel"]: (tok, v) for tok, v in mapa.items()}
        limpo_ok = not r.get(papel["limpo"][0])
        esperado_trocado = {t["no_texto"] for t in papel["trocado"][1]["esperado"]}
        trocado_ok = esperado_trocado <= set(r.get(papel["trocado"][0], set()))
        if limpo_ok and trocado_ok:
            validos += 1
            if {"desta", "podem"} <= set(r.get(papel["pendente"][0], set())):
                acertos += 1
    if validos >= minimo and acertos >= minimo:
        return "VERDADEIRO_NEGATIVO"
    if validos < minimo:
        return "FALLBACK_REPETIR_COM_NOVOS_AVALIADORES"
    return "FALLBACK_FALSE_DENY_PROVAVEL"


def tsv(split):
    rows = {}
    for line in urllib.request.urlopen(f"{BASE}/{split}.tsv", timeout=60).read().decode("utf-8").splitlines():
        c = line.split("\t")
        w = next((x for x in c if x.endswith(".wav")), None)
        if w:
            rows[w] = c[c.index(w) + 1]
    return rows


def extrai(split, nome, destino):
    with urllib.request.urlopen(f"{BASE}/audio/{split}.tar.gz", timeout=120) as r, tarfile.open(fileobj=r, mode="r|gz") as tf:
        for m in tf:
            if os.path.basename(m.name) == nome:
                with open(destino, "wb") as f:
                    f.write(tf.extractfile(m).read())
                return destino
    raise SystemExit(f"não encontrado: {nome}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--avaliadores", type=int, default=5)
    a = ap.parse_args()
    rng = random.SystemRandom()
    fonte = os.path.join(a.out, ".fonte")
    os.makedirs(fonte, exist_ok=True)
    textos = {}
    for split in {PENDENTE[0], LIMPO[0], TROCADO[0]}:
        textos.update(tsv(split))
    fp = extrai(*PENDENTE, os.path.join(fonte, "p.wav"))
    fl = extrai(*LIMPO, os.path.join(fonte, "l.wav"))
    ft = extrai(*TROCADO, os.path.join(fonte, "t.wav"))
    texto_trocado, trocas = altera(textos[TROCADO[1]], rng)
    itens = [{"papel": "pendente", "wav": fp, "texto": textos[PENDENTE[1]], "esperado": None},
             {"papel": "limpo", "wav": fl, "texto": textos[LIMPO[1]], "esperado": []},
             {"papel": "trocado", "wav": ft, "texto": texto_trocado, "esperado": trocas}]
    gabarito, selo, sal = build_packages(itens, a.out, a.avaliadores, rng=rng)
    with open(os.path.join(a.out, "gabarito_SELADO.json"), "w", encoding="utf-8") as f:
        f.write(canonical(gabarito))
    with open(os.path.join(a.out, "SAL_SECRETO.txt"), "w") as f:
        f.write(sal)
    print("SELO HMAC-SHA256 (publicar ANTES da escuta; sal e gabarito só depois de todas as folhas):", selo)


if __name__ == "__main__":
    main()
