#!/usr/bin/env python3
"""ZEVANORY | zevanory-av-gate — V8: controles negativos/positivos gerados no CI + testes de mutação do gate.

Positivos: fala HUMANA pt-BR licenciada (Google FLEURS pt_br, CC BY 4.0), baixada no runner. Cada positivo passa pela
MESMA cadeia de produção (package: master −23 LUFS, derivado −17.5 LUFS com limitador true-peak no último estágio,
1 encode AAC, legendas por alinhamento) e pelo MESMO gate. Se nenhuma fala humana licenciada estiver alcançável,
os positivos ficam BLOCKED (calibração positiva exige gravações humanas do proprietário) e o job falha.
Negativos: cada um nasce de um positivo (ou de sinal sintético) com UM defeito injetado no estágio em que ele ocorre.
Mutantes: variações da camada de decisão (decide) avaliadas sobre as MESMAS medições; um mutante é MORTO quando algum
negativo passa a PASS ou algum positivo deixa de ser PASS.

Uso:  controls.py run --work DIR --out results.json
      controls.py annotate --results results.json --what summary|positives|negatives|mutants
"""
import argparse, io, json, os, random, re, shutil, subprocess, sys, tarfile, time, urllib.request

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import zevanory_av_gate as G  # noqa: E402

FLEURS = "https://huggingface.co/datasets/google/fleurs/resolve/main/data/pt_br"
FLEURS_PARQUET_API = "https://huggingface.co/api/datasets/google/fleurs/parquet/pt_br/{split}"
STYLE = {"burned": True, "font_color": "#F5F7FB", "background_color": "#0C1C2B", "box": [96, 1150, 768, 240], "frame": [1080, 1920]}
HUMAN_VOICE = {"provider": "human-reference", "model": "fleurs-pt_br", "voice": "speaker", "persona": None, "style": ""}
BRAND = {"provider": "gemini", "model": "gemini-3.8-flash-tts", "voice": "Achird", "persona": "zevanory-brand", "style": "tom amigável e confiante"}
NUM_SWAP = {"dois": "três", "duas": "três", "três": "quatro", "tres": "quatro", "quatro": "cinco", "cinco": "seis", "seis": "sete",
            "sete": "oito", "oito": "nove", "nove": "dez", "dez": "onze", "cem": "duzentos", "mil": "dois mil", "vinte": "trinta",
            "trinta": "quarenta", "quarenta": "cinquenta", "cinquenta": "sessenta"}


def note(level, title, msg):
    G.annotate(level, title, msg)


