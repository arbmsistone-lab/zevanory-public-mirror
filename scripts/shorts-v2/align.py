"""Local forced alignment; never guesses evenly spaced word timestamps.

A prévia real de 13/11/2026 (run 43466687957) teve 73/73 palavras corretas, mas uma com duração zero
(duracao_zero@67). Palavra instantânea vem do corte de silêncio do stable-ts. Aqui tentamos, em ordem, configurações
REAIS do próprio alinhador (nenhum tempo é calculado por nós) e ficamos com a primeira que passa nos mesmos
critérios de alignedWords (scripts/shorts-v2/core.mjs): toda palavra com duração > 0, dentro do áudio e sem
sobreposição maior que 20 ms. Se nenhuma passar, gravamos a última e o verificador reprova com o motivo exato.
"""
import json, sys, wave
from pathlib import Path
import stable_whisper

ATTEMPTS = (
    ("padrao_min_word_dur", {"min_word_dur": 0.1}),
    ("fast_mode", {"min_word_dur": 0.1, "fast_mode": True}),
    ("sem_supressao_de_silencio", {"suppress_silence": False}),
)


def audio_seconds(path):
    with wave.open(path, "rb") as w:
        return w.getnframes() / float(w.getframerate())


def valid(result, duration):
    words = [w for s in result.segments for w in s.words]
    if not words:
        return False
    for i, w in enumerate(words):
        if not (w.start >= 0 and w.end > w.start and w.end <= duration):
            return False
        if i and w.start < words[i - 1].end - 0.02:
            return False
    return True


def main(audio, script, out):
    model = stable_whisper.load_model("base", device="cpu")
    text = Path(script).read_text(encoding="utf-8")
    duration = audio_seconds(audio)
    last = None
    for name, options in ATTEMPTS:
        result = model.align(audio, text, language="pt", **options)
        if result is None:
            print("ALIGN_ATTEMPT " + name + " none", flush=True)
            continue
        last = result
        if valid(result, duration):
            print("ALIGN_ATTEMPT " + name + " ok", flush=True)
            result.save_as_json(out)
            return
        print("ALIGN_ATTEMPT " + name + " invalid", flush=True)
    if last is None:
        raise SystemExit("alignment_failed")
    last.save_as_json(out)  # o verificador reprova e informa o motivo


if __name__ == "__main__":
    main(*sys.argv[1:4])
