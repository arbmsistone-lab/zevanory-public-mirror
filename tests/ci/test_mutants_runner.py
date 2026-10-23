#!/usr/bin/env python3
"""G4 / AVAL 090: autotestes do executor de mutantes (tests/ci/mutants_required_check_guard.py).
Provam que o executor não confunde ambiente quebrado com mutante morto.
Uso: python3 -I -B tests/ci/test_mutants_runner.py <RAIZ_DO_REPO>"""
import importlib.util, pathlib, re, subprocess, sys, unittest

REPO = pathlib.Path(sys.argv.pop(1)).resolve()
spec = importlib.util.spec_from_file_location('executor', REPO / 'tests/ci/mutants_required_check_guard.py')
M = importlib.util.module_from_spec(spec); spec.loader.exec_module(M)
SRC = (REPO / 'scripts/ci/required_check_guard.py').read_text()
PY = [sys.executable, '-I']
SEM_SITE = [sys.executable, '-I', '-S']  # sem site-packages: reproduz "PyYAML não instalado" (cenário da AVAL 090)
APROVA = M.MUTANTES['M01_aprova_sempre']
T05 = {M.T + 'T05_rotulo_aplicado_por_nao_dono_falha': M.PASS_FAIL}

MISTOS = {
    'X_dependencia_ausente': ('import yaml\n', 'import yaml_ausente_g4\n', T05),
    'X_assercao_real': M.MUTANTES['M04_qualquer_ator'],
    'X_sobrevive': ("GUARD_NAME = 'required", "GUARD_NAME =  'required", T05),
    'X_sintaxe': ('def protegido(caminho):\n', 'def protegido(caminho)\n', T05),
    'X_timeout': ('import argparse, json', 'import time; time.sleep(60)\nimport argparse, json', T05),
    'X_excecao_nao_assercao': ('def protegido(caminho):\n', "def protegido(caminho):\n    raise RuntimeError('boom')\n", T05),
    'X_assert_dentro_do_guarda': ('def protegido(caminho):\n', "def protegido(caminho):\n    assert False, 'no guarda'\n", T05),
    'X_falha_so_fora_do_esperado': ("if ator not in OWNERS:", "if False:", {M.T + 'T01_conteudo_comum_passa': '.*'}),
    'X_trecho_inexistente': ('trecho que não existe no guarda', 'x', T05),
}


