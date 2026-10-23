#!/usr/bin/env python3
"""ZEVANORY | zevanory-av-gate (P05) — gate perceptivo e técnico de vídeo com narração, fail-closed.

Implementa os critérios V1–V8 do Sol sobre o ARTEFATO FINAL (MP4/AAC) antes de qualquer upload:
  V1 artefatos e manifesto (roteiro, master WAV, MP4, legendas, voz única da marca, hashes)
  V2 fidelidade por ASR com 2 motores independentes de famílias diferentes (faster-whisper / Vosk-Kaldi),
     WER/CER, termos críticos (número, preço, marca, negação), vazamento de instrução de estilo,
     CTA/preço de compra com VENDAS FECHADAS
  V3 BS.1770 (ffmpeg ebur128, true peak) no master e no MP4 final, amostras clipadas, densidade de clipping,
     ruído de fundo, SNR, presença de fala (VAD), espectro/tonalidade (tom puro, ruído, bipes)
  V4 taxa de fala global e por janela de 10 s, pausas, F0/energia (nem plana nem excessiva), HNR,
     identidade do locutor (x-vector) contra a referência da voz da marca
  V5 MOS preditivo (DNSMOS P.835) — SÓ FILTRO; quem decide é o painel humano cego (docs/p05)
  V6 sincronia A/V (offset de contêiner + deriva legenda×fala, p95/máx)
  V7 legendas (texto = fala, formato, tempo), contraste WCAG, área segura, quadros pretos
  V8 regressão: controles negativos/positivos e mutantes (scripts/av_gate/controls.py)

Saída tipada: PASS | FAIL | BLOCKED | ERROR_INFRA. Métrica ausente = BLOCKED; ferramenta com erro = ERROR_INFRA.
Nunca PASS por omissão. Código de saída: 0 PASS, 1 FAIL, 2 BLOCKED, 3 ERROR_INFRA.

Uso:
  zevanory_av_gate.py package --raw voz.wav --script roteiro.txt --out DIR [--tail 1.0]
  zevanory_av_gate.py check --mp4 final.mp4 --manifest manifest.json --out relatorio.json [--profile production]
"""
import argparse, hashlib, json, math, os, re, shutil, subprocess, sys, tempfile, unicodedata
from difflib import SequenceMatcher

try:
    import numpy as np
except ImportError:  # explicit, typed failure instead of a crash: the gate never "passes" without its tools
    print('{"verdict": "ERROR_INFRA", "error": "TOOL_MISSING:numpy"}')
    print("::error title=AV_GATE::ERROR_INFRA TOOL_MISSING:numpy (pip install -r scripts/av_gate/requirements.txt)")
    sys.exit(3)

HERE = os.path.dirname(os.path.abspath(__file__))
GATE_VERSION = "p05-av-gate-1"
# The gate NEVER gives final acceptance: predicted MOS (DNSMOS ≥ 2.2) is only a provisional REJECTION floor
# (AVAL 098). A clip that passes every automatic check is PASS_TECH_PENDING_HUMAN and needs a human approval
# record for exactly its bytes before it can be published (see youtube-daily-short.mjs, humanApproved).
VERDICTS = ("PASS_TECH_PENDING_HUMAN", "FAIL", "BLOCKED", "ERROR_INFRA")
EXIT = {"PASS_TECH_PENDING_HUMAN": 4, "PASS": 0, "FAIL": 1, "BLOCKED": 2, "ERROR_INFRA": 3}
SR = 16000


class InfraError(Exception):
    pass


def load_thresholds(path=None):
    with open(path or os.path.join(HERE, "thresholds.json"), encoding="utf-8") as f:
        return json.load(f)


# ----------------------------------------------------------------------------------------------- utilities
def sh(args, check=True, text=True, input=None):
    try:
        p = subprocess.run(args, capture_output=True, text=text, input=input)
    except FileNotFoundError as e:
        raise InfraError(f"TOOL_MISSING:{args[0]}") from e
    if check and p.returncode != 0:
        tail = (p.stderr if text else p.stderr.decode("utf-8", "replace"))[-400:]
        raise InfraError(f"{args[0]}_failed:{tail}")
    return p


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def decode(path, sr=SR, stream="a:0"):
    """Decode the first audio stream to mono float32 at `sr` (sample 0 = first audio sample)."""
    p = sh(["ffmpeg", "-nostdin", "-v", "error", "-i", path, "-map", stream, "-ac", "1", "-ar", str(sr),
            "-f", "f32le", "-"], text=False)
    return np.frombuffer(p.stdout, dtype="<f4").astype(np.float64)


def write_wav(path, x, sr, codec="pcm_s24le"):
    x = np.asarray(x, dtype="<f4")
    sh(["ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "f32le", "-ar", str(sr), "-ac", "1", "-i", "-",
        "-c:a", codec, path], text=False, input=x.tobytes())


