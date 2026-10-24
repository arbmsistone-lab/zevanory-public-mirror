#!/usr/bin/env python3
"""P05 — gerador determinístico do desenho da prova cega (NÃO executa a prova; só produz a planilha de alocação).

Desenho: 12 roteiros × 6 condições = 72 clipes. Dois blocos complementares (A/B) de 36 clipes: no bloco A o
roteiro s recebe as condições {(s+0),(s+2),(s+4)} mod 6 e no bloco B {(s+1),(s+3),(s+5)} mod 6. Cada bloco tem
cada roteiro 3× e cada condição 6×. Ouvintes alternam A/B; com 48 ouvintes válidos cada clipe recebe 24 notas.
A ordem de cada sessão é aleatória (semente por ouvinte), sem o mesmo roteiro em sequência e sem a mesma condição
três vezes seguidas. Cada sessão recebe 2 clipes-armadilha (P.808: "marque a nota N") e 1 clipe repetido
(consistência). Ouvinte reprovado é substituído por outro na MESMA linha do desenho (o balanço se mantém).

Uso: desenho.py --ouvintes 64 --semente 20261022 --saida alocacao.csv
"""
import argparse, csv, hashlib, json, os, random

CONDICOES = ["C1_humano_referencia_oculta", "C2_gemini_3_8_flash_tts_persona", "C3_google_chirp3_hd_ptbr",
             "C4_azure_dragonhd_ptbr", "C5_elevenlabs_v3", "C6_piper_faber_medium_ancora"]


def blocos(n_roteiros=12, n_cond=6):
    a = [(s, (s + k) % n_cond) for s in range(n_roteiros) for k in (0, 2, 4)]
    b = [(s, (s + k) % n_cond) for s in range(n_roteiros) for k in (1, 3, 5)]
    return a, b


def ordem(itens, rng, tentativas=10000):
    for _ in range(tentativas):
        x = itens[:]
        rng.shuffle(x)
        ok = all(x[i][0] != x[i + 1][0] for i in range(len(x) - 1))
        ok = ok and all(not (x[i][1] == x[i + 1][1] == x[i + 2][1]) for i in range(len(x) - 2))
        if ok:
            return x
    raise RuntimeError("sem ordem válida")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ouvintes", type=int, default=64)
    ap.add_argument("--semente", type=int, default=20261022)
    ap.add_argument("--saida", default="alocacao.csv")
    a = ap.parse_args()
    roteiros = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "roteiros.json"), encoding="utf-8"))["roteiros"]
    A, B = blocos(len(roteiros), len(CONDICOES))
    for blk in (A, B):
        assert len(blk) == 36 and all(sum(1 for s, c in blk if c == k) == 6 for k in range(6))
        assert all(sum(1 for s, c in blk if s == r) == 3 for r in range(12))
    assert sorted(A + B) == sorted((s, c) for s in range(12) for c in range(6))
    with open(a.saida, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["ouvinte", "bloco", "posicao", "tipo", "roteiro", "condicao", "clip_id", "nota_alvo_armadilha"])
        for o in range(a.ouvintes):
            rng = random.Random(f"{a.semente}:{o}")
            blk = A if o % 2 == 0 else B
            seq = [("clip", s, c) for s, c in ordem(blk, rng)]
            rep = seq[rng.randrange(4, 12)]
            seq.insert(rng.randrange(28, 34), ("repeticao", rep[1], rep[2]))
            for alvo, pos in ((rng.choice([1, 2, 4, 5]), rng.randrange(8, 14)), (rng.choice([1, 2, 4, 5]), rng.randrange(20, 26))):
                seq.insert(pos, ("armadilha", None, None, alvo))
            for i, it in enumerate(seq, 1):
                if it[0] == "armadilha":
                    w.writerow([f"L{o + 1:03d}", "AB"[o % 2], i, "armadilha", "", "", f"TRAP{it[3]}", it[3]])
                else:
                    s, c = it[1], it[2]
                    clip = "clip_" + hashlib.sha256(f"{roteiros[s]['id']}|{CONDICOES[c]}|cego".encode()).hexdigest()[:10]
                    w.writerow([f"L{o + 1:03d}", "AB"[o % 2], i, it[0], roteiros[s]["id"], CONDICOES[c], clip, ""])
    print(f"ok: {a.ouvintes} ouvintes, 72 clipes, blocos A/B de 36 (+2 armadilhas +1 repetição) -> {a.saida}")


if __name__ == "__main__":
    main()
