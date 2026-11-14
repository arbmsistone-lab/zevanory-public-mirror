"""Local forced alignment; never guesses evenly spaced word timestamps.

A prévia real de 13/11/2026 (run 43466687957) teve 73/73 palavras corretas, mas uma com duração zero
(duracao_zero@67). Palavra instantânea vem do corte de silêncio do stable-ts. Aqui tentamos, em ordem, configurações
REAIS do próprio alinhador (nenhum tempo é calculado por nós) e ficamos com a primeira que passa em TODOS os
critérios de alignmentIssues/alignedWords (scripts/shorts-v2/core.mjs): mesma contagem e mesma sequência de palavras
normalizadas do roteiro, palavra do tipo texto, tempos numéricos finitos, início >= 0, duração > 0, dentro do áudio e
sem sobreposição maior que 20 ms (NC-1036-01). Se nenhuma passar, gravamos a última e o verificador reprova com o
motivo exato.

Prévia real v3 de 13/11/2026 (run 43533242090): "venda: um tênis" deu duracao_zero@11 em todas as 5 tentativas acima.
O artigo curto logo após a pausa do ":" cai na borda do trecho de não-fala que o alinhador pula (nonspeech_skip),
então acrescentamos, DEPOIS das cinco existentes, configurações reais que não pulam a não-fala e o modelo "small"
(DTW de atenção mais fino; carregado só se as anteriores falharem, sem custo de API). Continua sem nenhum tempo nosso.
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


def issue(result, duration, expected):
    """Primeiro problema pelos critérios de alignedWords, ou None. Sem conteúdo de palavra (só tipo, índice e tempos)."""
    words = [w for s in (getattr(result, "segments", None) or []) for w in (getattr(s, "words", None) or [])]
    if not words or len(words) != len(expected):
        return "contagem:%d/%d" % (len(words), len(expected))
    for i, w in enumerate(words):
        text = getattr(w, "word", None)
        if not isinstance(text, str):
            return "tipo_palavra@%d" % i
        if normalized(text) != expected[i]:
            return "palavra@%d" % i
        start, end = getattr(w, "start", None), getattr(w, "end", None)
        if not (number(start) and number(end)) or start < 0:
            return "tempo@%d" % i
        if not end > start:
            return "duracao_zero@%d:%.2f-%.2f" % (i, start, end)
        if end > duration:
            return "apos_fim@%d:%.2f>%.2f" % (i, end, duration)
        if i and start < words[i - 1].end - 0.02:
            return "sobreposicao@%d:%.2f<%.2f" % (i, start, words[i - 1].end)
    return None


def valid(result, duration, expected):
    return issue(result, duration, expected) is None


def attempts(model, audio, text, state):
    """Configurações REAIS do stable-ts, em ordem. A última refina (model.refine) o resultado padrão: o próprio
    alinhador reavalia os tempos no áudio; nada é calculado por nós."""
    steps = [(name, (lambda o=options: model.align(audio, text, language="pt", **o))) for name, options in ATTEMPTS]
    steps.append(("vad", lambda: model.align(audio, text, language="pt", min_word_dur=0.1, vad=True)))
    steps.append(("refinado", lambda: model.refine(audio, state["first"], inplace=False) if state.get("first") is not None and hasattr(model, "refine") else None))
    steps.append(("sem_pulo_de_nao_fala", lambda: model.align(audio, text, language="pt", min_word_dur=0.1, nonspeech_skip=None)))
    steps.append(("sem_pulo_sem_supressao", lambda: model.align(audio, text, language="pt", nonspeech_skip=None, suppress_silence=False)))

    def small():
        if "small" not in state:
            state["small"] = stable_whisper.load_model("small", device="cpu")
        return state["small"]
    steps.append(("modelo_small", lambda: small().align(audio, text, language="pt", min_word_dur=0.1)))
    steps.append(("modelo_small_sem_pulo", lambda: small().align(audio, text, language="pt", min_word_dur=0.1, nonspeech_skip=None)))
    return steps


def main(audio, script, out):
    model = stable_whisper.load_model("base", device="cpu")
    text = Path(script).read_text(encoding="utf-8")
    duration = audio_seconds(audio)
    expected = expected_words(text)
    last, state = None, {}
    for name, run in attempts(model, audio, text, state):
        try:
            result = run()
        except Exception as error:  # opção não suportada pela versão instalada: registra e segue
            print("ALIGN_ATTEMPT " + name + " erro " + type(error).__name__, flush=True)
            continue
        if result is None:
            print("ALIGN_ATTEMPT " + name + " none", flush=True)
            continue
        state.setdefault("first", result)
        last = result
        problem = issue(result, duration, expected)
        if problem is None:
            print("ALIGN_ATTEMPT " + name + " ok", flush=True)
            result.save_as_json(out)
            return
        print("ALIGN_ATTEMPT " + name + " invalid " + problem, flush=True)
    if last is None:
        raise SystemExit("alignment_failed")
    last.save_as_json(out)  # o verificador reprova e informa o motivo


if __name__ == "__main__":
    main(*sys.argv[1:4])
