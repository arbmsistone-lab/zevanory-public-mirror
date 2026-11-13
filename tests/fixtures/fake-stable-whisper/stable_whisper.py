"""Alinhador falso para testar scripts/shorts-v2/align.py sem baixar modelo (cenário via FAKE_ALIGN_SCENARIO)."""
import json, os

class W:
    def __init__(self, word, start, end): self.word, self.start, self.end = word, start, end

class S:
    def __init__(self, words): self.words = words

class R:
    def __init__(self, words, options): self.segments, self.options = [S(words)], options
    def save_as_json(self, path):
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"segments": [{"words": [{"word": w.word, "start": w.start, "end": w.end} for w in self.segments[0].words]}], "fake_options": self.options}, f)

class M:
    def align(self, audio, text, language=None, **options):
        scenario = json.loads(os.environ["FAKE_ALIGN_SCENARIO"])
        key = "vad" if options.get("vad") else "fast" if options.get("fast_mode") else "nosup" if options.get("suppress_silence") is False else "default"
        if scenario.get("raise") == key: raise TypeError("opcao_nao_suportada")
        rows = scenario.get(key)
        if rows is None: return None
        return R([W(*r) for r in rows], options)

    def refine(self, audio, result, inplace=True, **options):
        scenario = json.loads(os.environ["FAKE_ALIGN_SCENARIO"])
        rows = scenario.get("refine")
        if rows is None: return None
        return R([W(*r) for r in rows], {"refine_of": result.options})

def load_model(name, device=None): return M()
