"""Local forced alignment; never guesses evenly spaced word timestamps.

A prévia real de 13/11/2026 (run 43466687957) teve 73/73 palavras corretas, mas uma com duração zero
(duracao_zero@67). Palavra instantânea vem do corte de silêncio do stable-ts. Aqui tentamos, em ordem, configurações
REAIS do próprio alinhador (nenhum tempo é calculado por nós) e ficamos com a primeira que passa em TODOS os
critérios de alignmentIssues/alignedWords (scripts/shorts-v2/core.mjs): mesma contagem e mesma sequência de palavras
normalizadas do roteiro, palavra do tipo texto, tempos numéricos finitos, início >= 0, duração > 0, dentro do áudio e
sem sobreposição maior que 20 ms (NC-1036-01). Se nenhuma passar, gravamos a última e o verificador reprova com o
motivo exato.
"""
import json, math, sys, unicodedata, wave
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


def normalized(text):
    """Mesmo critério de `normalized` em core.mjs: NFD, sem marcas, só letras/números, minúsculas."""
    decomposed = unicodedata.normalize("NFD", text)
    kept = "".join(c for c in decomposed if not unicodedata.category(c).startswith("M"))
    kept = "".join(c for c in kept if unicodedata.category(c)[0] in ("L", "N"))
    return kept.lower()


def expected_words(text):
    return [w for w in (normalized(t) for t in text.split()) if w]


def number(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def valid(result, duration, expected):
    words = [w for s in (getattr(result, "segments", None) or []) for w in (getattr(s, "words", None) or [])]
    if not words or len(words) != len(expected):
        return False
    for i, w in enumerate(words):
        text = getattr(w, "word", None)
        if not isinstance(text, str) or normalized(text) != expected[i]:
            return False
        start, end = getattr(w, "start", None), getattr(w, "end", None)
        if not (number(start) and number(end)):
            return False
        if not (start >= 0 and end > start and end <= duration):
            return False
        if i and start < words[i - 1].end - 0.02:
            return False
    return True


def main(audio, script, out):
    model = stable_whisper.load_model("base", device="cpu")
    text = Path(script).read_text(encoding="utf-8")
    duration = audio_seconds(audio)
    expected = expected_words(text)
    last = None
    for name, options in ATTEMPTS:
        result = model.align(audio, text, language="pt", **options)
        if result is None:
            print("ALIGN_ATTEMPT " + name + " none", flush=True)
            continue
        last = result
        if valid(result, duration, expected):
            print("ALIGN_ATTEMPT " + name + " ok", flush=True)
            result.save_as_json(out)
            return
        print("ALIGN_ATTEMPT " + name + " invalid", flush=True)
    if last is None:
        raise SystemExit("alignment_failed")
    last.save_as_json(out)  # o verificador reprova e informa o motivo


if __name__ == "__main__":
    main(*sys.argv[1:4])