def probe(path):
    p = sh(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", path])
    return json.loads(p.stdout)


def ebur128(path, stream="a:0"):
    """Integrated loudness (LUFS), LRA and true peak (dBTP) per ITU-R BS.1770 via ffmpeg ebur128 (peak=true)."""
    p = sh(["ffmpeg", "-nostdin", "-hide_banner", "-nostats", "-i", path, "-map", stream, "-af",
            "ebur128=peak=true:framelog=quiet", "-f", "null", "-"])
    err = p.stderr
    summ = err[err.rfind("Summary:"):] if "Summary:" in err else err
    num = r"(-?inf|-?[\d.]+)"
    mi = re.search(r"I:\s+" + num + r" LUFS", summ)
    mp = re.search(r"True peak:\s*\n\s*Peak:\s+" + num + r" dBFS", summ)
    ml = re.search(r"LRA:\s+" + num + r" LU", summ)
    if not mi or not mp:
        raise InfraError("ebur128_unparsed")
    f = lambda m: float(m.group(1).replace("inf", "inf")) if m else None
    return {"lufs": f(mi), "tp": f(mp), "lra": f(ml)}


def fmt_ts(t):
    t = max(0.0, t)
    h, rem = divmod(t, 3600)
    m, s = divmod(rem, 60)
    return f"{int(h):02d}:{int(m):02d}:{s:06.3f}"


# ------------------------------------------------------------------------------------- pt-BR normalisation
_U = ["zero", "um", "dois", "tres", "quatro", "cinco", "seis", "sete", "oito", "nove", "dez", "onze", "doze", "treze",
      "catorze", "quinze", "dezesseis", "dezessete", "dezoito", "dezenove"]
_T = ["", "", "vinte", "trinta", "quarenta", "cinquenta", "sessenta", "setenta", "oitenta", "noventa"]
_H = ["", "cento", "duzentos", "trezentos", "quatrocentos", "quinhentos", "seiscentos", "setecentos", "oitocentos",
      "novecentos"]
NUMBER_WORDS = set(_U + _T[2:] + _H[1:] + ["cem", "mil", "milhao", "milhoes", "bilhao", "bilhoes", "reais", "real",
                                            "centavos", "virgula", "quatorze", "duas", "duzentas", "trezentas"])
NUMBER_WORDS.discard("")


def spell_int(n):
    """Cardinal number in pt-BR words (no accents), 0..999_999_999."""
    n = int(n)
    if n < 20:
        return _U[n]
    if n < 100:
        t, u = divmod(n, 10)
        return _T[t] + ("" if u == 0 else " e " + _U[u])
    if n < 1000:
        if n == 100:
            return "cem"
        h, r = divmod(n, 100)
        return _H[h] + ("" if r == 0 else " e " + spell_int(r))
    if n < 1_000_000:
        k, r = divmod(n, 1000)
        head = "mil" if k == 1 else spell_int(k) + " mil"
        if r == 0:
            return head
        return head + (" e " if (r < 100 or r % 100 == 0) else " ") + spell_int(r)
    if n < 1_000_000_000:
        m, r = divmod(n, 1_000_000)
        head = ("um milhao" if m == 1 else spell_int(m) + " milhoes")
        if r == 0:
            return head
        return head + (" e " if (r < 100 or r % 100 == 0) else " ") + spell_int(r)
    return " ".join(spell_int(int(d)) for d in str(n))


def strip_accents(s):
    return "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))


def normalize_tokens(text, lexicon=None, mark=False):
    """Normalise pt-BR text for WER: lower case, money/percent/URL/number expansion, no accents, no punctuation.
    With mark=True returns (tokens, flags) where flags[i] is True when the token came from a written number."""
    s = unicodedata.normalize("NFKC", str(text)).lower()
    s = s.replace("&", " e ")
    s = re.sub(r"https?://", " ", s)
    s = re.sub(r"\bwww\.", " ", s)
    s = re.sub(r"r\$\s?(\d[\d.]*)(?:,(\d{2}))?", lambda m: f" {m.group(1)} reais" + (
        "" if not m.group(2) or m.group(2) == "00" else f" e {m.group(2)} centavos"), s)
    s = re.sub(r"(\d+)\s?%", r"\1 por cento", s)
    s = re.sub(r"(\d)\.(\d{3})\b", r"\1\2", s)
    s = re.sub(r"(\d+),(\d+)", r"\1 virgula \2", s)
    s = re.sub(r"([a-z0-9])\.([a-z])", r"\1 ponto \2", s)  # domains: zevanory.api.br
    s = s.replace("/", " barra ")
    out, flags = [], []
    for piece in re.split(r"(\d+)", s):
        if piece.isdigit():
            ws = spell_int(piece).split()
            out += ws
            flags += [True] * len(ws)
        else:
            ws = re.sub(r"[^a-z0-9 ]+", " ", strip_accents(piece).replace("-", " ")).split()
            out += ws
            flags += [False] * len(ws)
    out = ["catorze" if w == "quatorze" else w for w in out]
    if lexicon:
        joined = " " + " ".join(out) + " "
        for canon, variants in lexicon.items():
            c = " ".join(normalize_tokens(canon))
            for v in sorted(variants, key=len, reverse=True):
                vv = " ".join(normalize_tokens(v))
                if vv and vv != c:
                    joined = joined.replace(" " + vv + " ", " " + c + " ")
        new = joined.split()
        if len(new) != len(out):
            flags = [False] * len(new)
        out = new
    return (out, flags) if mark else out


# ------------------------------------------------------------------------------------------ alignment / WER
def edit_ops(ref, hyp):
    """Levenshtein alignment with backtrace: list of (op, i, j) with op in equal/sub/del/ins."""
    n, m = len(ref), len(hyp)
    d = np.zeros((n + 1, m + 1), dtype=np.int32)
    d[:, 0] = np.arange(n + 1)
    d[0, :] = np.arange(m + 1)
    for i in range(1, n + 1):
        ri = ref[i - 1]
        for j in range(1, m + 1):
            c = 0 if ri == hyp[j - 1] else 1
            d[i, j] = min(d[i - 1, j] + 1, d[i, j - 1] + 1, d[i - 1, j - 1] + c)
    ops, i, j = [], n, m
    while i > 0 or j > 0:
        if i > 0 and j > 0 and d[i, j] == d[i - 1, j - 1] + (0 if ref[i - 1] == hyp[j - 1] else 1):
            ops.append(("equal" if ref[i - 1] == hyp[j - 1] else "sub", i - 1, j - 1))
            i, j = i - 1, j - 1
        elif i > 0 and d[i, j] == d[i - 1, j] + 1:
            ops.append(("del", i - 1, None))
            i -= 1
        else:
            ops.append(("ins", i, j - 1))  # insertion before ref index i
            j -= 1
    return ops[::-1]


def wer(ref, hyp):
    if not ref:
        return 0.0 if not hyp else 1.0
    return sum(1 for o in edit_ops(ref, hyp) if o[0] != "equal") / len(ref)


def cer(ref_tokens, hyp_tokens):
    r, h = list(" ".join(ref_tokens)), list(" ".join(hyp_tokens))
    if not r:
        return 0.0 if not h else 1.0
    return sum(1 for o in edit_ops(r, h) if o[0] != "equal") / len(r)


def engine_view(ref, hyp):
    matched, sub, ins = [False] * len(ref), [None] * len(ref), {}
    for op, i, j in edit_ops(ref, hyp):
        if op == "equal":
            matched[i] = True
        elif op == "sub":
            sub[i] = hyp[j]
        elif op == "ins":
            ins.setdefault(i, []).append(hyp[j])
    return matched, sub, ins


def consensus(ref, hyp_a, hyp_b):
    """Consensus hypothesis of two independent engines: a script word is an error only if NEITHER engine heard it;
    an insertion counts only if BOTH engines inserted words in the same gap."""
    ma, sa, ia = engine_view(ref, hyp_a)
    mb, sb, ib = engine_view(ref, hyp_b)
    cons, cons_ins = [], []
    for i in range(len(ref) + 1):
        if i in ia and i in ib:
            k = min(len(ia[i]), len(ib[i]))
            cons += ia[i][:k]
            cons_ins += ia[i][:k]
        if i == len(ref):
            break
        if ma[i] or mb[i]:
            cons.append(ref[i])
        elif sa[i] is not None:
            cons.append(sa[i])
        elif sb[i] is not None:
            cons.append(sb[i])
    heard = [a or b for a, b in zip(ma, mb)]
    return cons, heard, cons_ins


def script_word_times(ref, words):
    """Times for every script token from engine-B word timings (matched tokens), interpolated otherwise.
    Returns (times[(start,end)], direct[bool])."""
    hyp = [w["w"] for w in words]
    times, direct = [None] * len(ref), [False] * len(ref)
    sm = SequenceMatcher(None, ref, hyp, autojunk=False)
    for a, b, size in sm.get_matching_blocks():
        for k in range(size):
            w = words[b + k]
            times[a + k] = (w["start"], w["end"])
            direct[a + k] = True
    known = [i for i, t in enumerate(times) if t]
    if not known:
        return None, direct
    for i in range(len(ref)):
        if times[i]:
            continue
        prev = max([k for k in known if k < i], default=None)
        nxt = min([k for k in known if k > i], default=None)
        if prev is None:
            t = times[nxt][0]
            times[i] = (max(0.0, t - 0.3 * (nxt - i)), max(0.0, t - 0.3 * (nxt - i) + 0.25))
        elif nxt is None:
            t = times[prev][1]
            times[i] = (t + 0.3 * (i - prev - 1), t + 0.3 * (i - prev))
        else:
            a, b = times[prev][1], times[nxt][0]
            span = (b - a) / (nxt - prev)
            times[i] = (a + span * (i - prev - 1), a + span * (i - prev))
    return times, direct


# ------------------------------------------------------------------------------------------------- engines
class Engines:
    """Lazy, cached ASR/VAD/prosody/MOS back-ends. Any missing back-end raises InfraError (=> ERROR_INFRA)."""

    def __init__(self, whisper_model=None, vosk_model=None, vosk_spk=None, dnsmos=None, models_dir=None):
        md = models_dir or os.environ.get("AV_GATE_MODELS", os.path.join(HERE, ".models"))
        self.whisper_name = whisper_model or os.environ.get("AV_GATE_WHISPER_MODEL", "small")
        self.whisper_dir = os.path.join(md, "whisper")
        # Engine B: the LARGE Vosk/Kaldi pt-BR model (non-Whisper family). The small model only hosts x-vectors.
        self.vosk_path = vosk_model or os.environ.get("AV_GATE_VOSK_MODEL", os.path.join(md, "vosk-model-pt-fb-v0.1.1-20220516_2113"))
        self.vosk_small_path = os.environ.get("AV_GATE_VOSK_SMALL", os.path.join(md, "vosk-model-small-pt-0.3"))
        self.spk_path = vosk_spk or os.environ.get("AV_GATE_VOSK_SPK", os.path.join(md, "vosk-model-spk-0.4"))
        self.dnsmos_path = dnsmos or os.environ.get("AV_GATE_DNSMOS", os.path.join(md, "dnsmos", "sig_bak_ovr.onnx"))
        self._w = self._v = self._s = self._d = self._vs = None

    def describe(self):
        def ver(mod):
            try:
                return __import__(mod).__version__
            except Exception:
                return None
        return {"engine_a": f"faster-whisper:{self.whisper_name}", "engine_a_version": ver("faster_whisper"),
                "engine_b": f"vosk-kaldi:{os.path.basename(self.vosk_path)}", "engine_b_version": ver("vosk"),
                "speaker": f"vosk-xvector:{os.path.basename(self.spk_path)}",
                "mos": f"dnsmos-p835:{os.path.basename(self.dnsmos_path)}"}

    # engine A — Whisper family (CTranslate2)
    def asr_a(self, x16):
        try:
            if self._w is None:
                from faster_whisper import WhisperModel
                self._w = WhisperModel(self.whisper_name, device="cpu", compute_type="int8",
                                       download_root=self.whisper_dir, cpu_threads=os.cpu_count() or 2)
            segs, _ = self._w.transcribe(x16.astype(np.float32), language="pt", beam_size=5, temperature=0.0,
                                         condition_on_previous_text=False, vad_filter=False)
            return " ".join(s.text.strip() for s in segs).strip()
        except InfraError:
            raise
        except Exception as e:
            raise InfraError(f"engine_a:{type(e).__name__}:{str(e)[:160]}")

    def _vosk(self):
        try:
            import vosk
            vosk.SetLogLevel(-1)
            if self._v is None:
                if not os.path.isdir(self.vosk_path):
                    raise InfraError("engine_b_model_missing")
                self._v = vosk.Model(self.vosk_path)
            return vosk
        except InfraError:
            raise
        except Exception as e:
            raise InfraError(f"engine_b:{type(e).__name__}:{str(e)[:160]}")

    # engine B — Kaldi family (Vosk), with word timings
    def asr_b(self, x16):
        vosk = self._vosk()
        try:
            rec = vosk.KaldiRecognizer(self._v, SR)
            rec.SetWords(True)
            pcm = (np.clip(x16, -1, 1) * 32767).astype("<i2").tobytes()
            res = []
            for k in range(0, len(pcm), 8000):
                if rec.AcceptWaveform(pcm[k:k + 8000]):
                    res.append(json.loads(rec.Result()))
            res.append(json.loads(rec.FinalResult()))
            words = [{"w": w["word"], "start": float(w["start"]), "end": float(w["end"])}
                     for r in res for w in r.get("result", [])]
            text = " ".join(r.get("text", "") for r in res).strip()
            return text, words
        except Exception as e:
            raise InfraError(f"engine_b:{type(e).__name__}:{str(e)[:160]}")

    def xvector(self, x16):
        vosk = self._vosk()
        try:
            if self._s is None:
                if not os.path.isdir(self.spk_path):
                    raise InfraError("speaker_model_missing")
                self._s = vosk.SpkModel(self.spk_path)
            if self._vs is None:
                if not os.path.isdir(self.vosk_small_path):
                    raise InfraError("speaker_host_model_missing")
                self._vs = vosk.Model(self.vosk_small_path)
            rec = vosk.KaldiRecognizer(self._vs, SR)
            rec.SetSpkModel(self._s)
            pcm = (np.clip(x16, -1, 1) * 32767).astype("<i2").tobytes()
            res = []
            for k in range(0, len(pcm), 8000):
                if rec.AcceptWaveform(pcm[k:k + 8000]):
                    res.append(json.loads(rec.Result()))
            res.append(json.loads(rec.FinalResult()))
            vecs = [(np.array(r["spk"]), r.get("spk_frames", 1)) for r in res if r.get("spk")]
            if not vecs:
                return None
            v = sum(a * w for a, w in vecs) / sum(w for _, w in vecs)
            return v / (np.linalg.norm(v) + 1e-12)
        except InfraError:
            raise
        except Exception as e:
            raise InfraError(f"speaker:{type(e).__name__}:{str(e)[:160]}")

    def dnsmos(self, x16):
        try:
            import onnxruntime as ort
            if self._d is None:
                if not os.path.isfile(self.dnsmos_path):
                    raise InfraError("dnsmos_model_missing")
                self._d = ort.InferenceSession(self.dnsmos_path, providers=["CPUExecutionProvider"])
            L = int(9.01 * SR)
            a = x16.astype(np.float32)
            if len(a) == 0:
                return None
            while len(a) < L:
                a = np.concatenate([a, a])
            hops = int(np.floor(len(a) / SR) - 9.01) + 1
            name = self._d.get_inputs()[0].name
            sig, bak, ovr = [], [], []
            for k in range(max(1, hops)):
                seg = a[k * SR:k * SR + L]
                if len(seg) < L:
                    continue
                s, b, o = self._d.run(None, {name: seg[np.newaxis, :]})[0][0]
                sig.append(np.poly1d([-0.08397278, 1.22083953, 0.0052439])(s))
                bak.append(np.poly1d([-0.13166888, 1.60915514, -0.39604546])(b))
                ovr.append(np.poly1d([-0.06766283, 1.11546468, 0.04602535])(o))
            return {"sig": float(np.mean(sig)), "bak": float(np.mean(bak)), "ovrl": float(np.mean(ovr))}
        except InfraError:
            raise
        except Exception as e:
            raise InfraError(f"dnsmos:{type(e).__name__}:{str(e)[:160]}")


# ---------------------------------------------------------------------------------------------- VAD / frames
FRAME = 0.03


def frame_db(x16):
    n = int(FRAME * SR)
    k = len(x16) // n
    if k == 0:
        return np.zeros(0)
    fr = x16[:k * n].reshape(k, n)
    rms = np.sqrt(np.mean(fr ** 2, axis=1))
    return 20 * np.log10(np.maximum(rms, 1e-6))


def vad_frames(x16):
    """webrtcvad (aggressiveness 2, 30 ms) AND an energy gate; gaps < 120 ms filled, bursts < 90 ms dropped."""
    try:
        import webrtcvad
    except Exception as e:
        raise InfraError(f"TOOL_MISSING:webrtcvad:{type(e).__name__}")
    n = int(FRAME * SR)
    db = frame_db(x16)
    if len(db) == 0:
        return np.zeros(0, dtype=bool), db
    v = webrtcvad.Vad(2)
    pcm = (np.clip(x16, -1, 1) * 32767).astype("<i2")
    gate = max(np.percentile(db, 95) - 40.0, -60.0)
    sp = np.array([v.is_speech(pcm[i * n:(i + 1) * n].tobytes(), SR) and db[i] > gate for i in range(len(db))])
    # fill short gaps, drop short bursts
    i = 0
    while i < len(sp):
        if not sp[i]:
            j = i
            while j < len(sp) and not sp[j]:
                j += 1
            if 0 < i and j < len(sp) and (j - i) * FRAME < 0.12:
                sp[i:j] = True
            i = j
        else:
            i += 1
    i = 0
    while i < len(sp):
        if sp[i]:
            j = i
            while j < len(sp) and sp[j]:
                j += 1
            if (j - i) * FRAME < 0.09:
                sp[i:j] = False
            i = j
        else:
            i += 1
    return sp, db


def segments(sp):
    segs, i = [], 0
    while i < len(sp):
        if sp[i]:
            j = i
            while j < len(sp) and sp[j]:
                j += 1
            segs.append((i * FRAME, j * FRAME))
            i = j
        else:
            i += 1
    return segs


def speech_span(x16):
    sp, _ = vad_frames(x16)
    segs = segments(sp)
    return (segs[0][0], segs[-1][1]) if segs else None


# --------------------------------------------------------------------------------------------- measurements
def m_spectral(x16, sp):
    n = 512
    hop = int(FRAME * SR)
    win = np.hanning(n)
    freqs = np.fft.rfftfreq(n, 1 / SR)
    band = (freqs >= 80) & (freqs <= 7600)
    flats, specs = [], []
    for i in np.nonzero(sp)[0]:
        seg = x16[i * hop:i * hop + n]
        if len(seg) < n:
            continue
        p = np.abs(np.fft.rfft(seg * win)) ** 2
        p = p[band] + 1e-12
        flats.append(float(np.exp(np.mean(np.log(p))) / np.mean(p)))
        specs.append(p)
    if not specs:
        return None
    # Tonality = PERSISTENCE of a narrow spectral peak over time (400–7600 Hz): a tone, beep or whine stays in the
    # same bin in most speech frames; speech harmonics move with F0 (k·ΔF0) and never persist. Independent of
    # the speaker's F0 (the former LTAS peak ratio penalised female voices).
    N = 1024
    w1 = np.hanning(N)
    f1 = np.fft.rfftfreq(N, 1 / SR)
    b1 = (f1 >= 400) & (f1 <= 7600)
    counts, total = np.zeros(int(np.sum(b1))), 0
    for i in np.nonzero(sp)[0]:
        seg = x16[i * hop:i * hop + N]
        if len(seg) < N:
            continue
        pdb = 10 * np.log10((np.abs(np.fft.rfft(seg * w1)) ** 2)[b1] + 1e-12)
        floor = np.median(np.lib.stride_tricks.sliding_window_view(np.pad(pdb, 15, mode="edge"), 31), axis=1)
        pk = np.zeros(len(pdb), dtype=bool)
        pk[1:-1] = (pdb[1:-1] >= pdb[:-2]) & (pdb[1:-1] >= pdb[2:]) & (pdb[1:-1] - floor[1:-1] >= 12)
        counts += pk
        total += 1
    tonal = float(counts.max() / total) if total else 0.0
    return {"spectral_flatness": float(np.median(flats)), "tonal_persistence": float(min(1.0, tonal))}


def m_prosody(x16, sp):
    try:
        import parselmouth
    except Exception as e:
        raise InfraError(f"TOOL_MISSING:parselmouth:{type(e).__name__}")
    snd = parselmouth.Sound(x16.astype(np.float64), sampling_frequency=SR)
    pitch = snd.to_pitch(time_step=0.01, pitch_floor=70.0, pitch_ceiling=500.0)
    f0 = pitch.selected_array["frequency"]
    times = pitch.xs()
    hnr = snd.to_harmonicity_cc(time_step=0.01, minimum_pitch=70.0)
    hv = hnr.values[0]
    htimes = hnr.xs()

    def in_speech(t):
        k = int(t / FRAME)
        return 0 <= k < len(sp) and bool(sp[k])
    voiced = np.array([f for f, t in zip(f0, times) if f > 0 and in_speech(t)])
    speech_pitch_frames = sum(1 for t in times if in_speech(t))
    out = {"voiced_fraction": (len(voiced) / speech_pitch_frames) if speech_pitch_frames else 0.0}
    if len(voiced) >= 20:
        st = 12 * np.log2(voiced / np.median(voiced))
        st = st[np.abs(st) <= 12]
        out["f0_sd_st"] = float(np.std(st)) if len(st) >= 20 else None
        out["f0_median_hz"] = float(np.median(voiced))
    else:
        out["f0_sd_st"] = None
    hs = [h for h, t in zip(hv, htimes) if h > -100 and in_speech(t)]
    out["hnr_db"] = float(np.mean(hs)) if hs else None
    return out


def m_audio_timeline(x16, sp, db):
    segs = segments(sp)
    if not segs:
        return {"speech_s": 0.0, "segments": 0}
    on, off = segs[0][0], segs[-1][1]
    gaps = [(b[0] - a[1]) * 1000 for a, b in zip(segs, segs[1:])]
    pauses = [g for g in gaps if g >= 150]
    speech_s = float(np.sum(sp) * FRAME)
    k0, k1 = int(max(0.0, on - 0.5) / FRAME), int(off / FRAME)
    ns = [db[k] for k in range(k0, min(k1, len(db))) if not sp[k] and db[k] > -115]
    sp_db = db[sp]
    if len(ns) >= 5:
        noise = float(np.percentile(ns, 20))
    else:
        rest = [d for k, d in enumerate(db) if not sp[k]]
        noise = float(np.percentile(rest, 20)) if rest else None
    lvl = float(np.median(sp_db)) if len(sp_db) else None
    return {"speech_s": speech_s, "segments": len(segs), "first_onset_s": on, "last_offset_s": off,
            "speech_ratio": speech_s / max(1e-6, off - on), "pauses_ms": [round(p) for p in pauses],
            "pause_max_ms": max(gaps) if gaps else 0.0, "pause_median_ms": float(np.median(pauses)) if pauses else None,
            "noise_floor_dbfs": noise, "speech_level_dbfs": lvl,
            "snr_db": (lvl - noise) if (lvl is not None and noise is not None) else None, "energy_sd_db": float(np.std(sp_db)) if len(sp_db) > 10 else None}


def m_rate(n_words, times, on, off, window):
    span = off - on
    if span <= 0.5 or not times:
        return None
    wpm = n_words / span * 60
    starts = np.array([t[0] for t in times])
    wins = []
    if span <= window:
        wins.append(wpm)
    else:
        t = on
        while t + window <= off + 1e-6:
            wins.append(float(np.sum((starts >= t) & (starts < t + window))) / window * 60)
            t += 1.0
    return {"wpm": float(wpm), "win_wpm_min": float(min(wins)), "win_wpm_max": float(max(wins))}


def clip_metrics(x, level):
    """(samples at/over `level`, clipping spike score). Natural speech has a monotonically decaying amplitude
    histogram; clipped-then-rescaled audio shows a SPIKE at the old plateau even after resampling/limiting."""
    a = np.abs(x)
    peak = float(a.max()) if len(a) else 0.0
    clipped = int(np.sum(a >= level))
    if peak <= 0:
        return clipped, 0.0
    h, _ = np.histogram(a[a >= 0.05 * peak], bins=200, range=(0, peak))
    score = 0.0
    for i in range(60, 200):
        if h[i] >= 20:
            score = max(score, float(h[i]) / (float(np.mean(h[i - 8:i - 2])) + 1.0))
    return clipped, score


def wcag_contrast(c1, c2):
    def lum(h):
        h = h.lstrip("#")
        rgb = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
        lin = [c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb]
        return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
    a, b = sorted([lum(c1), lum(c2)], reverse=True)
    return (a + 0.05) / (b + 0.05)


def parse_captions(path):
    with open(path, encoding="utf-8") as fh:
        txt = fh.read().replace("\r", "")
    cues = []
    for block in re.split(r"\n\s*\n", txt):
        m = re.search(r"(\d+:\d{2}:\d{2}[.,]\d{3}|\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d+:\d{2}:\d{2}[.,]\d{3}|\d{2}:\d{2}[.,]\d{3})", block)
        if not m:
            continue
        def ts(s):
            p = s.replace(",", ".").split(":")
            return sum(float(v) * 60 ** k for k, v in enumerate(reversed(p)))
        lines = [l for l in block.split("\n")[block.split("\n").index(next(l for l in block.split("\n") if "-->" in l)) + 1:] if l.strip()]
        cues.append({"start": ts(m.group(1)), "end": ts(m.group(2)), "lines": lines, "text": " ".join(lines)})
    return cues


def critical_vocab(man, thr, lex):
    """Tokens that are critical wherever they appear (reference OR hypothesis side): numbers, negations,
    promise/guarantee/CTA words and the manifest's critical terms (brand, prices...)."""
    v = (NUMBER_WORDS - {"um", "uma"}) | set(thr["V2"]["critical_negations"]) | set(thr["V2"]["critical_promise_cta"])
    for term in man.get("critical_terms") or []:
        v |= set(normalize_tokens(term, lex))
    return v


def critical_ops(ref, hyp, vocab, crit_pos):
    """Every substitution, deletion or insertion that touches a critical token on EITHER side of the alignment."""
    out = []
    for op, i, j in edit_ops(ref, hyp):
        if op == "equal":
            continue
        r = ref[i] if op in ("sub", "del") else None
        h = hyp[j] if op in ("sub", "ins") else None
        if (r is not None and (i in crit_pos or r in vocab)) or (h is not None and h in vocab):
            out.append(f"{op}:{r or '-'}>{h or '-'}")
    return out


def v2_metrics(ref, numflag, ta, tb, man, thr, lex=None):
    """V2 from token sequences (also used by the adversarial fixtures). Decisive: consensus critical errors on
    either side + promise/CTA/price/brand insertions by ANY engine; ≤ 1 non-critical consensus error per clip."""
    out = {}
    cons, heard, cons_ins = consensus(ref, ta, tb)
    out["wer_consensus"], out["cer_consensus"] = wer(ref, cons), cer(ref, cons)
    out["ref_tokens"], out["cons_tokens"] = ref, cons
    out["alignment"] = alignment_table(ref, ta, tb, cons)
    vocab = critical_vocab(man, thr, lex)
    crit = {i for i, w in enumerate(ref) if numflag[i] or w in vocab}
    for term in man.get("critical_terms") or []:
        tt = normalize_tokens(term, lex)
        for i in range(len(ref) - len(tt) + 1):
            if tt and ref[i:i + len(tt)] == tt:
                crit.update(range(i, i + len(tt)))
    out["critical_total"] = len(crit)
    cons_crit = critical_ops(ref, cons, vocab, crit)
    dangerous = set(thr["V2"]["critical_promise_cta"]) | {w for t in (man.get("critical_terms") or []) for w in normalize_tokens(t, lex)} | {"reais", "real", "centavos"}
    eng = {}
    for name, h in (("a", ta), ("b", tb)):
        ops = critical_ops(ref, h, vocab, crit)
        eng[name] = ops
    any_engine_promise = [f"{n}:{o}" for n, ops in eng.items() for o in ops if o.startswith(("ins:", "sub:")) and o.split(">")[-1] in dangerous]
    out["critical_errors"] = sorted(set(cons_crit + any_engine_promise))
    out["critical_engine_ops"] = eng
    errs = [o for o in edit_ops(ref, cons) if o[0] != "equal"]
    touched = lambda o: (o[0] in ("sub", "del") and (o[1] in crit or ref[o[1]] in vocab)) or (o[0] in ("sub", "ins") and cons[o[2]] in vocab)
    out["clip_errors_noncritical"] = sum(1 for o in errs if not touched(o))
    out["clip_errors_total"] = len(errs)
    # legacy (rodada 775a1aa) kept ONLY so mutation testing can prove the new rule is necessary
    out["critical_missed"] = sorted({ref[i] for i in crit if not heard[i]})
    out["critical_inserted"] = sorted({w for w in cons_ins if w in NUMBER_WORDS or w in thr["V2"]["critical_negations"]})
    out["clip_errors_noncritical_legacy"] = sum(1 for o in errs if not (o[0] in ("sub", "del") and o[1] in crit))
    # style-instruction leak
    st = normalize_tokens(((man.get("voice") or {}).get("style") or ""))
    ref3, leak = ngrams(ref, 3), []
    for name, t in (("a", ta), ("b", tb)):
        hits = (ngrams(t, 3) & ngrams(st, 3)) - ref3
        if hits:
            leak.append(f"{name}:style:{sorted(hits)[0]}")
    joined_ref = " " + " ".join(ref) + " "
    for mk in thr["V2"]["instruction_markers"]:
        mm = " " + " ".join(normalize_tokens(mk)) + " "
        if mm.strip() and mm not in joined_ref and mm in " " + " ".join(ta) + " " and mm in " " + " ".join(tb) + " ":
            leak.append(f"ab:marker:{mk}")
    out["instruction_leak"] = leak
    spoken = " ".join(ta) + " | " + " ".join(tb)
    out["sales_spoken_hits"] = [p for p in thr["V2"]["sales_closed_spoken_patterns"] if re.search(p, spoken)]
    return out


def alignment_table(ref, ta, tb, cons):
    """Word-by-word view: for each script token what engine A, engine B and the consensus produced."""
    def view(h):
        out, ins = [None] * len(ref), {}
        for op, i, j in edit_ops(ref, h):
            if op in ("equal", "sub"):
                out[i] = h[j]
            elif op == "ins":
                ins.setdefault(i, []).append(h[j])
        return out, ins
    va, ia = view(ta)
    vb, ib = view(tb)
    vc, ic = view(cons)
    rows = []
    for i, r in enumerate(ref):
        for nm, d in (("A", ia), ("B", ib), ("C", ic)):
            if i in d:
                rows.append({"pos": i, "ref": None, "ins_" + nm: d[i]})
        rows.append({"pos": i, "ref": r, "A": va[i], "B": vb[i], "C": vc[i]})
    return rows


def corpus_metrics(pairs):
    """Aggregate WER/CER over a corpus of (reference tokens, consensus tokens) — the pre-registered V2 basis."""
    words = sum(len(r) for r, _ in pairs)
    werr = sum(sum(1 for o in edit_ops(r, c) if o[0] != "equal") for r, c in pairs)
    chars = sum(len(" ".join(r)) for r, _ in pairs)
    cerr = sum(sum(1 for o in edit_ops(list(" ".join(r)), list(" ".join(c))) if o[0] != "equal") for r, c in pairs)
    return {"words": words, "word_errors": werr, "wer": werr / words if words else None,
            "chars": chars, "char_errors": cerr, "cer": cerr / chars if chars else None}


def reference_independent(r16, x16):
    """False when the 'brand reference' is (a piece of) the narration itself: max normalised cross-correlation of the
    10 ms energy envelopes ≥ 0.9. An independent recording of the same voice stays well below."""
    def env(x):
        n = 160
        k = len(x) // n
        e = np.log10(np.sqrt(np.mean(x[:k * n].reshape(k, n) ** 2, axis=1)) + 1e-7)
        e = np.maximum(e, e.max() - 4.0)  # 40 dB range: digital-silence padding must not dominate the correlation
        return (e - e.mean()) / (e.std() + 1e-9)
    a, b = env(r16), env(x16)
    if len(a) < 50 or len(b) < 50:
        return True
    L = 1 << int(np.ceil(np.log2(len(a) + len(b))))
    xc = np.fft.irfft(np.fft.rfft(a, L) * np.conj(np.fft.rfft(b, L)), L)
    return float(np.max(xc) / min(len(a), len(b))) < 0.9


def m_frames(mp4, duration, thr):
    """Burned-caption check from PIXELS: frames sampled across the video; the per-pixel median is the static
    background (the only element that changes over time is the caption text); text mask = |Y − Y_median| > d.
    Contrast = WCAG ratio between the median text colour and the background behind it; bbox → safe area."""
    W, H = 540, 960
    ts = np.linspace(0.4, max(0.5, duration - 0.4), 11)
    F = []
    for t in ts:
        p = sh(["ffmpeg", "-nostdin", "-v", "error", "-ss", f"{t:.3f}", "-i", mp4, "-map", "v:0", "-frames:v", "1",
                "-vf", f"scale={W}:{H}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], text=False)
        if len(p.stdout) == W * H * 3:
            F.append(np.frombuffer(p.stdout, np.uint8).reshape(H, W, 3).astype(np.float64))
    if len(F) < 5:
        raise InfraError("frames_unavailable")
    F = np.stack(F)
    bg = np.median(F, axis=0)
    Y = lambda a: a[..., 0] * 0.299 + a[..., 1] * 0.587 + a[..., 2] * 0.114
    yb = Y(bg)
    d = thr["V7"].get("text_luma_diff", 25)
    masks = [np.abs(Y(f) - yb) > d for f in F]
    union = np.any(masks, axis=0)
    frac = float(union.mean())
    if frac < 0.0005:
        return {"burned": False, "changed_frac": frac}
    ys, xs = np.nonzero(union)
    sx, sy = 1080 / W, 1920 / H
    bbox = [float(np.percentile(xs, 0.5) * sx), float(np.percentile(ys, 0.5) * sy),
            float((np.percentile(xs, 99.5) + 1) * sx), float((np.percentile(ys, 99.5) + 1) * sy)]
    def lum(c):
        c = np.asarray(c) / 255.0
        lin = np.where(c <= 0.03928, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
        return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
    crs = []
    for f, m in zip(F, masks):
        if m.sum() < 40:
            continue
        dy = np.abs(Y(f) - yb)
        core = m & (dy >= np.percentile(dy[m], 75))  # stroke cores, not anti-aliased edges
        a, b = sorted([lum(np.median(f[core], axis=0)), lum(np.median(bg[core], axis=0))], reverse=True)
        crs.append((a + 0.05) / (b + 0.05))
    if not crs:
        return {"burned": False, "changed_frac": frac}
    return {"burned": True, "bbox": [round(v) for v in bbox], "contrast_min": round(float(min(crs)), 2),
            "contrast_median": round(float(np.median(crs)), 2), "changed_frac": round(frac, 4), "frames": len(F)}


DEFAULT_STYLE = {"font_color": "#F5F7FB", "background_color": "#0C1C2B", "box": [96, 1150, 768, 240],
                 "font": "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "size": 38}


def render_video(narr, cues, out, style=None, hook="ZEVANORY", audio=True, duration=None):
    """Static-background 1080×1920 render with captions BURNED in the caption box (same layout as production)."""
    st = dict(DEFAULT_STYLE, **(style or {}))
    if duration is None:
        duration = len(decode(narr, sr=SR)) / SR if audio else (max(c["end"] for c in cues) + 1.0 if cues else 6.0)
    x, y, w, h = st["box"]
    tdir = out + ".txt.d"
    os.makedirs(tdir, exist_ok=True)
    hp = os.path.join(tdir, "hook.txt")
    open(hp, "w", encoding="utf-8").write(hook)
    vf = [f"drawbox=x={x}:y={y}:w={w}:h={h}:color=0x{st['background_color'].lstrip('#')}@1.0:t=fill",
          f"drawtext=fontfile={st['font']}:textfile={hp}:fontsize=80:fontcolor=0xF5F7FB:x=(w-text_w)/2:y=320"]
    for k, c in enumerate(cues):
        words, lines = c["text"].split(), [""]
        for wd in words:
            if lines[-1] and len(lines[-1]) + 1 + len(wd) > 30:
                lines.append(wd)
            else:
                lines[-1] = (lines[-1] + " " + wd).strip()
        lh = int(st["size"] * 1.3)
        top = y + (h - lh * len(lines)) // 2
        for i, ln in enumerate(lines[:3]):
            tp = os.path.join(tdir, f"c{k}_{i}.txt")
            open(tp, "w", encoding="utf-8").write(ln)
            vf.append(f"drawtext=fontfile={st['font']}:textfile={tp}:fontsize={st['size']}:fontcolor=0x{st['font_color'].lstrip('#')}"
                      f":x={x}+({w}-text_w)/2:y={top + i * lh}:enable='between(t,{c['start']},{c['end']})'")
    args = ["ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", f"color=c=0x0b0f16:s=1080x1920:r=30:d={duration:.3f}"]
    if audio:
        args += ["-i", narr, "-map", "0:v", "-map", "1:a", "-c:a", "copy"]
    args += ["-vf", ",".join(vf), "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-t", f"{duration:.3f}",
             "-movflags", "+faststart", out]
    sh(args)
    shutil.rmtree(tdir, ignore_errors=True)
    return out


def ngrams(toks, n):
    return {" ".join(toks[i:i + n]) for i in range(len(toks) - n + 1)}


# ------------------------------------------------------------------------------------------------- measure
def measure(mp4, manifest_path, engines, thr):
    """Run every measurement on the final artefacts. Never decides; failures are recorded as errors."""
    M = {"errors": {}, "gate_version": GATE_VERSION, "engines": engines.describe()}
    err = M["errors"]

    def guard(key, fn):
        try:
            return fn()
        except InfraError as e:
            err[key] = str(e)[:300]
        except Exception as e:  # unexpected = infrastructure error, never a pass
            err[key] = f"{type(e).__name__}:{str(e)[:240]}"
        return None

    man = None
    if manifest_path and os.path.isfile(manifest_path):
        try:
            man = json.load(open(manifest_path, encoding="utf-8"))
        except Exception as e:
            err["manifest"] = f"invalid:{e}"
    M["manifest_present"] = man is not None
    man = man or {}
    base = os.path.dirname(os.path.abspath(manifest_path)) if manifest_path else "."
    rp = lambda k: (os.path.join(base, man[k]) if man.get(k) else None)
    script_p, master_p, cap_p = rp("script"), rp("master"), rp("captions")
    ref_p = rp("brand_voice_reference")
    M["manifest"] = {k: man.get(k) for k in ("voice", "sales_mode", "gate_version", "critical_terms", "captions_style")}
    M["manifest_missing"] = [k for k in thr["V1"]["required_manifest"] if k not in man]
    M["mp4_present"] = bool(mp4 and os.path.isfile(mp4))
    M["master_present"] = bool(master_p and os.path.isfile(master_p))
    M["captions_present"] = bool(cap_p and os.path.isfile(cap_p))
    M["script_present"] = bool(script_p and os.path.isfile(script_p))
    M["reference_present"] = bool(ref_p and os.path.isfile(ref_p))
    hashes = {}
    for k, p in (("mp4_sha256", mp4), ("master_sha256", master_p), ("captions_sha256", cap_p), ("script_sha256", script_p)):
        if p and os.path.isfile(p) and man.get(k):
            hashes[k] = sha256(p) == man.get(k)
    M["hash_ok"] = hashes
    script = open(script_p, encoding="utf-8").read().strip() if M["script_present"] else None
    lex = man.get("lexicon") or {}
    if not M["mp4_present"]:
        return M

    pr = guard("probe", lambda: probe(mp4))
    if pr is None:
        return M
    vs = [s for s in pr["streams"] if s.get("codec_type") == "video"]
    au = [s for s in pr["streams"] if s.get("codec_type") == "audio"]
    M["video"] = {"width": vs[0].get("width"), "height": vs[0].get("height"),
                  "start": float(vs[0].get("start_time", 0) or 0)} if vs else None
    if vs and not au:  # no audio: still measure the frames (captions burned?) before returning
        M["frames"] = guard("frames", lambda: m_frames(mp4, float(pr.get("format", {}).get("duration", 0) or 0), thr))
    M["audio_stream"] = bool(au)
    M["duration_s"] = float(pr.get("format", {}).get("duration", 0) or 0)
    if vs:
        bd = guard("blackdetect", lambda: sh(["ffmpeg", "-nostdin", "-hide_banner", "-i", mp4, "-map", "v:0", "-vf",
                                              "blackdetect=d=0.1:pix_th=0.02", "-an", "-f", "null", "-"]).stderr)
        if bd is not None:
            M["black_s"] = float(sum(float(x) for x in re.findall(r"black_duration:([\d.]+)", bd)))
    if not au:
        return M
    a0 = au[0]
    M["audio"] = {"codec": a0.get("codec_name"), "rate": int(a0.get("sample_rate", 0) or 0),
                  "start": float(a0.get("start_time", 0) or 0)}
    M["container_offset_ms"] = (M["audio"]["start"] - (M["video"]["start"] if M["video"] else 0.0)) * 1000
    M["stream_loudness"] = guard("ebur128_stream", lambda: ebur128(mp4))
    xs = guard("decode_native", lambda: decode(mp4, sr=48000))
    if xs is not None:
        M["stream_clipped_samples"], _ = clip_metrics(xs, thr["V3"]["clip_level"])
    if M["master_present"]:
        M["master_loudness"] = guard("ebur128_master", lambda: ebur128(master_p))
        mpr = guard("probe_master", lambda: probe(master_p))
        if mpr:
            M["master_rate"] = int(mpr["streams"][0].get("sample_rate", 0) or 0)
            M["master_duration_s"] = float(mpr["format"].get("duration", 0) or 0)
        xm = guard("decode_master", lambda: decode(master_p, sr=48000))
        if xm is not None:
            _, M["master_clip_density"] = clip_metrics(xm, thr["V3"]["clip_level"])
    x16 = guard("decode_16k", lambda: decode(mp4, sr=SR))
    if x16 is None:
        return M
    M["audio_duration_s"] = len(x16) / SR
    vad = guard("vad", lambda: vad_frames(x16))
    if vad is None:
        return M
    sp, db = vad
    M["timeline"] = m_audio_timeline(x16, sp, db)
    if M["timeline"]["speech_s"] > 0:
        M["spectral"] = guard("spectral", lambda: m_spectral(x16, sp))
        M["prosody"] = guard("prosody", lambda: m_prosody(x16, sp))
    tl0 = M["timeline"]
    seg = x16[int(tl0["first_onset_s"] * SR):int(tl0["last_offset_s"] * SR)] if tl0.get("speech_s", 0) > 0 else x16
    M["dnsmos"] = guard("dnsmos", lambda: engines.dnsmos(seg))  # MOS of the narrated span only
    # ASR (two independent engine families)
    hyp_a = guard("engine_a", lambda: engines.asr_a(x16))
    rb = guard("engine_b", lambda: engines.asr_b(x16))
    M["asr"] = {"a_text": hyp_a, "b_text": rb[0] if rb else None}
    if script is not None:
        ref, numflag = normalize_tokens(script, lex, mark=True)
        M["script_tokens"] = len(ref)
        ta = normalize_tokens(hyp_a, lex) if hyp_a is not None else None
        tb = normalize_tokens(rb[0], lex) if rb else None
        if ta is not None:
            M["asr"]["wer_a"] = wer(ref, ta)
        if tb is not None:
            M["asr"]["wer_b"] = wer(ref, tb)
        if ta is not None and tb is not None:
            M["asr"].update(v2_metrics(ref, numflag, ta, tb, man, thr, lex))
        if rb:
            times, direct = script_word_times(ref, rb[1])
            if times and M["timeline"].get("speech_s", 0) > 0:
                M["rate"] = m_rate(len(ref), times, M["timeline"]["first_onset_s"], M["timeline"]["last_offset_s"],
                                   thr["V4"]["window_s"])
            # V6/V7 timing. Captions were aligned on the MASTER; the gate re-runs engine B on the master AND on the
            # FINAL mp4. Drift per cue = (cue start − master time of its first word) + (final − master) offset of the
            # words of that cue, including the container offset (audio start_time − video start_time).
            if M["captions_present"] and M["master_present"] and times:
                def sync():
                    _, wm = engines.asr_b(decode(master_p, sr=SR))
                    tm, dm = script_word_times(ref, wm)
                    if tm is None:
                        return {"cues": len(parse_captions(cap_p)), "measurable": 0, "deltas_ms": []}
                    off = M["container_offset_ms"] / 1000.0
                    offs = {i: times[i][0] + off - tm[i][0] for i in range(len(ref)) if direct[i] and dm[i]}
                    cues = parse_captions(cap_p)
                    if len(offs) < 3:
                        return {"cues": len(cues), "measurable": 0, "deltas_ms": [], "matched_both": len(offs)}
                    glob = float(np.median(list(offs.values())))
                    # a word matched to a different occurrence in one of the two alignments is an outlier, not drift
                    offs = {i: v for i, v in offs.items() if abs(v - glob) <= 0.3}
                    idx, deltas, local_n = 0, [], 0
                    for c in cues:
                        ct = normalize_tokens(c["text"], lex)
                        if not ct or idx >= len(ref):
                            idx += len(ct)
                            continue
                        loc = [offs[k] for k in range(idx, min(len(ref), idx + len(ct))) if k in offs]
                        local_n += bool(loc)
                        deltas.append((c["start"] - tm[idx][0] + (float(np.median(loc)) if loc else glob)) * 1000)
                        idx += len(ct)
                    return {"cues": len(cues), "measurable": len(deltas), "local": local_n, "matched_both": len(offs),
                            "offset_ms": round(glob * 1000), "deltas_ms": [round(d) for d in deltas]}
                M["captions"] = guard("sync", sync)
    # captions content / format
    if M["captions_present"]:
        cues = parse_captions(cap_p)
        c = M.get("captions") or {"cues": len(cues)}
        M["captions"] = c
        cap_tokens = normalize_tokens(" ".join(q["text"] for q in cues), lex)
        if script is not None:
            c["script_wer"] = wer(normalize_tokens(script, lex), cap_tokens)
        c["max_line_chars"] = max((len(l) for q in cues for l in q["lines"]), default=0)
        c["max_lines"] = max((len(q["lines"]) for q in cues), default=0)
        dur = sum(max(0.01, q["end"] - q["start"]) for q in cues)
        c["mean_cps"] = sum(len(q["text"]) for q in cues) / dur if cues else None
    # V7 measured on the actual video frames (not on the manifest)
    if M.get("video"):
        M["frames"] = guard("frames", lambda: m_frames(mp4, M.get("duration_s") or 0.0, thr))
    # texts for the sales-closed rule
    texts = [script or ""] + [json.dumps(man.get("texts") or {}, ensure_ascii=False)]
    if M["captions_present"]:
        texts.append(" ".join(q["text"] for q in parse_captions(cap_p)))
    blob = "\n".join(texts)
    M["sales_text_hits"] = [p for p in thr["V2"]["sales_closed_text_patterns"] if re.search(p, blob, re.I)]
    # speaker identity
    if M["reference_present"]:
        M["reference_independent"] = guard("speaker", lambda: reference_independent(decode(ref_p, sr=SR), x16))
    if M["reference_present"] and M.get("reference_independent"):
        def spk():
            r16 = decode(ref_p, sr=SR)
            v1, v2 = engines.xvector(x16), engines.xvector(r16)
            return None if v1 is None or v2 is None else float(np.dot(v1, v2))
        M["speaker_cos"] = guard("speaker", spk)
        # an x-vector practically identical to the clip's own means the "reference" IS the clip (or a cut of it)
        if M.get("speaker_cos") is not None and M["speaker_cos"] >= thr["V4"].get("speaker_self_cos", 0.97):
            M["reference_independent"] = False
    return M


# -------------------------------------------------------------------------------------------------- decide
GROUPS = {
    "narration": ["v1.narration_present", "v1.narration_coverage"],
    "vad": ["v3.speech_ratio", "v3.leading_silence", "v4.pause_max", "v4.pause_median"],
    "asr": ["v2.engine_a", "v2.engine_b", "v2.clip_errors", "v2.critical_terms",
            "v2.instruction_leak", "v2.sales_closed_spoken"],
    "loudness": ["v3.master_lufs", "v3.stream_lufs"],
    "true_peak": ["v3.master_tp", "v3.stream_tp"],
    "clipping": ["v3.clipped_samples", "v3.clip_density"],
    "noise": ["v3.noise_floor", "v3.snr"],
    "spectral": ["v3.spectral_flatness", "v3.tonality", "v3.voiced_fraction", "v4.hnr"],
    "rate": ["v4.wpm", "v4.win_wpm"],
    "prosody": ["v4.f0_sd", "v4.energy_sd"],
    "speaker": ["v4.speaker"],
    "mos": ["v5.dnsmos_ovrl", "v5.dnsmos_sig"],
    "sync": ["v6.drift_p95", "v6.drift_max", "v7.caption_timing"],
    "captions": ["v1.captions_present", "v7.caption_script_match", "v7.caption_format"],
    "contrast_px": ["v7.contrast_px"],
    "safe_area_px": ["v7.safe_area_px"],
    "burned_px": ["v7.captions_burned"],
    "compliance": ["v2.sales_closed_text", "v2.sales_closed_spoken"],
}


def decide(M, thr, profile="production", disable=(), overrides=None, policy=None):
    """Pure decision over measurements. `disable`/`overrides`/`policy` exist ONLY for mutation testing (V8)."""
    T = json.loads(json.dumps(thr))
    for path, val in (overrides or {}).items():
        s, k = path.split(".")
        T[s][k] = val
    policy = policy or {}
    off = set()
    for d in disable:
        off.update(GROUPS.get(d, [d]))
    checks = []
    E = M.get("errors", {})

    def add(cid, status, value=None, limit=None, reason=None):
        if cid in off:
            return
        checks.append({"id": cid, "status": status, "value": value, "limit": limit, "reason": reason})

    def need(cid, value, ok, limit, err_keys=()):
        errs = [E[k] for k in err_keys if k in E]
        if value is None:
            add(cid, "ERROR_INFRA" if errs else "BLOCKED", None, limit, (errs[0] if errs else "metric_missing"))
        else:
            add(cid, "PASS" if ok(value) else "FAIL", value, limit)

    # V1
    add("v1.mp4_present", "PASS" if M.get("mp4_present") else "FAIL")
    if not M.get("mp4_present"):
        return finalize(checks, policy)
    add("v1.manifest", "PASS" if M.get("manifest_present") and not M.get("manifest_missing") else "FAIL",
        M.get("manifest_missing"))
    add("v1.hashes", "PASS" if M.get("hash_ok") and all(M["hash_ok"].values()) and len(M["hash_ok"]) >= 3 else "FAIL",
        M.get("hash_ok"))
    voice = (M.get("manifest") or {}).get("voice") or {}
    allowed = [T["brand_voice"]] + (T.get("control_voices", []) if profile == "controls" else [])
    vok = any(voice.get("provider") == a["provider"] and voice.get("model") == a["model"] and a["voice"] in ("*", voice.get("voice")) for a in allowed)
    add("v1.voice_single_brand", "PASS" if vok else "FAIL", {k: voice.get(k) for k in ("provider", "model", "voice")}, T["brand_voice"])
    add("v1.audio_stream", "PASS" if M.get("audio_stream") else "FAIL", reason=None if M.get("audio_stream") else "narration_absent")
    add("v1.master_present", "PASS" if M.get("master_present") else "FAIL")
    add("v1.captions_present", "PASS" if M.get("captions_present") else "FAIL")
    add("v1.script_present", "PASS" if M.get("script_present") else "FAIL")
    if M.get("master_present"):
        need("v1.master_rate", M.get("master_rate"), lambda v: v >= T["V1"]["master_min_rate"], T["V1"]["master_min_rate"], ["probe_master"])
        if M.get("audio_stream"):
            md, ad = M.get("master_duration_s"), M.get("audio_duration_s")
            need("v1.duration_match", None if md is None or ad is None else abs(md - ad),
                 lambda v: v <= T["V1"]["duration_match_s"], T["V1"]["duration_match_s"], ["probe_master", "decode_16k"])
    if M.get("audio_stream"):
        tl = M.get("timeline") or {}
        sl = (M.get("stream_loudness") or {}).get("lufs")
        pres = None if not tl or sl is None else (tl.get("speech_s", 0) >= 1.0 and sl > -50)
        need("v1.narration_present", pres, lambda v: v is True, "speech>=1s and lufs>-50", ["vad", "ebur128_stream"])
        # the narration must cover the video: no dead air after the last word (old renderShort padded to 20 s)
        cov = None if not tl or not tl.get("speech_s") or M.get("audio_duration_s") is None else max(M["audio_duration_s"], M.get("duration_s") or 0.0) - tl["last_offset_s"]
        need("v1.narration_coverage", cov, lambda v: v <= T["V1"]["trailing_silence_max_s"], T["V1"]["trailing_silence_max_s"], ["vad", "decode_16k"])
        # V3
        ml = M.get("master_loudness") or {}
        if M.get("master_present"):
            need("v3.master_lufs", ml.get("lufs"), lambda v: abs(v - T["V3"]["master_lufs"]) <= T["V3"]["master_lufs_tol"],
                 f'{T["V3"]["master_lufs"]}±{T["V3"]["master_lufs_tol"]}', ["ebur128_master"])
            need("v3.master_tp", ml.get("tp"), lambda v: v <= T["V3"]["master_tp_max"], T["V3"]["master_tp_max"], ["ebur128_master"])
            need("v3.clip_density", M.get("master_clip_density"), lambda v: v <= T["V3"]["clip_spike_max"], T["V3"]["clip_spike_max"], ["decode_master"])
        s = M.get("stream_loudness") or {}
        need("v3.stream_lufs", s.get("lufs"), lambda v: T["V3"]["stream_lufs_min"] <= v <= T["V3"]["stream_lufs_max"],
             [T["V3"]["stream_lufs_min"], T["V3"]["stream_lufs_max"]], ["ebur128_stream"])
        need("v3.stream_tp", s.get("tp"), lambda v: v <= T["V3"]["stream_tp_max"], T["V3"]["stream_tp_max"], ["ebur128_stream"])
        need("v3.clipped_samples", M.get("stream_clipped_samples"), lambda v: v <= T["V3"]["clipped_samples_max"], 0, ["decode_native"])
        speech = tl.get("speech_s", 0) > 0
        need("v3.noise_floor", tl.get("noise_floor_dbfs") if speech else None, lambda v: v <= T["V3"]["noise_floor_max_dbfs"], T["V3"]["noise_floor_max_dbfs"], ["vad"])
        need("v3.snr", tl.get("snr_db") if speech else None, lambda v: v >= T["V3"]["snr_min_db"], T["V3"]["snr_min_db"], ["vad"])
        need("v3.speech_ratio", tl.get("speech_ratio", 0.0) if tl else None, lambda v: v >= T["V3"]["speech_ratio_min"], T["V3"]["speech_ratio_min"], ["vad"])
        need("v3.leading_silence", (tl.get("first_onset_s") + M.get("container_offset_ms", 0) / 1000) if speech else None,
             lambda v: v <= T["V3"]["leading_silence_max_s"], T["V3"]["leading_silence_max_s"], ["vad"])
        spc = M.get("spectral") or {}
        need("v3.spectral_flatness", spc.get("spectral_flatness"), lambda v: v <= T["V3"]["spectral_flatness_max"], T["V3"]["spectral_flatness_max"], ["spectral", "vad"])
        need("v3.tonality", spc.get("tonal_persistence"), lambda v: v <= T["V3"]["tonal_persistence_max"], T["V3"]["tonal_persistence_max"], ["spectral", "vad"])
        pro = M.get("prosody") or {}
        need("v3.voiced_fraction", pro.get("voiced_fraction"), lambda v: v >= T["V3"]["voiced_fraction_min"], T["V3"]["voiced_fraction_min"], ["prosody", "vad"])
        # V2
        a = M.get("asr") or {}
        need("v2.engine_a", a.get("wer_a"), lambda v: v <= T["V2"]["per_engine_wer_sanity_max"], T["V2"]["per_engine_wer_sanity_max"], ["engine_a"])
        need("v2.engine_b", a.get("wer_b"), lambda v: v <= T["V2"]["per_engine_wer_sanity_max"], T["V2"]["per_engine_wer_sanity_max"], ["engine_b"])
        legacy = T["V2"].get("critical_scope", "full") == "reference_only"  # mutation testing only
        # Per clip: at most 1 NON-critical consensus error; criticals (price, number, brand, negation, promise, CTA) = 0.
        # WER ≤ 3% / CER ≤ 1% is applied to the pre-registered aggregate corpus (corpus_metrics / `corpus` command).
        need("v2.clip_errors", a.get("clip_errors_noncritical_legacy" if legacy else "clip_errors_noncritical"), lambda v: v <= T["V2"]["clip_noncritical_max"], T["V2"]["clip_noncritical_max"], ["engine_a", "engine_b"])
        crit = (None if "critical_missed" not in a else a["critical_missed"] + a["critical_inserted"]) if legacy else a.get("critical_errors")
        need("v2.critical_terms", crit, lambda v: len(v) == 0, "0 errors", ["engine_a", "engine_b"])
        need("v2.instruction_leak", a.get("instruction_leak"), lambda v: len(v) == 0, "none", ["engine_a", "engine_b"])
        closed = ((M.get("manifest") or {}).get("sales_mode") or "closed") != "open"
        if closed:
            need("v2.sales_closed_spoken", a.get("sales_spoken_hits"), lambda v: len(v) == 0, "none", ["engine_a", "engine_b"])
        # V4
        r = M.get("rate") or {}
        need("v4.wpm", r.get("wpm"), lambda v: T["V4"]["wpm_min"] <= v <= T["V4"]["wpm_max"], [T["V4"]["wpm_min"], T["V4"]["wpm_max"]], ["engine_b", "vad"])
        need("v4.win_wpm", None if not r else [r["win_wpm_min"], r["win_wpm_max"]],
             lambda v: v[0] >= T["V4"]["win_wpm_min"] and v[1] <= T["V4"]["win_wpm_max"], [T["V4"]["win_wpm_min"], T["V4"]["win_wpm_max"]], ["engine_b", "vad"])
        need("v4.pause_max", tl.get("pause_max_ms") if speech else None, lambda v: v <= T["V4"]["pause_max_ms"], T["V4"]["pause_max_ms"], ["vad"])
        if speech:
            pm = tl.get("pause_median_ms")
            add("v4.pause_median", "PASS" if pm is None or (T["V4"]["pause_min_ms"] <= pm <= T["V4"]["pause_median_max_ms"]) else "FAIL",
                pm, [T["V4"]["pause_min_ms"], T["V4"]["pause_median_max_ms"]])
        else:
            need("v4.pause_median", None, None, None, ["vad"])
        need("v4.f0_sd", pro.get("f0_sd_st"), lambda v: T["V4"]["f0_sd_st_min"] <= v <= T["V4"]["f0_sd_st_max"], [T["V4"]["f0_sd_st_min"], T["V4"]["f0_sd_st_max"]], ["prosody", "vad"])
        need("v4.energy_sd", tl.get("energy_sd_db") if speech else None, lambda v: T["V4"]["energy_sd_db_min"] <= v <= T["V4"]["energy_sd_db_max"], [T["V4"]["energy_sd_db_min"], T["V4"]["energy_sd_db_max"]], ["vad"])
        need("v4.hnr", pro.get("hnr_db"), lambda v: v >= T["V4"]["hnr_min_db"], T["V4"]["hnr_min_db"], ["prosody", "vad"])
        if M.get("reference_present") and M.get("reference_independent") is False:
            add("v4.speaker", "BLOCKED", None, T["V4"]["speaker_cos_min"], "brand_reference_not_independent_of_clip")
        elif M.get("reference_present"):
            need("v4.speaker", M.get("speaker_cos"), lambda v: v >= T["V4"]["speaker_cos_min"], T["V4"]["speaker_cos_min"], ["speaker", "engine_b"])
        else:
            add("v4.speaker", "BLOCKED", None, T["V4"]["speaker_cos_min"], "brand_voice_reference_missing")
        # V5 (filter only)
        d = M.get("dnsmos") or {}
        need("v5.dnsmos_ovrl", d.get("ovrl"), lambda v: v >= T["V5"]["dnsmos_ovrl_min"], T["V5"]["dnsmos_ovrl_min"], ["dnsmos"])
        need("v5.dnsmos_sig", d.get("sig"), lambda v: v >= T["V5"]["dnsmos_sig_min"], T["V5"]["dnsmos_sig_min"], ["dnsmos"])
        # V6 / V7 timing
        if M.get("captions_present"):
            c = M.get("captions") or {}
            dl = c.get("deltas_ms")
            enough = dl is not None and c.get("cues") and c.get("measurable", 0) >= T["V6"]["measurable_cues_min_ratio"] * c["cues"]
            vals = [abs(x) for x in dl] if enough else None
            need("v6.drift_p95", float(np.percentile(vals, 95)) if vals else None, lambda v: v <= T["V6"]["drift_p95_ms"], T["V6"]["drift_p95_ms"], ["engine_b", "sync"])
            need("v6.drift_max", max(vals) if vals else None, lambda v: v <= T["V6"]["drift_max_ms"], T["V6"]["drift_max_ms"], ["engine_b", "sync"])
            need("v7.caption_timing", max(vals) if vals else None, lambda v: v <= T["V6"]["caption_delta_max_ms"], T["V6"]["caption_delta_max_ms"], ["engine_b", "sync"])
    # V7 visual / captions
    v = M.get("video")
    add("v7.frame", "PASS" if v and [v["width"], v["height"]] == T["V7"]["frame"] else "FAIL", v and [v["width"], v["height"]], T["V7"]["frame"])
    need("v7.black", M.get("black_s"), lambda x: x <= T["V7"]["black_max_s"], T["V7"]["black_max_s"], ["blackdetect"])
    if M.get("captions_present"):
        c = M.get("captions") or {}
        need("v7.caption_script_match", c.get("script_wer"), lambda x: x <= T["V7"]["caption_script_wer_max"], T["V7"]["caption_script_wer_max"])
        fmt_ok = None if c.get("mean_cps") is None else (c["max_line_chars"] <= T["V7"]["max_chars_line"] and c["max_lines"] <= T["V7"]["max_lines"] and c["mean_cps"] <= T["V7"]["mean_cps_max"])
        need("v7.caption_format", fmt_ok, lambda x: x is True, T["V7"]["max_chars_line"])
    fr = M.get("frames")
    if M.get("video"):
        need("v7.captions_burned", None if fr is None else fr.get("burned"), lambda v: v is True, "burned captions detected in frames", ["frames"])
        burned = bool(fr and fr.get("burned"))
        need("v7.contrast_px", fr.get("contrast_min") if burned else None, lambda v: v >= T["V7"]["contrast_min"], T["V7"]["contrast_min"], ["frames"])
        sx0, sy0, sx1, sy1 = T["V7"]["safe_area"]
        need("v7.safe_area_px", fr.get("bbox") if burned else None, lambda b: b[0] >= sx0 and b[1] >= sy0 and b[2] <= sx1 and b[3] <= sy1, T["V7"]["safe_area"], ["frames"])
    closed = ((M.get("manifest") or {}).get("sales_mode") or "closed") != "open"
    if closed:
        add("v2.sales_closed_text", "PASS" if not M.get("sales_text_hits") else "FAIL", M.get("sales_text_hits"))
    # Any measurement error that no check consumed still blocks the PASS.
    consumed = {"probe", "blackdetect", "ebur128_stream", "ebur128_master", "probe_master", "decode_master", "decode_native",
                "decode_16k", "vad", "spectral", "prosody", "dnsmos", "engine_a", "engine_b", "speaker", "manifest", "sync", "frames"}
    for k, e in E.items():
        if k not in consumed:
            add("infra." + k, "ERROR_INFRA", None, None, e)
    if "manifest" in E:
        add("v1.manifest_parse", "FAIL", None, None, E["manifest"])
    return finalize(checks, policy)


def finalize(checks, policy):
    st = []
    for c in checks:
        s = c["status"]
        if s == "BLOCKED" and policy.get("blocked_as_pass"):
            s = "PASS"
        if s == "ERROR_INFRA" and policy.get("error_as_pass"):
            s = "PASS"
        st.append(s)
    if not checks:
        verdict = "BLOCKED"
    elif "FAIL" in st:
        verdict = "FAIL"
    elif "ERROR_INFRA" in st:
        verdict = "ERROR_INFRA"
    elif "BLOCKED" in st:
        verdict = "BLOCKED"
    else:
        verdict = "PASS" if policy.get("mos_final") else "PASS_TECH_PENDING_HUMAN"  # mos_final: mutation testing only
    return {"verdict": verdict, "failed": [c["id"] for c, s in zip(checks, st) if s == "FAIL"],
            "blocked": [c["id"] for c, s in zip(checks, st) if s == "BLOCKED"],
            "errors": [c["id"] for c, s in zip(checks, st) if s == "ERROR_INFRA"], "checks": checks}


# ------------------------------------------------------------------------------------------------- package
def _measure_tmp(x, sr, tmpdir, name):
    p = os.path.join(tmpdir, name + ".wav")
    write_wav(p, x, sr, codec="pcm_f32le")
    return p, ebur128(p)


def _render(src, dst, gain_db, limit_db, codec_args):
    lim = 10 ** (limit_db / 20.0)
    af = f"volume={gain_db:.3f}dB,aresample=192000,alimiter=limit={lim:.5f}:attack=5:release=60:level=0,aresample=48000"
    sh(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", src, "-af", af, "-ac", "1", "-ar", "48000", *codec_args, dst])
    return ebur128(dst)


def make_cues(display_words, word_times, max_chars=36, max_words=7):
    cues, cur = [], []
    for k, w in enumerate(display_words):
        t = word_times[k]
        if t is None:
            continue
        if cur and (len(" ".join(x[0] for x in cur + [(w, t)])) > max_chars or len(cur) >= max_words or
                    (re.search(r"[.?!;:]$", cur[-1][0]) and len(cur) >= 2)):
            cues.append(cur)
            cur = []
        cur.append((w, t))
    if cur:
        cues.append(cur)
    out = []
    for i, c in enumerate(cues):
        start, end = c[0][1][0], c[-1][1][1]
        nxt = cues[i + 1][0][1][0] if i + 1 < len(cues) else None
        end = max(end, start + 0.6)
        if nxt is not None:
            end = min(end, nxt)
        out.append({"start": round(start, 3), "end": round(max(end, start + 0.2), 3), "text": " ".join(x[0] for x in c)})
    return out


def write_vtt(path, cues):
    with open(path, "w", encoding="utf-8") as f:
        f.write("WEBVTT\n\n")
        for i, c in enumerate(cues, 1):
            f.write(f"{i}\n{fmt_ts(c['start'])} --> {fmt_ts(c['end'])}\n{c['text']}\n\n")


def display_words_of(script):
    s = re.sub(r"R\$\s+(\d)", r"R$\1", script.strip())
    return s.split()


def caption_times(script, lex, x16, engines):
    """Word times for the display words of the script from engine-B alignment on the given audio."""
    dw = display_words_of(script)
    toks, owner = [], []
    for k, w in enumerate(dw):
        t = normalize_tokens(w, lex)
        toks += t
        owner += [k] * len(t)
    _, words = engines.asr_b(x16)
    times, _ = script_word_times(toks, words)
    if times is None:  # nothing recognised: spread uniformly over the detected speech (or the whole audio)
        span = speech_span(x16) or (0.0, len(x16) / SR)
        n = max(1, len(toks))
        step = (span[1] - span[0]) / n
        times = [(span[0] + i * step, span[0] + (i + 1) * step) for i in range(n)]
    wt = [None] * len(dw)
    for i, k in enumerate(owner):
        s, e = times[i]
        wt[k] = (s, e) if wt[k] is None else (wt[k][0], e)
    return dw, wt


def package(raw, script, out, engines, lex=None, tail_s=1.0, lead_s=0.15, master_lufs=-23.0, master_limit_db=-2.0,
            stream_lufs=-17.5, stream_limit_db=-3.5, stream_tp_target=-2.3, inject_delay_s=0.0, no_limiter=False):
    """Production audio chain: trim → master WAV 48 kHz/24-bit (−23 LUFS, TP ≤ −1) → streaming derivative
    (−17.5 LUFS, oversampled true-peak limiter as LAST stage, ONE AAC 192k encode, TP ≤ −2 after encode) → captions."""
    os.makedirs(out, exist_ok=True)
    tmp = tempfile.mkdtemp(prefix="avg-", dir=out)
    try:
        x48 = decode(raw, sr=48000)
        x16 = decode(raw, sr=SR)
        span = speech_span(x16)
        if span:
            a = max(0, int((span[0] - lead_s) * 48000))
            b = min(len(x48), int((span[1] + 0.25) * 48000))
            pad = max(0, int((lead_s - span[0]) * 48000))
            x48 = np.concatenate([np.zeros(pad), x48[a:b]])
        x48 = np.concatenate([x48, np.zeros(int(tail_s * 48000))])
        src, m0 = _measure_tmp(x48, 48000, tmp, "trim")
        master = os.path.join(out, "master.wav")
        if m0["lufs"] is None or not math.isfinite(m0["lufs"]):
            sh(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", src, "-c:a", "pcm_s24le", "-ar", "48000", master])
            mm = ebur128(master)
        else:
            g = master_lufs - m0["lufs"]
            for _ in range(3):
                mm = _render(src, master, g, master_limit_db, ["-c:a", "pcm_s24le"])
                if abs(mm["lufs"] - master_lufs) <= 0.15:
                    break
                g += master_lufs - mm["lufs"]
        narr = os.path.join(out, "narration.m4a")
        mpre = master
        if inject_delay_s > 0:
            xm = decode(master, sr=48000)
            mpre = os.path.join(tmp, "delayed.wav")
            write_wav(mpre, np.concatenate([np.zeros(int(inject_delay_s * 48000)), xm]), 48000, codec="pcm_f32le")
        aac = ["-c:a", "aac", "-b:a", "192k"]
        if not math.isfinite(mm["lufs"]) or mm["lufs"] < -69:
            sh(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", mpre, *aac, "-ar", "48000", narr])
            sm = ebur128(narr)
        elif no_limiter:
            g = stream_lufs - mm["lufs"]
            sh(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", mpre, "-af", f"volume={g:.3f}dB", *aac, "-ar", "48000", narr])
            sm = ebur128(narr)
        else:
            g, lim = stream_lufs - mm["lufs"], stream_limit_db
            for _ in range(6):
                sm = _render(mpre, narr, g, lim, aac)
                if sm["tp"] > stream_tp_target:
                    lim -= max(0.3, sm["tp"] - stream_tp_target)
                    continue
                if abs(sm["lufs"] - stream_lufs) > 0.3:
                    g += stream_lufs - sm["lufs"]
                    continue
                break
        # captions from engine-B alignment on the master (text = approved script)
        dw, wt = caption_times(script, lex, decode(master, sr=SR), engines)
        cues = make_cues(dw, wt)
        caps = os.path.join(out, "captions.vtt")
        write_vtt(caps, cues)
        with open(os.path.join(out, "captions.json"), "w", encoding="utf-8") as f:
            json.dump(cues, f, ensure_ascii=False)
        dur = len(decode(narr, sr=SR)) / SR
        return {"master": master, "narration": narr, "captions": caps, "cues": cues, "duration_s": dur,
                "master_loudness": mm, "stream_loudness": sm}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def write_manifest(out, mp4, script_text, voice, *, sales_mode="closed", reference=None, texts=None,
                   captions_style=None, critical_terms=None, lexicon=None, master="master.wav", captions="captions.vtt"):
    sp = os.path.join(out, "script.txt")
    with open(sp, "w", encoding="utf-8") as f:
        f.write(script_text.strip() + "\n")
    man = {"gate_version": GATE_VERSION, "script": "script.txt", "script_sha256": sha256(sp), "voice": voice,
           "sales_mode": sales_mode, "texts": texts or {}, "critical_terms": critical_terms or [], "lexicon": lexicon or {},
           "captions_style": captions_style}
    if master and os.path.isfile(os.path.join(out, master)):
        man["master"] = master
        man["master_sha256"] = sha256(os.path.join(out, master))
    if captions and os.path.isfile(os.path.join(out, captions)):
        man["captions"] = captions
        man["captions_sha256"] = sha256(os.path.join(out, captions))
    if mp4 and os.path.isfile(mp4):
        man["mp4_sha256"] = sha256(mp4)
    if reference:
        man["brand_voice_reference"] = os.path.relpath(reference, out)
    p = os.path.join(out, "manifest.json")
    with open(p, "w", encoding="utf-8") as f:
        json.dump(man, f, ensure_ascii=False, indent=1)
    return p


# ---------------------------------------------------------------------------------------------------- CLI
def annotate(level, title, msg):
    msg = str(msg).replace("%", "%25").replace("\r", "").replace("\n", "%0A")
    print(f"::{level} title={title}::{msg}", flush=True)


def main(argv=None):
    ap = argparse.ArgumentParser(description="zevanory-av-gate")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p1 = sub.add_parser("package")
    p1.add_argument("--raw", required=True)
    p1.add_argument("--script", required=True)
    p1.add_argument("--out", required=True)
    p1.add_argument("--tail", type=float, default=1.0)
    p1.add_argument("--lexicon")
    p2 = sub.add_parser("check")
    p2.add_argument("--mp4", required=True)
    p2.add_argument("--manifest", required=True)
    p2.add_argument("--out", required=True)
    p2.add_argument("--profile", default="production", choices=["production", "controls"])
    p2.add_argument("--thresholds")
    a = ap.parse_args(argv)
    if a.cmd == "package":
        try:
            lex = json.loads(a.lexicon) if a.lexicon else None
            r = package(a.raw, open(a.script, encoding="utf-8").read(), a.out, Engines(), lex=lex, tail_s=a.tail)
            print(json.dumps({"ok": True, **{k: v for k, v in r.items() if k != "cues"}, "cues": len(r["cues"])}, ensure_ascii=False))
            return 0
        except Exception as e:
            annotate("error", "AV_GATE_PACKAGE", f"ERROR_INFRA {type(e).__name__}: {str(e)[:300]}")
            print(json.dumps({"ok": False, "verdict": "ERROR_INFRA", "error": str(e)[:300]}))
            return 3
    thr = load_thresholds(a.thresholds)
    try:
        M = measure(a.mp4, a.manifest, Engines(), thr)
        D = decide(M, thr, profile=a.profile)
    except Exception as e:  # the gate itself crashed: never a pass
        M, D = {"crash": f"{type(e).__name__}:{str(e)[:300]}"}, {"verdict": "ERROR_INFRA", "failed": [], "blocked": [], "errors": ["gate_crash"], "checks": []}
    rep = {"gate": "zevanory-av-gate", "version": GATE_VERSION, "verdict": D["verdict"], "decision": D, "measurements": M}
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(rep, f, ensure_ascii=False, indent=1, default=float)
    lvl = "notice" if D["verdict"] == "PASS_TECH_PENDING_HUMAN" else "error"
    annotate(lvl, "AV_GATE", f'{D["verdict"]} failed={D["failed"][:12]} blocked={D["blocked"][:6]} errors={D["errors"][:6]}')
    return EXIT[D["verdict"]]


if __name__ == "__main__":
    sys.exit(main())