class Executor(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.r = M.executar(REPO, mutantes=MISTOS, python=PY, timeout=15)

    def estado(self, nome):
        return self.r['mutantes'][nome]['estado'], self.r['mutantes'][nome]['detalhe']

    def test_E01_baseline_valido_e_registrado(self):
        self.assertEqual(self.r['baseline']['estado'], 'PASS', self.r['baseline'])

    def test_E02_mutante_com_dependencia_ausente_e_inconclusivo(self):
        e, d = self.estado('X_dependencia_ausente')
        self.assertEqual(e, M.INCONCLUSIVE, d); self.assertTrue(d.startswith('SEM_RELATORIO'), d)

    def test_E03_assercao_real_em_teste_esperado_e_morto(self):
        e, d = self.estado('X_assercao_real')
        self.assertEqual(e, M.KILLED, d); self.assertIn('T05_rotulo_aplicado_por_nao_dono_falha', d)

    def test_E04_sobrevivente_e_vivo(self):
        self.assertEqual(self.estado('X_sobrevive')[0], M.SURVIVED)
        self.assertEqual(self.r['resultado'], M.SURVIVED)  # um VIVO domina o resultado da execução

    def test_E05_sintaxe_timeout_excecao_e_assert_no_guarda_sao_inconclusivos(self):
        for nome, prefixo in (('X_sintaxe', 'SEM_RELATORIO'), ('X_timeout', 'TIMEOUT'),
                              ('X_excecao_nao_assercao', 'ERRO_NAO_ASSERCAO'),
                              ('X_assert_dentro_do_guarda', 'ERRO_NAO_ASSERCAO'),
                              ('X_falha_so_fora_do_esperado', 'FALHA_FORA_DO_ESPERADO'),
                              ('X_trecho_inexistente', 'TRECHO_NAO_ENCONTRADO')):
            e, d = self.estado(nome)
            self.assertEqual(e, M.INCONCLUSIVE, f'{nome}: {d}'); self.assertTrue(d.startswith(prefixo), f'{nome}: {d}')

    def test_E06_baseline_falhando_torna_tudo_inconclusivo(self):
        r = M.executar(REPO, guarda_src=SRC.replace(APROVA[0], APROVA[1], 1),
                       mutantes={'M04': M.MUTANTES['M04_qualquer_ator']}, python=PY, timeout=30)
        self.assertEqual(r['baseline']['estado'], M.INCONCLUSIVE); self.assertIn('BASELINE_FALHOU', r['baseline']['detalhe'])
        self.assertEqual(r['mutantes']['M04']['estado'], M.INCONCLUSIVE); self.assertEqual(r['resultado'], M.INCONCLUSIVE)

    def test_E07_cenario_da_aval_090_sem_pyyaml_nunca_mata(self):
        # pré-condição do cenário: neste interpretador sem site-packages o PyYAML de fato não importa
        p = subprocess.run(SEM_SITE + ['-c', 'import yaml'], capture_output=True, text=True)
        self.assertNotEqual(p.returncode, 0, 'pré-condição: PyYAML não deveria importar com -S')
        dois = {k: M.MUTANTES[k] for k in ('M01_aprova_sempre', 'M04_qualquer_ator')}
        # (a) com a pré-checagem: falha fechada antes de rodar qualquer coisa
        r = M.executar(REPO, mutantes=dois, python=SEM_SITE, timeout=30)
        self.assertTrue(r['baseline']['detalhe'].startswith('DEPENDENCIA_AUSENTE'), r['baseline'])
        self.assertEqual({m['estado'] for m in r['mutantes'].values()}, {M.INCONCLUSIVE})
        # (b) mesmo sem a pré-checagem: o baseline não gera relatório -> INCONCLUSIVO (defesa em profundidade)
        r = M.executar(REPO, mutantes=dois, python=SEM_SITE, timeout=30, verificar_dependencias=False)
        self.assertEqual(r['baseline']['estado'], M.INCONCLUSIVE); self.assertIn('SEM_RELATORIO', r['baseline']['detalhe'])
        self.assertEqual({m['estado'] for m in r['mutantes'].values()}, {M.INCONCLUSIVE})
        self.assertEqual(r['resultado'], M.INCONCLUSIVE)

    def test_E08_codigo_de_saida_da_cli(self):
        self.assertEqual(M.main([]), 2)

    def test_E09_dependencias_declaradas_e_allowlist_vazia(self):
        req = [re.split(r'[=<>~!]', l.strip(), 1)[0].lower() for l in (REPO / 'tests/ci/requirements-guard.txt').read_text().splitlines()
               if l.strip() and not l.startswith('#')]
        self.assertEqual(sorted(req), sorted(p.lower() for p in M.DEPENDENCIAS.values()))
        self.assertTrue(all('==' in l for l in (REPO / 'tests/ci/requirements-guard.txt').read_text().splitlines()
                            if l.strip() and not l.startswith('#')), 'versão exata obrigatória')
        self.assertEqual(M.CAUSAL_ALLOWLIST, {})

    def test_E10_todo_mutante_declara_teste_esperado_existente(self):
        suite = (REPO / 'tests/ci/test_required_check_guard.py').read_text()
        for nome, (de, para, esperados) in M.MUTANTES.items():
            self.assertTrue(esperados, nome); self.assertEqual(SRC.count(de) >= 1, True, nome)
            for t, rx in esperados.items():
                self.assertIn(f'def {t}(', suite, nome); re.compile(rx)


if __name__ == '__main__':
    unittest.main(verbosity=2)
