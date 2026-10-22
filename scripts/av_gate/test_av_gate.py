"""Unit tests of the pure parts of zevanory-av-gate (no models needed): normalisation, alignment, consensus,
the decision layer and its fail-closed policy. Run: python -m unittest -v scripts/av_gate/test_av_gate.py"""
import copy, json, os, sys, tempfile, unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import zevanory_av_gate as G  # noqa: E402

THR = G.load_thresholds()


def good_M():
    return {
        "errors": {}, "mp4_present": True, "manifest_present": True, "manifest_missing": [],
        "hash_ok": {"mp4_sha256": True, "master_sha256": True, "captions_sha256": True, "script_sha256": True},
        "manifest": {"voice": dict(THR["brand_voice"]), "sales_mode": "closed",
                     "captions_style": {"font_color": "#F5F7FB", "background_color": "#0C1C2B", "box": [96, 1150, 768, 240]}},
        "audio_stream": True, "master_present": True, "captions_present": True, "script_present": True, "reference_present": True,
        "video": {"width": 1080, "height": 1920, "start": 0.0}, "black_s": 0.0, "duration_s": 14.0,
        "audio": {"codec": "aac", "rate": 48000, "start": 0.0}, "container_offset_ms": 0.0,
        "stream_loudness": {"lufs": -17.5, "tp": -2.4, "lra": 6.0}, "stream_clipped_samples": 0,
        "master_loudness": {"lufs": -23.0, "tp": -6.0}, "master_rate": 48000, "master_duration_s": 14.0, "master_clip_density": 0.0002,
        "audio_duration_s": 14.0,
        "timeline": {"speech_s": 10.5, "segments": 8, "first_onset_s": 0.15, "last_offset_s": 12.8, "speech_ratio": 0.83,
                     "pauses_ms": [240, 330, 410], "pause_max_ms": 410, "pause_median_ms": 330, "noise_floor_dbfs": -68.0,
                     "speech_level_dbfs": -22.0, "snr_db": 46.0, "energy_sd_db": 7.5},
        "spectral": {"spectral_flatness": 0.08, "tonal_ratio": 0.06}, "prosody": {"voiced_fraction": 0.6, "f0_sd_st": 3.1, "hnr_db": 11.0},
        "dnsmos": {"sig": 3.4, "bak": 3.9, "ovrl": 3.0},
        "asr": {"wer_a": 0.08, "wer_b": 0.15, "wer_consensus": 0.0, "cer_consensus": 0.0, "critical_missed": [], "critical_inserted": [],
                "instruction_leak": [], "sales_spoken_hits": []},
        "rate": {"wpm": 150.0, "win_wpm_min": 140.0, "win_wpm_max": 162.0}, "speaker_cos": 0.82,
        "captions": {"cues": 6, "measurable": 6, "deltas_ms": [0, 10, -20, 30, 0, 5], "script_wer": 0.0, "max_line_chars": 34, "max_lines": 1, "mean_cps": 14.0},
        "sales_text_hits": [],
    }


class Normalisation(unittest.TestCase):
    def test_numbers(self):
        self.assertEqual(G.spell_int(197), "cento e noventa e sete")
        self.assertEqual(G.spell_int(1250), "mil duzentos e cinquenta")
        self.assertEqual(G.spell_int(2000), "dois mil")
        self.assertEqual(G.spell_int(100), "cem")

    def test_money_url_accents(self):
        t, f = G.normalize_tokens("Só R$ 197,00 em vendas.zevanory.api.br", mark=True)
        self.assertEqual(t, "so cento e noventa e sete reais em vendas ponto zevanory ponto api ponto br".split())
        self.assertTrue(all(f[1:6]))

    def test_lexicon(self):
        self.assertEqual(G.normalize_tokens("a zé vanori chegou", {"ZEVANORY": ["zé vanori"]}), ["a", "zevanory", "chegou"])


class Consensus(unittest.TestCase):
    def test_word_heard_by_one_engine_is_not_an_error(self):
        ref = "o preco e cento e noventa e sete reais".split()
        cons, heard, ins = G.consensus(ref, "o preco e cento e noventa e oito reais".split(), "o preso e cento noventa e sete reais".split())
        self.assertEqual(G.wer(ref, cons), 0.0)
        self.assertTrue(all(heard))

    def test_word_missed_by_both_is_an_error(self):
        ref = "custa tres reais".split()
        cons, heard, _ = G.consensus(ref, "custa quatro reais".split(), "custa quatro reais".split())
        self.assertFalse(heard[1])
        self.assertAlmostEqual(G.wer(ref, cons), 1 / 3)

    def test_shared_insertion_counts(self):
        ref = "texto aprovado aqui".split()
        cons, _, ins = G.consensus(ref, "fale com voz natural texto aprovado aqui".split(), "fale com voz natural texto aprovado aqui".split())
        self.assertEqual(ins, ["fale", "com", "voz", "natural"])
        self.assertGreater(G.wer(ref, cons), 1.0)


