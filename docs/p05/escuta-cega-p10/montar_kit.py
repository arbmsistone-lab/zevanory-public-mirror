#!/usr/bin/env python3
"""P05 — monta o kit de ESCUTA CEGA do P10 (AVAL 098, opção b). Roda na máquina do condutor; NÃO publica nada e
NÃO grava áudio no repositório. Baixa da FLEURS pt_br (CC BY 4.0) o clipe pendente e um controle limpo, e cria três
itens embaralhados (semente registrada):
  - o clipe pendente com a transcrição oficial;
  - o controle limpo com a transcrição oficial (esperado: nenhuma diferença);
  - o MESMO controle com a transcrição alterada em 2 palavras conhecidas (esperado: os avaliadores acham as 2).
Os avaliadores (≥ 3, nativos de pt-BR, fone de ouvido) marcam, palavra por palavra, onde o áudio difere do texto.
Saída: <out>/itens/{A,B,C}.wav, <out>/folha_avaliador.md, <out>/gabarito_SELADO.json (só o condutor abre; o
SHA-256 dele vai no registro antes da escuta).
Uso: montar_kit.py --out DIR [--semente 20261023]"""
import argparse, hashlib, json, os, random, tarfile, urllib.request

BASE = "https://huggingface.co/datasets/google/fleurs/resolve/main/data/pt_br"
PENDENTE = ("train", "10010073088196743714.wav")
CONTROLE = ("test", "14854034260357180334.wav")  # positivo com 0 erro no consenso em todas as rodadas


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
                open(destino, "wb").write(tf.extractfile(m).read())
                return destino
    raise SystemExit(f"não encontrado: {nome}")


def altera(texto, rng):
    trocas = {"de": "do", "a": "o", "que": "e", "uma": "a", "para": "pra", "com": "sem", "mais": "menos"}
    ws = texto.split()
    idx = [i for i, w in enumerate(ws) if w.lower() in trocas]
    rng.shuffle(idx)
    feitas = []
    for i in sorted(idx[:2]):
        feitas.append({"posicao": i, "audio": ws[i], "texto_mostrado": trocas[ws[i].lower()]})
        ws[i] = trocas[ws[i].lower()]
    return " ".join(ws), feitas


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--semente", type=int, default=20261023)
    a = ap.parse_args()
    rng = random.Random(a.semente)
    os.makedirs(os.path.join(a.out, "itens"), exist_ok=True)
    tmp = os.path.join(a.out, ".fonte")
    os.makedirs(tmp, exist_ok=True)
    tp, tc = tsv(PENDENTE[0])[PENDENTE[1]], tsv(CONTROLE[0])[CONTROLE[1]]
    fp, fc = extrai(*PENDENTE, os.path.join(tmp, "p.wav")), extrai(*CONTROLE, os.path.join(tmp, "c.wav"))
    alterado, trocas = altera(tc, rng)
    itens = [("pendente_P10", fp, tp, None), ("controle_limpo", fc, tc, []), ("controle_alterado", fc, alterado, trocas)]
    rng.shuffle(itens)
    gab, folha = {}, ["# Escuta cega — P05 (P10)", "",
                      "Ouça cada item com fone, quantas vezes quiser. Sublinhe toda palavra em que o áudio é DIFERENTE do texto",
                      "(palavra trocada, faltando ou a mais). Não converse com outros avaliadores. Avaliador: ________  Data: ______", ""]
    for letra, (papel, f, texto, esperado) in zip("ABC", itens):
        dst = os.path.join(a.out, "itens", f"{letra}.wav")
        open(dst, "wb").write(open(f, "rb").read())
        gab[letra] = {"papel": papel, "esperado": esperado, "wav_sha256": hashlib.sha256(open(dst, "rb").read()).hexdigest()}
        folha += [f"## Item {letra}", "", texto, "", "Diferenças encontradas: ____________________________", ""]
    open(os.path.join(a.out, "folha_avaliador.md"), "w", encoding="utf-8").write("\n".join(folha))
    g = os.path.join(a.out, "gabarito_SELADO.json")
    json.dump({"semente": a.semente, "itens": gab}, open(g, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("gabarito SHA-256 (registrar ANTES da escuta):", hashlib.sha256(open(g, "rb").read()).hexdigest())


if __name__ == "__main__":
    main()
