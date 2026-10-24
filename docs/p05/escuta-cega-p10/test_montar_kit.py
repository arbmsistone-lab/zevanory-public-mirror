"""Testes do kit de escuta cega v2 (sem rede e sem áudio real): fontes distintas, pacotes embaralhados por avaliador,
selo com sal secreto verificável e regra de decisão pré-registrada. Rodar: python -m unittest docs/p05/escuta-cega-p10/test_montar_kit.py"""
import os, random, sys, tempfile, unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import montar_kit as K  # noqa: E402


class Kit(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = self.tmp.name
        self.itens = []
        for papel, esperado in (("pendente", None), ("limpo", []), ("trocado", [{"posicao": 1, "no_audio": "de", "no_texto": "do"}, {"posicao": 4, "no_audio": "a", "no_texto": "o"}])):
            p = os.path.join(d, papel + ".wav")
            open(p, "wb").write(os.urandom(64))
            self.itens.append({"papel": papel, "wav": p, "texto": "texto " + papel, "esperado": esperado})

    def tearDown(self):
        self.tmp.cleanup()

    def test_distinct_sources_required(self):
        bad = [dict(self.itens[0]), dict(self.itens[1]), dict(self.itens[2], wav=self.itens[1]["wav"])]
        with self.assertRaises(ValueError):
            K.build_packages(bad, os.path.join(self.tmp.name, "o1"))

    def test_per_rater_packages_and_salted_seal(self):
        out = os.path.join(self.tmp.name, "o2")
        gab, selo, sal = K.build_packages(self.itens, out, 5, rng=random.Random(1))
        self.assertEqual(len(gab["avaliadores"]), 5)
        tokens = [set(m) for m in gab["avaliadores"].values()]
        self.assertEqual(len(set().union(*tokens)), 15, "nomes de arquivo próprios por avaliador")
        ordens = {tuple(v["papel"] for v in m.values()) for m in gab["avaliadores"].values()}
        self.assertGreater(len(ordens), 1, "ordens embaralhadas por avaliador")
        for n, m in gab["avaliadores"].items():
            self.assertEqual(sorted(os.listdir(os.path.join(out, f"avaliador_{n}"))), sorted([t + ".wav" for t in m] + ["folha.md"]))
        self.assertTrue(K.verify_seal(sal, gab, selo))
        self.assertFalse(K.verify_seal("00" * 32, gab, selo), "sem o sal o selo não confere")
        gab2 = dict(gab, fontes=dict(gab["fontes"], pendente="x"))
        self.assertFalse(K.verify_seal(sal, gab2, selo), "gabarito adulterado")
        self.assertEqual(len(sal), 64)

    def test_pre_registered_decision(self):
        gab, _, _ = K.build_packages(self.itens, os.path.join(self.tmp.name, "o3"), 5, rng=random.Random(2))
        def resp(pendente_ok, n_ok=5, controles_ok=True):
            r = {}
            for i, (av, m) in enumerate(gab["avaliadores"].items()):
                rr = {}
                for tok, v in m.items():
                    if v["papel"] == "pendente" and pendente_ok and i < n_ok:
                        rr[tok] = {"desta", "podem"}
                    if v["papel"] == "trocado" and controles_ok:
                        rr[tok] = {"do", "o"}
                r[av] = rr
            return r
        self.assertEqual(K.decide(resp(True, 5), gab), "VERDADEIRO_NEGATIVO")
        self.assertEqual(K.decide(resp(True, 4), gab), "VERDADEIRO_NEGATIVO")
        self.assertEqual(K.decide(resp(True, 3), gab), "FALLBACK_FALSE_DENY_PROVAVEL")
        self.assertEqual(K.decide(resp(True, 5, controles_ok=False), gab), "FALLBACK_REPETIR_COM_NOVOS_AVALIADORES")

    def test_swap_needs_two_words(self):
        txt, trocas = K.altera("o caderno de notas para a escola", random.Random(3))
        self.assertEqual(len(trocas), 2)
        with self.assertRaises(ValueError):
            K.altera("palavra nenhuma aqui", random.Random(3))


if __name__ == "__main__":
    unittest.main()