class Decision(unittest.TestCase):
    def v(self, M, **kw):
        return G.decide(M, THR, **kw)

    def test_good_is_pass(self):
        d = self.v(good_M())
        self.assertEqual(d["verdict"], "PASS", d["failed"] + d["blocked"] + d["errors"])

    def test_each_defect_fails(self):
        cases = {
            "v3.stream_tp": lambda M: M["stream_loudness"].update(tp=-1.0),
            "v3.stream_lufs": lambda M: M["stream_loudness"].update(lufs=-30.0),
            "v3.master_lufs": lambda M: M["master_loudness"].update(lufs=-21.0),
            "v3.clipped_samples": lambda M: M.update(stream_clipped_samples=12),
            "v3.noise_floor": lambda M: M["timeline"].update(noise_floor_dbfs=-40.0),
            "v3.tonal_ratio": lambda M: M["spectral"].update(tonal_ratio=0.9),
            "v2.consensus_wer": lambda M: M["asr"].update(wer_consensus=0.06),
            "v2.critical_terms": lambda M: M["asr"].update(critical_missed=["tres"]),
            "v2.instruction_leak": lambda M: M["asr"].update(instruction_leak=["a:style:fale com voz"]),
            "v4.wpm": lambda M: M["rate"].update(wpm=205.0),
            "v4.pause_max": lambda M: M["timeline"].update(pause_max_ms=1800),
            "v4.f0_sd": lambda M: M["prosody"].update(f0_sd_st=0.3),
            "v4.speaker": lambda M: M.update(speaker_cos=0.1),
            "v7.caption_timing": lambda M: M["captions"].update(deltas_ms=[-200] * 6),
            "v2.sales_closed_text": lambda M: M.update(sales_text_hits=["/comprar"]),
            "v1.voice_single_brand": lambda M: M["manifest"].update(voice={"provider": "piper", "model": "pt_BR-faber-medium", "voice": "x"}),
            "v1.audio_stream": lambda M: M.update(audio_stream=False),
            "v1.captions_present": lambda M: M.update(captions_present=False),
            "v1.narration_coverage": lambda M: M["timeline"].update(last_offset_s=5.0),
            "v3.clip_density": lambda M: M.update(master_clip_density=8.0),
        }
        for cid, mut in cases.items():
            M = good_M()
            mut(M)
            d = self.v(M)
            self.assertEqual(d["verdict"], "FAIL", cid)
            self.assertIn(cid, d["failed"], cid)

    def test_missing_metric_blocks_and_tool_error_is_infra(self):
        M = good_M()
        M["dnsmos"] = None
        self.assertEqual(self.v(M)["verdict"], "BLOCKED")
        M = good_M()
        M["asr"]["wer_b"] = None
        M["asr"].pop("wer_consensus")
        M["errors"]["engine_b"] = "engine_b_model_missing"
        self.assertEqual(self.v(M)["verdict"], "ERROR_INFRA")
        M = good_M()
        M["reference_present"] = False
        d = self.v(M)
        self.assertEqual(d["verdict"], "BLOCKED")
        self.assertIn("v4.speaker", d["blocked"])

    def test_unconsumed_error_never_passes(self):
        M = good_M()
        M["errors"]["something_new"] = "boom"
        self.assertEqual(self.v(M)["verdict"], "ERROR_INFRA")

    def test_mutation_hooks(self):
        M = good_M()
        M["stream_loudness"]["tp"] = -1.0
        self.assertEqual(self.v(M, overrides={"V3.stream_tp_max": -0.3})["verdict"], "PASS")
        M = good_M()
        M["reference_present"] = False
        self.assertEqual(self.v(M, policy={"blocked_as_pass": True})["verdict"], "PASS")
        M = good_M()
        M["timeline"]["pause_max_ms"] = 1800
        self.assertEqual(self.v(M, disable=["vad"])["verdict"], "PASS")

    def test_controls_profile_only_widens_voices_for_controls(self):
        M = good_M()
        M["manifest"]["voice"] = {"provider": "human-reference", "model": "fleurs-pt_br", "voice": "speaker"}
        self.assertEqual(self.v(M)["verdict"], "FAIL")
        self.assertEqual(self.v(M, profile="controls")["verdict"], "PASS")


class Captions(unittest.TestCase):
    def test_cues_and_parse(self):
        words = "Hoje vamos ver uma dica simples. Anote cada venda no mesmo lugar.".split()
        times = [(i * 0.4, i * 0.4 + 0.3) for i in range(len(words))]
        cues = G.make_cues(words, times)
        self.assertTrue(all(len(c["text"]) <= 36 for c in cues))
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "c.vtt")
            G.write_vtt(p, cues)
            back = G.parse_captions(p)
        self.assertEqual(" ".join(c["text"] for c in back), " ".join(words))
        self.assertAlmostEqual(back[0]["start"], 0.0, places=2)

    def test_contrast(self):
        self.assertGreater(G.wcag_contrast("#F5F7FB", "#0C1C2B"), 4.5)
        self.assertLess(G.wcag_contrast("#777777", "#888888"), 2)


if __name__ == "__main__":
    unittest.main()