def http(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": "zevanory-av-gate-ci/1.0"})
    return urllib.request.urlopen(req, timeout=timeout)


# ------------------------------------------------------------------------------------- human references
def fetch_fleurs(dest, want=400):
    """Stream FLEURS pt_br (test, then dev) and keep up to `want` clips that pass the TEXT filter.
    Returns list of dicts {path, text, gender, id, source}."""
    os.makedirs(dest, exist_ok=True)
    tried, acc = [], []
    for split in ("test", "dev"):
        try:
            rows = {}
            tsv = http(f"{FLEURS}/{split}.tsv").read().decode("utf-8", "replace")
            for line in tsv.splitlines():
                c = line.split("\t")
                wav = next((x for x in c if x.endswith(".wav")), None)
                if not wav:
                    continue
                k = c.index(wav)
                gender = c[-1].strip().upper() if c[-1].strip().upper() in ("MALE", "FEMALE", "OTHER") else "UNK"
                rows[wav] = {"id": c[0], "text": c[k + 1] if k + 1 < len(c) else "", "gender": gender}
            ok = {w: r for w, r in rows.items() if text_ok(r["text"])}
            out = []
            with http(f"{FLEURS}/audio/{split}.tar.gz", timeout=120) as resp:
                with tarfile.open(fileobj=resp, mode="r|gz") as tf:
                    for m in tf:
                        b = os.path.basename(m.name)
                        if m.isfile() and b in ok:
                            p = os.path.join(dest, b)
                            with open(p, "wb") as f:
                                f.write(tf.extractfile(m).read())
                            out.append({"path": p, **ok[b], "source": f"google/fleurs pt_br {split} (CC BY 4.0) {b}"})
                            if len(out) + len(acc) >= want:
                                break
            acc += out
            tried.append(f"tar:{split}:ok:{len(out)}/{len(ok)}")
            if len(acc) >= want:
                break
        except Exception as e:
            tried.append(f"tar:{split}:{type(e).__name__}:{str(e)[:80]}")
    if acc:
        return acc, tried
    # fallback: parquet conversion served by the Hub
    for split in ("test", "validation"):
        try:
            import pyarrow.parquet as pq
            urls = json.loads(http(FLEURS_PARQUET_API.format(split=split)).read())
            out = []
            for u in urls[:2]:
                t = pq.read_table(io.BytesIO(http(u, timeout=300).read()))
                for row in t.to_pylist():
                    text = row.get("raw_transcription") or row.get("transcription") or ""
                    if not text_ok(text):
                        continue
                    audio = row.get("audio") or {}
                    data = audio.get("bytes")
                    if not data:
                        continue
                    p = os.path.join(dest, f"pq_{row.get('id')}_{len(out)}.wav")
                    open(p, "wb").write(data)
                    g = row.get("gender")
                    out.append({"path": p, "id": str(row.get("id")), "text": text,
                                "gender": {0: "MALE", 1: "FEMALE"}.get(g, str(g).upper()), "source": f"google/fleurs pt_br {split} parquet (CC BY 4.0)"})
                    if len(out) >= want:
                        break
                if len(out) >= want:
                    break
            if out:
                return out, tried + [f"parquet:{split}:ok:{len(out)}"]
            tried.append(f"parquet:{split}:empty")
        except Exception as e:
            tried.append(f"parquet:{split}:{type(e).__name__}:{str(e)[:80]}")
    return [], tried


def text_ok(t):
    w = t.split()
    if not (14 <= len(w) <= 34):
        return False
    if re.search(r"[\"“”()\[\]/;:%&]", t):
        return False
    if re.search(r"[^A-Za-zÀ-ÿ0-9 ,.?!'-]", t):
        return False
    # no proper nouns: no capitalised word except the first one (sentence start)
    if any(x[:1].isupper() for x in w[1:]):
        return False
    # no foreign (non-Portuguese) words: a pt-BR narration script never carries them unadapted
    return not any(re.search(r"[kwy]|ff|sh|th|ck|oo|ee|ng$", G.strip_accents(x.lower().strip(",.?!'-"))) for x in w)


def audio_screen(c, thr):
    """Operating-envelope pre-screen of a human clip (declared: positives are human clips inside the V3/V4 envelope)."""
    x = G.decode(c["path"], sr=G.SR)
    sp, db = G.vad_frames(x)
    tl = G.m_audio_timeline(x, sp, db)
    if tl.get("speech_s", 0) < 4:
        return None
    n = len(G.normalize_tokens(c["text"]))
    wpm = n / max(1e-6, tl["last_offset_s"] - tl["first_onset_s"]) * 60
    c.update({"wpm_raw": wpm, "snr_raw": tl["snr_db"], "pause_max_raw": tl["pause_max_ms"], "speech_ratio_raw": tl["speech_ratio"]})
    # level-independent envelope (the production chain re-levels everything to −23 / −17.5 LUFS)
    c["screen_fail"] = [k for k, ok in (("wpm", 134 <= wpm <= 171), ("snr", (tl["snr_db"] or 0) >= 33),
                                        ("pause", tl["pause_max_ms"] <= 1100), ("ratio", tl["speech_ratio"] >= 0.65)) if not ok]
    return not c["screen_fail"]


# --------------------------------------------------------------------------------------------- builders
def ff(*args):
    G.sh(["ffmpeg", "-nostdin", "-v", "error", "-y", *args])


def render_mp4(narr, out_mp4, dur=None, audio=True):
    if dur is None:
        dur = len(G.decode(narr, sr=G.SR)) / G.SR
    v = ["-f", "lavfi", "-i", f"color=c=0x0c1c2b:s=1080x1920:r=30:d={dur:.3f}"]
    if audio:
        ff(*v, "-i", narr, "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "ultrafast", "-tune", "stillimage",
           "-pix_fmt", "yuv420p", "-c:a", "copy", "-t", f"{dur:.3f}", "-movflags", "+faststart", out_mp4)
    else:
        ff(*v, "-c:v", "libx264", "-preset", "ultrafast", "-tune", "stillimage", "-pix_fmt", "yuv420p", "-t", f"{dur:.3f}",
           "-movflags", "+faststart", out_mp4)
    return out_mp4


def write_raw(path, x, sr):
    G.write_wav(path, x, sr, codec="pcm_s16le")
    return path


class Builder:
    def __init__(self, work, engines):
        self.work, self.E = work, engines
        os.makedirs(work, exist_ok=True)

    def build(self, cid, raw, script, *, voice=HUMAN_VOICE, reference=None, texts=None, critical_terms=None,
              pkg=None, mutate_dir=None, audio=True):
        d = os.path.join(self.work, cid)
        shutil.rmtree(d, ignore_errors=True)
        os.makedirs(d)
        r = G.package(raw, script, d, self.E, **(pkg or {}))
        mp4 = render_mp4(r["narration"], os.path.join(d, "final.mp4"), audio=audio)
        ref = None
        if reference:
            ref = os.path.join(d, "brand_reference.wav")
            shutil.copy(reference, ref)
        info = {"dir": d, "mp4": mp4, "pkg": {k: r[k] for k in ("master_loudness", "stream_loudness", "duration_s")}}
        if mutate_dir:
            mp4 = mutate_dir(d, mp4) or mp4
            info["mp4"] = mp4
        man = G.write_manifest(d, mp4, script, voice, reference=ref, texts=texts or {"title": "controle", "description": "controle V8"},
                               captions_style=STYLE, critical_terms=critical_terms)
        info["manifest"] = man
        return info


def tone(sec, f=196.0, sr=48000, amp=0.3):
    t = np.arange(int(sec * sr)) / sr
    return amp * np.sin(2 * np.pi * f * t)


def pink(n, rng):
    w = rng.standard_normal(n)
    f = np.fft.rfft(w)
    k = np.arange(len(f))
    k[0] = 1
    return np.fft.irfft(f / np.sqrt(k), n)


# ------------------------------------------------------------------------------------------------ run
def run(work, out):
    t0 = time.time()
    thr = G.load_thresholds()
    E = G.Engines()
    B = Builder(os.path.join(work, "controls"), E)
    rng = np.random.default_rng(20261022)
    res = {"gate_version": G.GATE_VERSION, "engines": E.describe(), "controls": [], "mutants": [], "notes": []}

    # ---- human references
    cands, tried = fetch_fleurs(os.path.join(work, "fleurs"))
    res["human_source_attempts"] = tried
    screened = []
    for c in cands:
        try:
            if audio_screen(c, thr):
                screened.append(c)
        except G.InfraError as e:
            res["notes"].append(f"screen_error:{e}")
    pos = []
    seen = set()
    numeric = [c for c in screened if any(w in NUM_SWAP for w in [strip(x) for x in c["text"].split()])]
    for c in (numeric[:1] + [x for x in screened if x["gender"] == "FEMALE"] + [x for x in screened if x["gender"] == "MALE"] + screened):
        if c["id"] in seen or len(pos) >= 6:
            continue
        seen.add(c["id"])
        pos.append(c)
    res["human_candidates"] = len(cands)
    fails = {}
    for c in cands:
        for k in c.get("screen_fail", []):
            fails[k] = fails.get(k, 0) + 1
    med = lambda k: round(float(np.median([c[k] for c in cands if c.get(k) is not None])), 1) if cands else None
    res["human_screen_stats"] = {"fail_counts": fails, "median_wpm": med("wpm_raw"), "median_snr": med("snr_raw"), "median_pause_max": med("pause_max_raw")}
    res["human_screened"] = len(screened)
    human = len(pos) >= 3
    if not human:
        res["notes"].append("POSITIVE_CALIBRATION_BLOCKED: nenhuma fala humana pt-BR licenciada alcançável no runner; "
                            "positivos exigem gravações humanas de referência do proprietário")
        pos = espeak_bases(os.path.join(work, "espeak"))
        res["base_source"] = "espeak-ng (WIRING ONLY)"
    else:
        res["base_source"] = "google/fleurs pt_br (CC BY 4.0)"
    if not pos:
        res["fatal"] = "no_base_audio"
        json.dump(res, open(out, "w"), ensure_ascii=False, indent=1, default=float)
        return res

    def add(cid, kind, desc, info, expect, expect_checks=(), engines=None, base=None):
        try:
            M = G.measure(info["mp4"], info["manifest"], engines or E, thr)
        except Exception as e:
            M = {"errors": {"harness": f"{type(e).__name__}:{e}"}}
        res["controls"].append({"id": cid, "kind": kind, "desc": desc, "expect": expect, "expect_checks": list(expect_checks),
                                "base": base, "M": M, "pkg": info.get("pkg")})

    def safe(cid, kind, desc, expect, expect_checks, fn, base=None):
        try:
            info = fn()
            add(cid, kind, desc, info, expect, expect_checks, base=base)
        except Exception as e:
            res["controls"].append({"id": cid, "kind": kind, "desc": desc, "expect": expect, "expect_checks": list(expect_checks),
                                    "build_error": f"{type(e).__name__}:{str(e)[:300]}", "M": None, "base": base})

    # ---- positives
    for i, c in enumerate(pos, 1):
        kind = "positive" if human else "wiring"
        safe(f"P{i:02d}", kind, f"fala humana pt-BR ({c['gender']}) {c['source']}", "PASS" if human else "ANY", [],
             lambda c=c, i=i: B.build(f"P{i:02d}", c["path"], c["text"], reference=c["path"]), base=c.get("source"))

    P = pos[0]
    fast = max(pos, key=lambda c: c.get("wpm_raw", 0))
    mid = sorted(pos, key=lambda c: c.get("wpm_raw", 0))[len(pos) // 2]
    other = next((c for c in pos if c["gender"] != P["gender"]), pos[-1] if pos[-1] is not P else P)
    tmp = os.path.join(work, "raw")
    os.makedirs(tmp, exist_ok=True)
    x16 = lambda c: G.decode(c["path"], sr=16000)
    S = P["text"]

    # ---- synthetic signals (script = a real approved script; audio is not speech)
    def synth(cid, sig, sr=48000):
        return lambda: B.build(cid, write_raw(os.path.join(tmp, cid + ".wav"), sig, sr), S, reference=P["path"])
    T = 12.0
    safe("N01", "negative", "tom puro 196 Hz", "FAIL", ["v3.tonal_ratio", "v2.consensus_wer"], synth("N01", tone(T)))
    safe("N02", "negative", "ruído branco", "FAIL", ["v3.spectral_flatness", "v2.consensus_wer"], synth("N02", 0.2 * rng.standard_normal(int(T * 48000))))
    pk = pink(int(T * 48000), rng)
    env = 0.5 * (1 + np.sin(2 * np.pi * 4.0 * np.arange(len(pk)) / 48000))
    safe("N03", "negative", "ruído rosa modulado 4 Hz (pseudo-fala)", "FAIL", ["v2.consensus_wer"], synth("N03", 0.3 * pk / np.max(np.abs(pk)) * env))
    t = np.arange(int(T * 48000)) / 48000
    beeps = 0.3 * np.sin(2 * np.pi * 880 * t) * ((t % 0.3) < 0.15)
    safe("N04", "negative", "bipes robóticos 880 Hz", "FAIL", ["v3.tonal_ratio", "v2.consensus_wer"], synth("N04", beeps))

    # ---- derived from human speech, one defect each
    def from_raw(cid, xmod, sr=16000, script=None, **kw):
        return lambda: B.build(cid, write_raw(os.path.join(tmp, cid + ".wav"), xmod, sr), script or P["text"], reference=kw.pop("reference", P["path"]), **kw)
    xp = x16(P)
    # hard clipping of the SPEECH at −18 dB below its peak (the noise floor stays where it was), then re-levelled
    pk_ = float(np.max(np.abs(xp)))
    safe("N05", "negative", "fala clipada (corte a −18 dB do pico) e renormalizada", "FAIL", ["v3.clip_density"],
         from_raw("N05", np.clip(xp, -pk_ * 10 ** (-18 / 20), pk_ * 10 ** (-18 / 20))), base=P["source"])
    safe("N06", "negative", "loudness fora (derivado −30 LUFS)", "FAIL", ["v3.stream_lufs"],
         lambda: B.build("N06", P["path"], P["text"], reference=P["path"], pkg={"stream_lufs": -30.0}), base=P["source"])

    def tp_over():
        for lim in (-1.0, -1.3, -0.8, -1.6):
            info = B.build("N07", P["path"], P["text"], reference=P["path"], pkg={"stream_lufs": -16.5, "stream_limit_db": lim, "stream_tp_target": -0.4})
            tp = info["pkg"]["stream_loudness"]["tp"]
            if -1.9 < tp < -0.4:
                return info
        raise RuntimeError(f"tp_over_not_in_window:{tp}")
    safe("N07", "negative", "true peak acima (derivado TP entre −2 e −0,3 dBTP)", "FAIL", ["v3.stream_tp"], tp_over, base=P["source"])
    safe("N08", "negative", "true peak grosseiro sem limitador (+ganho)", "FAIL", ["v3.stream_tp"],
         lambda: B.build("N08", P["path"], P["text"], reference=P["path"], pkg={"stream_lufs": -11.0, "no_limiter": True}), base=P["source"])
    safe("N09", "negative", "silêncio (vídeo sem narração audível)", "FAIL", ["v1.narration_present"], synth("N09", np.zeros(int(10 * 48000))))

    def no_audio():
        info = B.build("N10", P["path"], P["text"], reference=P["path"], audio=False)
        os.remove(os.path.join(info["dir"], "master.wav"))
        info["manifest"] = G.write_manifest(info["dir"], info["mp4"], P["text"], HUMAN_VOICE, reference=os.path.join(info["dir"], "brand_reference.wav"), captions_style=STYLE)
        return info
    safe("N10", "negative", "MP4 sem faixa de áudio e sem master (narração ausente)", "FAIL", ["v1.audio_stream"], no_audio, base=P["source"])

    def long_pause():
        x = x16(fast)
        segs = G.segments(G.vad_frames(x)[0])
        gaps = [((a[1] + b[0]) / 2) for a, b in zip(segs, segs[1:])]
        mid_t = (segs[0][0] + segs[-1][1]) / 2
        at = min(gaps, key=lambda g: abs(g - mid_t)) if gaps else mid_t
        k = int(at * 16000)
        y = np.concatenate([x[:k], np.zeros(int(1.8 * 16000)), x[k:]])
        return B.build("N11", write_raw(os.path.join(tmp, "N11.wav"), y, 16000), fast["text"], reference=fast["path"])
    safe("N11", "negative", "pausa longa inserida (1,8 s)", "FAIL", ["v4.pause_max"], long_pause, base=fast["source"])

    def psola(cid, c, k):
        """Resynthesise with F0 compressed around the median: f' = med·(f/med)^k (k=0 → monotone)."""
        import parselmouth
        from parselmouth.praat import call
        snd = parselmouth.Sound(c["path"])
        man = call(snd, "To Manipulation", 0.01, 75, 500)
        pt = call(man, "Extract pitch tier")
        n = int(call(pt, "Get number of points"))
        pts = [(call(pt, "Get time from index", i), call(pt, "Get value at index", i)) for i in range(1, n + 1)]
        med = float(np.median([v for _, v in pts])) if pts else 120.0
        call(pt, "Remove points between", 0, snd.duration)
        if k == 0 or not pts:
            call(pt, "Add point", snd.duration / 2, med)
        else:
            for t, v in pts:
                call(pt, "Add point", t, med * (v / med) ** k)
        call([pt, man], "Replace pitch tier")
        out = call(man, "Get resynthesis (overlap-add)")
        p = os.path.join(tmp, cid + ".wav")
        out.save(p, "WAV")
        return B.build(cid, p, c["text"], reference=c["path"])
    safe("N12", "negative", "prosódia achatada (F0 monotônico, PSOLA)", "FAIL", ["v4.f0_sd"], lambda: psola("N12", mid, 0.0), base=mid["source"])
    safe("N25", "negative", "prosódia comprimida (faixa de F0 × 0,2, PSOLA)", "FAIL", ["v4.f0_sd"], lambda: psola("N25", mid, 0.2), base=mid["source"])

    def wrong_number():
        for c in pos:
            words = c["text"].split()
            for k, w in enumerate(words):
                s = strip(w)
                if s in NUM_SWAP:
                    rep = NUM_SWAP[s] + re.sub(r"^[\wÀ-ÿ]+", "", w)
                    script = " ".join(words[:k] + [rep] + words[k + 1:])
                    return B.build("N13", c["path"], script, reference=c["path"]), f"{w}->{rep}"
        words = P["text"].split()  # fallback: negation absent from the audio
        script = " ".join(words[:1] + ["não"] + words[1:])
        return B.build("N13", P["path"], script, reference=P["path"]), "negacao_inserida"
    def n13():
        info, how = wrong_number()
        info["how"] = how
        res["notes"].append(f"N13 troca crítica: {how}")
        return info
    safe("N13", "negative", "palavra crítica errada (número trocado no roteiro aprovado)", "FAIL", ["v2.critical_terms"], n13)

    def brand_word():
        words = P["text"].split()
        k = max(range(1, len(words)), key=lambda i: len(strip(words[i])))
        script = " ".join(words[:k] + ["ZEVANORY"] + words[k + 1:])
        return B.build("N14", P["path"], script, reference=P["path"], critical_terms=["ZEVANORY"])
    safe("N14", "negative", "marca crítica ausente na fala (ZEVANORY no roteiro, não falada)", "FAIL", ["v2.critical_terms"], brand_word, base=P["source"])

    def leak():
        c = max(pos, key=lambda c: len(c["text"].split()))
        words = c["text"].split()
        style = " ".join(words[:5])
        voice = dict(HUMAN_VOICE, style=style)
        return B.build("N15", c["path"], " ".join(words[5:]), reference=c["path"], voice=voice)
    safe("N15", "negative", "instrução de estilo lida em voz alta antes do texto", "FAIL", ["v2.instruction_leak"], leak)

    fast_base = max(pos, key=lambda c: c.get("wpm_raw", 0))
    slow_base = min(pos, key=lambda c: c.get("wpm_raw", 0))
    def tempo(cid, c, f):
        def go():
            p = os.path.join(tmp, cid + ".wav")
            ff("-i", c["path"], "-af", f"atempo={f}", "-ac", "1", p)
            return B.build(cid, p, c["text"], reference=c["path"])
        return go
    safe("N16", "negative", "fala acelerada 1,4×", "FAIL", ["v4.wpm"], tempo("N16", fast_base, 1.4), base=fast_base["source"])
    safe("N17", "negative", "fala desacelerada 0,7×", "FAIL", ["v4.wpm"], tempo("N17", slow_base, 0.7), base=slow_base["source"])

    def offset_container(d, mp4):
        out = os.path.join(d, "final_offset.mp4")
        ff("-i", mp4, "-itsoffset", "0.200", "-i", mp4, "-map", "0:v", "-map", "1:a", "-c", "copy", "-movflags", "+faststart", out)
        os.remove(mp4)
        return out
    safe("N18", "negative", "A/V deslocado 200 ms (contêiner)", "FAIL", ["v6.drift_max", "v7.caption_timing"],
         lambda: B.build("N18", P["path"], P["text"], reference=P["path"], mutate_dir=offset_container), base=P["source"])
    safe("N19", "negative", "A/V deslocado 200 ms (atraso embutido no áudio)", "FAIL", ["v6.drift_max", "v7.caption_timing"],
         lambda: B.build("N19", P["path"], P["text"], reference=P["path"], pkg={"inject_delay_s": 0.2}), base=P["source"])

    def no_caps():
        info = B.build("N20", P["path"], P["text"], reference=P["path"])
        os.remove(os.path.join(info["dir"], "captions.vtt"))
        info["manifest"] = G.write_manifest(info["dir"], info["mp4"], P["text"], HUMAN_VOICE, reference=os.path.join(info["dir"], "brand_reference.wav"), captions_style=STYLE)
        return info
    safe("N20", "negative", "legendas ausentes", "FAIL", ["v1.captions_present"], no_caps, base=P["source"])
    safe("N21", "negative", "CTA/preço de compra com VENDAS FECHADAS (descrição)", "FAIL", ["v2.sales_closed_text"],
         lambda: B.build("N21", P["path"], P["text"], reference=P["path"], texts={"title": "Lucro & Caixa", "description": "Lucro & Caixa — R$ 247,00 · Garantia de 7 dias: https://vendas.zevanory.api.br/comprar/ZEV-LCX-011"}), base=P["source"])
    safe("N22", "negative", "voz trocada (outro locutor contra a referência da marca)", "FAIL", ["v4.speaker"],
         lambda: B.build("N22", P["path"], P["text"], reference=other["path"]), base=P["source"])

    def noise_bed():
        x = x16(P)
        sp, db = G.vad_frames(x)
        n = int(G.FRAME * 16000)
        rms = np.sqrt(np.mean(np.concatenate([x[i * n:(i + 1) * n] for i in np.nonzero(sp)[0]]) ** 2))
        y = x + rng.standard_normal(len(x)) * rms / 10 ** (18 / 20)
        return B.build("N23", write_raw(os.path.join(tmp, "N23.wav"), y, 16000), P["text"], reference=P["path"])
    safe("N23", "negative", "ruído de fundo (SNR 18 dB)", "FAIL", ["v3.snr", "v3.noise_floor"], noise_bed, base=P["source"])

    def whine():
        x = x16(P)
        sp, _ = G.vad_frames(x)
        n = int(G.FRAME * 16000)
        gate = np.repeat(sp.astype(float), n)[:len(x)]
        gate = np.pad(gate, (0, len(x) - len(gate)))
        gate = np.convolve(gate, np.ones(160) / 160, mode="same")  # 10 ms ramps
        rms = np.sqrt(np.mean(np.concatenate([x[i * n:(i + 1) * n] for i in np.nonzero(sp)[0]]) ** 2))
        t = np.arange(len(x)) / 16000
        y = x + gate * np.sqrt(2) * rms * 10 ** (-4 / 20) * np.sin(2 * np.pi * 2000 * t)
        return B.build("N26", write_raw(os.path.join(tmp, "N26.wav"), y, 16000), P["text"], reference=P["path"])
    safe("N26", "negative", "artefato tonal (apito 2 kHz só durante a fala)", "FAIL", ["v3.tonal_ratio"], whine, base=P["source"])
    safe("N27", "negative", "narração curta e 6 s de silêncio no fim do vídeo", "FAIL", ["v1.narration_coverage"],
         lambda: B.build("N27", P["path"], P["text"], reference=P["path"], pkg={"tail_s": 6.0}), base=P["source"])

    def espeak_swap():
        p = os.path.join(tmp, "N24.wav")
        G.sh(["espeak-ng", "-v", "pt-br", "-s", "150", "-w", p, P["text"]])
        return B.build("N24", p, P["text"], reference=P["path"], voice=BRAND if not human else HUMAN_VOICE)
    safe("N24", "negative", "voz robótica (espeak-ng) no lugar da voz da marca", "FAIL", ["v4.speaker"], espeak_swap, base=P["source"])

    # ---- fail-closed infrastructure controls
    def no_ref():
        info = B.build("X01", P["path"], P["text"], reference=None)
        return info
    safe("X01", "infra", "referência da voz da marca ausente", "BLOCKED", ["v4.speaker"], no_ref, base=P["source"])
    try:
        info = B.build("X02", P["path"], P["text"], reference=P["path"])
        broken = G.Engines(vosk_model=os.path.join(work, "nao-existe"))
        add("X02", "infra", "motor ASR B indisponível (modelo ausente)", info, "ERROR_INFRA", ["v2.engine_b"], engines=broken, base=P["source"])
    except Exception as e:
        res["controls"].append({"id": "X02", "kind": "infra", "desc": "motor B indisponível", "expect": "ERROR_INFRA", "build_error": str(e)[:300], "M": None})

    evaluate(res, thr)
    res["elapsed_s"] = round(time.time() - t0, 1)
    json.dump(res, open(out, "w"), ensure_ascii=False, indent=1, default=float)
    return res


def strip(w):
    return G.strip_accents(re.sub(r"[^\wÀ-ÿ]", "", w.lower()))


def espeak_bases(dest):
    os.makedirs(dest, exist_ok=True)
    texts = ["Hoje vamos ver uma dica simples para organizar o caixa da sua loja sem perder tempo com planilhas complicadas no fim do dia.",
             "Anote cada venda no mesmo lugar e confira o saldo toda noite, assim você descobre rápido onde o dinheiro está escapando.",
             "Se o cliente pedir desconto, explique o que está incluído no serviço e mostre com calma o valor do seu trabalho."]
    out = []
    for i, t in enumerate(texts):
        p = os.path.join(dest, f"e{i}.wav")
        try:
            G.sh(["espeak-ng", "-v", "pt-br", "-s", "150", "-w", p, t])
            out.append({"path": p, "text": t, "gender": "MALE" if i % 2 else "FEMALE", "id": f"e{i}", "source": "espeak-ng (wiring only)", "wpm_raw": 150})
        except Exception:
            pass
    return out


# ------------------------------------------------------------------------------------------- evaluation
MUTANTS = [
    {"id": "M01", "desc": "sem VAD (presença de fala, pausas, silêncio inicial)", "disable": ["vad"]},
    {"id": "M02", "desc": "sem ASR (WER/CER, termos críticos, vazamento, CTA falado)", "disable": ["asr"]},
    {"id": "M03", "desc": "aceita TP do derivado até −0,3 dBTP", "overrides": {"V3.stream_tp_max": -0.3}},
    {"id": "M04", "desc": "sem checagem espectral/tonalidade/HNR", "disable": ["spectral"]},
    {"id": "M05", "desc": "sem loudness integrado", "disable": ["loudness"]},
    {"id": "M06", "desc": "sem prosódia (F0/energia)", "disable": ["prosody"]},
    {"id": "M07", "desc": "sem taxa de fala", "disable": ["rate"]},
    {"id": "M08", "desc": "sem sincronia (deriva A/V + tempo de legenda)", "disable": ["sync"]},
    {"id": "M09", "desc": "sem exigência de legendas", "disable": ["captions"]},
    {"id": "M10", "desc": "sem clipping", "disable": ["clipping"]},
    {"id": "M11", "desc": "sem identidade do locutor", "disable": ["speaker"]},
    {"id": "M12", "desc": "sem regra de VENDAS FECHADAS", "disable": ["compliance"]},
    {"id": "M13", "desc": "sem ruído/SNR", "disable": ["noise"]},
    {"id": "M14", "desc": "BLOCKED tratado como PASS", "policy": {"blocked_as_pass": True}},
    {"id": "M15", "desc": "ERROR_INFRA tratado como PASS", "policy": {"error_as_pass": True}},
    {"id": "M16", "desc": "sem presença de narração (V1)", "disable": ["narration"]},
]


def correct(ctrl, verdict, failed):
    e = ctrl["expect"]
    if e == "ANY":
        return True
    if e == "PASS":
        return verdict == "PASS"
    if e == "FAIL":
        return verdict == "FAIL"
    return verdict == e


def evaluate(res, thr):
    base = {}
    for c in res["controls"]:
        if c.get("M") is None:
            c["verdict"], c["failed"], c["correct"] = "ERROR_INFRA", [], False
            c["expected_stage_hit"] = False
            continue
        prof = "controls"
        D = G.decide(c["M"], thr, profile=prof)
        c["verdict"], c["failed"], c["blocked"], c["errors"] = D["verdict"], D["failed"], D["blocked"], D["errors"]
        c["correct"] = correct(c, D["verdict"], D["failed"])
        hit = set(D["failed"] + D["blocked"] + D["errors"])
        c["expected_stage_hit"] = (not c["expect_checks"]) or bool(hit & set(c["expect_checks"]))
        base[c["id"]] = D["verdict"]
    for m in MUTANTS:
        flips = []
        for c in res["controls"]:
            if c.get("M") is None or c["expect"] == "ANY":
                continue
            D = G.decide(c["M"], thr, profile="controls", disable=m.get("disable", ()), overrides=m.get("overrides"), policy=m.get("policy"))
            neg = c["expect"] != "PASS"
            # killed only by a control that was correctly classified at baseline and is misclassified under the mutant
            if c["correct"] and ((neg and D["verdict"] == "PASS") or (not neg and D["verdict"] != "PASS")):
                flips.append(f'{c["id"]}:{base.get(c["id"])}->{D["verdict"]}')
        res["mutants"].append({"id": m["id"], "desc": m["desc"], "killed": bool(flips), "killed_by": flips})
    cs = res["controls"]
    res["summary"] = {
        "positives": sum(1 for c in cs if c["kind"] == "positive"),
        "positives_pass": sum(1 for c in cs if c["kind"] == "positive" and c["verdict"] == "PASS"),
        "negatives": sum(1 for c in cs if c["kind"] == "negative"),
        "negatives_rejected": sum(1 for c in cs if c["kind"] == "negative" and c["verdict"] == "FAIL"),
        "negatives_expected_stage": sum(1 for c in cs if c["kind"] == "negative" and c["verdict"] == "FAIL" and c["expected_stage_hit"]),
        "infra": sum(1 for c in cs if c["kind"] == "infra"),
        "infra_correct": sum(1 for c in cs if c["kind"] == "infra" and c["correct"]),
        "misclassified": [c["id"] for c in cs if not c["correct"]],
        "mutants": len(res["mutants"]), "mutants_killed": sum(1 for m in res["mutants"] if m["killed"]),
        "mutants_survived": [m["id"] for m in res["mutants"] if not m["killed"]],
        "human_positives": res.get("base_source", "").startswith("google/fleurs"),
    }


# ------------------------------------------------------------------------------------------ annotations
def key_metrics(M):
    if not M:
        return "sem medições"
    g = lambda *ks: _dig(M, ks)
    a = M.get("asr") or {}
    r = lambda v, n=2: None if v is None else round(v, n)
    parts = {
        "wA": r(a.get("wer_a")), "wB": r(a.get("wer_b")), "wC": r(a.get("wer_consensus"), 3), "cC": r(a.get("cer_consensus"), 3),
        "crit": a.get("critical_missed"), "LUFS": r(g("stream_loudness", "lufs"), 1), "TP": r(g("stream_loudness", "tp"), 1),
        "mL": r(g("master_loudness", "lufs"), 1), "mTP": r(g("master_loudness", "tp"), 1), "clip": M.get("stream_clipped_samples"),
        "dens": r(M.get("master_clip_density"), 4), "nf": r(g("timeline", "noise_floor_dbfs"), 1), "snr": r(g("timeline", "snr_db"), 1),
        "sr": r(g("timeline", "speech_ratio")), "lead": r(g("timeline", "first_onset_s")), "pmax": r(g("timeline", "pause_max_ms"), 0),
        "flat": r(g("spectral", "spectral_flatness"), 3), "ton": r(g("spectral", "tonal_ratio"), 3), "vf": r(g("prosody", "voiced_fraction")),
        "hnr": r(g("prosody", "hnr_db"), 1), "f0sd": r(g("prosody", "f0_sd_st")), "esd": r(g("timeline", "energy_sd_db"), 1),
        "wpm": r(g("rate", "wpm"), 0), "win": [r(g("rate", "win_wpm_min"), 0), r(g("rate", "win_wpm_max"), 0)],
        "spk": r(M.get("speaker_cos")), "ovrl": r(g("dnsmos", "ovrl")), "sig": r(g("dnsmos", "sig")), "bak": r(g("dnsmos", "bak")),
        "capΔ": (M.get("captions") or {}).get("deltas_ms", [])[:6], "off": r(M.get("container_offset_ms"), 0),
        "err": list((M.get("errors") or {}).keys())[:4],
    }
    return " ".join(f"{k}={v}" for k, v in parts.items() if v not in (None, [], [None, None]))


def _dig(d, ks):
    for k in ks:
        if not isinstance(d, dict):
            return None
        d = d.get(k)
    return d


def annotate(results, what):
    R = json.load(open(results, encoding="utf-8"))
    s = R.get("summary") or {}
    if what == "summary":
        ok = not s.get("misclassified") and not s.get("mutants_survived") and s.get("human_positives")
        lvl = "notice" if ok else "error"
        note(lvl, "AV_GATE_V8_SUMMARY",
             f"base={R.get('base_source')} positivos {s.get('positives_pass')}/{s.get('positives')} PASS | negativos rejeitados "
             f"{s.get('negatives_rejected')}/{s.get('negatives')} (estágio esperado {s.get('negatives_expected_stage')}) | infra "
             f"{s.get('infra_correct')}/{s.get('infra')} | mutantes mortos {s.get('mutants_killed')}/{s.get('mutants')} "
             f"sobreviventes={s.get('mutants_survived')} | mal classificados={s.get('misclassified')} | {R.get('elapsed_s')} s")
        note("notice", "AV_GATE_V8_SOURCES", f"human_attempts={R.get('human_source_attempts')} candidates={R.get('human_candidates')} "
             f"screened={R.get('human_screened')} stats={R.get('human_screen_stats')} engines={R.get('engines')} notes={R.get('notes')}")
        return 0 if ok else 1
    sel = {"positives": ("positive", "wiring"), "negatives": ("negative",), "infra": ("infra",)}.get(what)
    if sel:
        rows = [c for c in R["controls"] if c["kind"] in sel]
        for i in range(0, len(rows), 3):
            chunk = rows[i:i + 3]
            msg = "\n".join(
                f'{c["id"]} [{c["desc"]}] esperado={c["expect"]} veredito={c.get("verdict")} {"OK" if c.get("correct") else "ERRADO"}'
                f' estágio={"sim" if c.get("expected_stage_hit") else "NÃO"} falhas={c.get("failed", [])[:8]} bloqueios={c.get("blocked", [])[:4]}'
                f' erros={c.get("errors", [])[:4]} {c.get("build_error", "")}\n   {key_metrics(c.get("M"))}' for c in chunk)
            bad = any(not c.get("correct") for c in chunk)
            note("error" if bad else "notice", f"AV_GATE_V8_{what.upper()}", msg)
        return 0
    if what == "mutants":
        ms = R["mutants"]
        for i in range(0, len(ms), 6):
            chunk = ms[i:i + 6]
            msg = "\n".join(f'{m["id"]} {m["desc"]}: {"MORTO" if m["killed"] else "SOBREVIVEU"} por {m["killed_by"][:4]}' for m in chunk)
            note("error" if any(not m["killed"] for m in chunk) else "notice", "AV_GATE_V8_MUTANTS", msg)
        return 0
    if what == "asr":
        rows = [c for c in R["controls"] if c.get("M")]
        for i in range(0, len(rows), 6):
            msg = "\n".join(f'{c["id"]} A="{((c["M"].get("asr") or {}).get("a_text") or "")[:90]}" B="{((c["M"].get("asr") or {}).get("b_text") or "")[:90]}"' for c in rows[i:i + 6])
            note("notice", "AV_GATE_V8_ASR", msg)
        return 0
    return 2


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    a1 = sub.add_parser("run")
    a1.add_argument("--work", required=True)
    a1.add_argument("--out", required=True)
    a2 = sub.add_parser("annotate")
    a2.add_argument("--results", required=True)
    a2.add_argument("--what", required=True)
    a = ap.parse_args()
    if a.cmd == "run":
        r = run(a.work, a.out)
        return 0 if r.get("summary") else 3
    return annotate(a.results, a.what)


if __name__ == "__main__":
    sys.exit(main())
