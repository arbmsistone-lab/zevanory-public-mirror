#!/usr/bin/env python3
"""G4 (Ordem 082): suíte do guarda dos checks obrigatórios (scripts/ci/required_check_guard.py).
Uso: python3 -I tests/ci/test_required_check_guard.py <RAIZ_DO_REPO> [--guard CAMINHO_DO_GUARDA] [--json-report ARQ]
--guard permite rodar a mesma suíte contra um mutante (tests/ci/mutants_required_check_guard.py).
--json-report grava o resultado POR TESTE (ok / falha de asserção / erro / pulado) para o executor de mutantes classificar.
Se o guarda nem carregar (dependência ausente, erro de sintaxe, sys.exit no import), o relatório NÃO é gravado: o executor
trata a ausência como INCONCLUSIVO, nunca como mutante morto."""
import importlib.util, json, os, pathlib, re, subprocess, sys, tempfile, traceback, unittest

REPO = pathlib.Path(sys.argv.pop(1)).resolve()
GUARD = REPO / 'scripts/ci/required_check_guard.py'
if '--guard' in sys.argv:
    i = sys.argv.index('--guard'); GUARD = pathlib.Path(sys.argv[i + 1]).resolve(); del sys.argv[i:i + 2]
RELATORIO = None
if '--json-report' in sys.argv:
    i = sys.argv.index('--json-report'); RELATORIO = sys.argv[i + 1]; del sys.argv[i:i + 2]
spec = importlib.util.spec_from_file_location('guarda', GUARD); G = importlib.util.module_from_spec(spec); spec.loader.exec_module(G)
WF = REPO / '.github/workflows'
SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
OUTRO = 'ffffffffffff0718293a4b5c6d7e8f9012345678'
OWNER = 'arbmsistone-lab'


def base(nome):
    return (WF / nome).read_text()


def arq(nome, status='modified', anterior=None):
    d = {'filename': nome, 'status': status}
    if anterior: d['previous_filename'] = anterior
    return d


def rotulo(sha=SHA, ator=OWNER, remover=False):
    nome = 'owner-approved:' + sha[:12]
    ev = [{'event': 'labeled', 'label': {'name': nome}, 'actor': {'login': ator}}]
    if remover: ev.append({'event': 'unlabeled', 'label': {'name': nome}, 'actor': {'login': ator}})
    return ([] if remover else [nome]), ev


def rodar(arquivos, head=None, labels=(), eventos=(), sha=SHA, esperado=None):
    return G.avaliar(arquivos, head or {}, sha, list(labels), list(eventos), esperado)


def novo_wf(job_name, extra=''):
    return f"name: x\non:\n  pull_request:\n    branches: [gh-pages]\njobs:\n  j:\n    name: {job_name}\n    runs-on: ubuntu-latest\n{extra}    steps:\n      - run: exit 0\n"


class Guarda(unittest.TestCase):
    def ok(self, r): self.assertEqual(r['resultado'], 'PASS', json.dumps(r, ensure_ascii=False))
    def falha(self, r, codigo=None, duro=True):
        self.assertEqual(r['resultado'], 'FAIL', json.dumps(r, ensure_ascii=False))
        if codigo: self.assertTrue(any(v.startswith(codigo) for v in r['violacoes_duras']),
                                   f"codigo {codigo} ausente em {r['violacoes_duras']}")
        if duro is False: self.assertEqual(r['violacoes_duras'], [])

    # --- conteúdo comum passa; caminho protegido exige aprovação presa ao SHA ---
    def test_T01_conteudo_comum_passa(self):
        self.ok(rodar([arq('index.html'), arq('ia-para-padaria/index.html'), arq('scripts/novo_relatorio.py', 'added')]))

    def test_T02_editar_workflow_obrigatorio_sem_rotulo_falha(self):
        h = base('product-pages-premerge.yml').replace('timeout-minutes: 5', 'timeout-minutes: 6')
        self.falha(rodar([arq('.github/workflows/product-pages-premerge.yml')], {'product-pages-premerge.yml': h}), duro=False)

    def test_T03_editar_workflow_obrigatorio_com_rotulo_do_dono_passa(self):
        h = base('product-pages-premerge.yml').replace('timeout-minutes: 5', 'timeout-minutes: 6')
        l, e = rotulo()
        self.ok(rodar([arq('.github/workflows/product-pages-premerge.yml')], {'product-pages-premerge.yml': h}, l, e))

    def test_T04_rotulo_de_outro_sha_falha(self):
        l, e = rotulo(OUTRO)
        self.falha(rodar([arq('scripts/zees16_evidence_gate.py')], labels=l, eventos=e), duro=False)

    def test_T05_rotulo_aplicado_por_nao_dono_falha(self):
        l, e = rotulo(ator='Copilot')
        self.falha(rodar([arq('scripts/zees16_evidence_gate.py')], labels=l, eventos=e), duro=False)

    def test_T06_rotulo_removido_ou_sem_evento_falha(self):
        l, e = rotulo(remover=True)
        self.falha(rodar([arq('scripts/zees16_evidence_gate.py')], labels=['owner-approved:' + SHA[:12]], eventos=e))
        self.falha(rodar([arq('scripts/zees16_evidence_gate.py')], labels=['owner-approved:' + SHA[:12]], eventos=[]))

    def test_T07_scripts_e_politicas_dos_checks_sao_protegidos(self):
        for c in G.REQUIRED_SCRIPTS + ('scripts/ci/merge_impact.py', 'compliance/zevanory-crown-policy.json',
                                       'compliance/zevanory-10p-policy.json', 'tests/ci/x.py', '.github/CODEOWNERS',
                                       'CODEOWNERS', 'docs/CODEOWNERS', '.github/actions/a/action.yml'):
            self.falha(rodar([arq(c)]), duro=False)
            l, e = rotulo(); self.ok(rodar([arq(c)], labels=l, eventos=e))

    # --- violações duras: nenhum rótulo libera ---
    def test_T08_novo_workflow_com_mesmo_nome_de_check_falha_mesmo_com_rotulo(self):
        l, e = rotulo()
        for nome in G.REQUIRED_CHECKS:
            self.falha(rodar([arq('.github/workflows/sombra.yml', 'added')], {'sombra.yml': novo_wf(nome)}, l, e),
                       'COLISAO_DE_NOME')

    def test_T09_nome_dinamico_que_pode_colidir_falha(self):
        self.falha(rodar([arq('.github/workflows/m.yml', 'added')], {'m.yml': novo_wf("'product-pages / ${{ matrix.n }}'")}),
                   'COLISAO_DE_NOME')
        self.falha(rodar([arq('.github/workflows/m.yml', 'added')], {'m.yml': novo_wf("'${{ inputs.n }}'")}), 'COLISAO_DE_NOME')
        # nome dinâmico que não pode colidir não é duro
        self.falha(rodar([arq('.github/workflows/m.yml', 'added')], {'m.yml': novo_wf("'build ${{ matrix.n }}'")}), duro=False)

    def test_T10_job_em_outro_arquivo_canonico_com_outro_id_falha(self):
        h = base('required-status-compat.yml').replace('  zees-status:', '  zees-clone:\n    name: zees16-evidence / fail-closed\n    runs-on: ubuntu-latest\n    steps:\n      - run: exit 0\n  zees-status:', 1)
        self.falha(rodar([arq('.github/workflows/required-status-compat.yml')], {'required-status-compat.yml': h}), 'COLISAO_DE_NOME')

    def test_T11_job_obrigatorio_condicional_falha(self):
        l, e = rotulo()
        h = base('product-pages-premerge.yml').replace('    runs-on: ubuntu-latest\n', '    if: false\n    runs-on: ubuntu-latest\n', 1)
        self.falha(rodar([arq('.github/workflows/product-pages-premerge.yml')], {'product-pages-premerge.yml': h}, l, e),
                   'JOB_OBRIGATORIO_CONDICIONAL')

    def test_T12_passo_condicional_ou_continue_on_error_falha(self):
        l, e = rotulo()
        h = base('required-status-compat.yml').replace('      - name: Validate ZEES-16 evidence registry\n',
                                                       '      - name: Validate ZEES-16 evidence registry\n        if: false\n')
        self.falha(rodar([arq('.github/workflows/required-status-compat.yml')], {'required-status-compat.yml': h}, l, e),
                   'PASSO_OBRIGATORIO_IF')
        h = base('required-status-compat.yml').replace('    timeout-minutes: 4\n', '    timeout-minutes: 4\n    continue-on-error: true\n')
        self.falha(rodar([arq('.github/workflows/required-status-compat.yml')], {'required-status-compat.yml': h}, l, e),
                   'JOB_OBRIGATORIO_CONTINUE_ON_ERROR')

    def test_T13_filtro_de_caminho_ou_gatilho_removido_falha(self):
        l, e = rotulo()
        h = base('product-pages-premerge.yml').replace('    branches:\n      - gh-pages\n', '    branches:\n      - gh-pages\n    paths:\n      - "nada/**"\n', 1)
        self.falha(rodar([arq('.github/workflows/product-pages-premerge.yml')], {'product-pages-premerge.yml': h}, l, e),
                   'GATILHO_OBRIGATORIO_FILTRADO')
        h = base('required-status-compat.yml').replace('  pull_request:\n    branches:\n      - gh-pages\n', '')
        self.falha(rodar([arq('.github/workflows/required-status-compat.yml')], {'required-status-compat.yml': h}, l, e),
                   'GATILHO_OBRIGATORIO_REMOVIDO')
        h = base('required-check-guard.yml').replace('pull_request_target:', 'pull_request:')
        self.falha(rodar([arq('.github/workflows/required-check-guard.yml')], {'required-check-guard.yml': h}, l, e),
                   'GATILHO_OBRIGATORIO_REMOVIDO')

    def test_T14_job_renomeado_ou_removido_falha(self):
        l, e = rotulo()
        h = base('required-status-compat.yml').replace('name: zees16-evidence / fail-closed', 'name: zees16-evidence / outro')
        self.falha(rodar([arq('.github/workflows/required-status-compat.yml')], {'required-status-compat.yml': h}, l, e),
                   'JOB_OBRIGATORIO_RENOMEADO')
        h = base('product-pages-premerge.yml').replace('  audit:', '  auditoria:')
        self.falha(rodar([arq('.github/workflows/product-pages-premerge.yml')], {'product-pages-premerge.yml': h}, l, e),
                   'JOB_OBRIGATORIO_REMOVIDO')

    def test_T15_emissor_removido_ou_renomeado_falha(self):
        l, e = rotulo()
        self.falha(rodar([arq('.github/workflows/required-status-compat.yml', 'removed')], labels=l, eventos=e),
                   'EMISSOR_OBRIGATORIO_REMOVIDO')
        self.falha(rodar([arq('.github/workflows/x.yml', 'renamed', '.github/workflows/required-check-guard.yml')],
                         {'x.yml': base('required-check-guard.yml')}, l, e), 'EMISSOR_OBRIGATORIO_REMOVIDO')
        # renomear script obrigatório para fora da área protegida também exige aprovação (o nome antigo conta)
        self.falha(rodar([arq('scripts/zees16_old.py', 'renamed', 'scripts/zees16_evidence_gate.py')]), duro=False)

    def test_T16_sombra_de_modulo_falha(self):
        l, e = rotulo()
        for c in ('scripts/json.py', 'json.py', 'scripts/__init__.py', 'scripts/ci/re.py', 'scripts/pathlib/__init__.py',
                  'scripts/hashlib.pyc', 'scripts/__pycache__/x.cpython-312.pyc', 'sitecustomize.py', 'scripts/yaml.py'):
            self.falha(rodar([arq(c, 'added')], labels=l, eventos=e), 'SOMBRA_DE_MODULO')
        for c in ('scripts/relatorio.py', 'html/index.html', 'json/dados.json', 'scripts/json_tools.py'):
            self.ok(rodar([arq(c, 'added')]))

    def test_T17_lista_truncada_yaml_invalido_nome_inesperado_falha(self):
        self.falha(rodar([arq('index.html')], esperado=3001), 'LISTA_TRUNCADA')
        self.falha(rodar([arq('.github/workflows/z.yml', 'added')], {'z.yml': 'jobs: [\n'}), 'WORKFLOW_YAML_INVALIDO')
        self.falha(rodar([arq('../etc/passwd')]), 'NOME_INESPERADO')
        self.falha(rodar([arq('index.html')], sha='abc'), 'HEAD_SHA_INVALIDO')

    def test_T18_reutilizavel_que_pode_colidir_falha(self):
        y = "on: pull_request\njobs:\n  r:\n    name: product-pages\n    uses: ./.github/workflows/outro.yml\n"
        self.falha(rodar([arq('.github/workflows/r.yml', 'added')], {'r.yml': y}), 'COLISAO_DE_NOME')

    # --- estado real do repositório ---
    def test_T19_emissores_canonicos_atuais_conformes(self):
        for nome in G.TRIGGER:
            self.assertEqual(G.analisar_workflow(nome, base(nome)), [], nome)

    def test_T20_nenhum_outro_workflow_da_base_emite_nome_obrigatorio(self):
        col = [v for f in sorted(WF.glob('*.y*ml')) for v in G.analisar_workflow(f.name, f.read_text(errors='replace'))
               if v.startswith('COLISAO')]
        self.assertEqual(col, [])

    def test_T21_workflow_do_guarda_e_seguro(self):
        import yaml
        t = base('required-check-guard.yml'); y = yaml.load(t, Loader=yaml.BaseLoader)
        self.assertIn('pull_request_target', y['on']); self.assertNotIn('pull_request', y['on'])
        self.assertEqual(y['permissions'], {'contents': 'read', 'pull-requests': 'read', 'issues': 'read'})
        passos = y['jobs']['guard']['steps']
        co = [p for p in passos if str(p.get('uses', '')).startswith('actions/checkout')]
        self.assertEqual(len(co), 1); self.assertEqual(co[0]['with']['ref'], '${{ github.event.pull_request.base.sha }}')
        self.assertNotRegex(t, r'secrets\s*[.\[]'); self.assertNotIn('head.ref', t)
        self.assertEqual(y['jobs']['guard']['name'], G.GUARD_NAME)
        for p in passos:  # expressões do evento só via env, nunca interpoladas em run:
            self.assertNotIn('${{', p.get('run', ''), p.get('name'))
        self.assertTrue({'labeled', 'unlabeled', 'synchronize'} <= set(y['on']['pull_request_target']['types']))

    def test_T22_codeowners_espelha_caminhos_protegidos(self):
        linhas = [l.split()[0] for l in (REPO / '.github/CODEOWNERS').read_text().splitlines() if l.strip() and not l.startswith('#')]
        donos = {l.split()[0]: l.split()[1:] for l in (REPO / '.github/CODEOWNERS').read_text().splitlines() if l.strip() and not l.startswith('#')}
        self.assertTrue(all(v == ['@' + OWNER] for v in donos.values()))
        for c in ('.github/workflows/a.yml', '.github/CODEOWNERS', 'scripts/ci/a.py', 'tests/ci/a.py', 'CODEOWNERS', 'docs/CODEOWNERS',
                  'compliance/zevanory-10p-policy.json', 'compliance/zevanory-crown-policy.json') + G.REQUIRED_SCRIPTS:
            self.assertTrue(G.protegido(c), c)
            self.assertTrue(any(('/' + c).startswith(p) if p.endswith('/') else ('/' + c) == p for p in linhas), c)

    def test_T23_cli_codigos_de_saida(self):
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d); (d / 'h').mkdir()
            (d / 'e.json').write_text('[[]]'); (d / 'l.json').write_text('[[]]')
            def cli(files, extra=()):
                (d / 'f.json').write_text(json.dumps([files]))
                return subprocess.run([sys.executable, '-I', str(GUARD), '--files', str(d / 'f.json'), '--head-workflows', str(d / 'h'),
                                       '--head-sha', SHA, '--labels', str(d / 'l.json'), '--events', str(d / 'e.json'), *extra],
                                      capture_output=True, text=True).returncode
            self.assertEqual(cli([arq('index.html')], ['--expected-count', '1']), 0)
            self.assertEqual(cli([arq('.github/workflows/a.yml')]), 1)
            (d / 'e.json').write_text('{quebrado'); self.assertEqual(cli([arq('index.html')]), 2)


def rodar_com_relatorio(caminho):
    """Executa a suíte e grava, por teste, o desfecho. 'falha' = AssertionError levantada pela SUÍTE (nenhum quadro do
    traceback dentro do guarda); AssertionError originada no código sob teste é registrada como 'erro'."""
    guarda = str(GUARD); testes = {}

    def registrar(t, estado, err=None, motivo=None):
        item = {'resultado': estado}
        if err is not None:
            tipo, valor, tb = err
            no_guarda = any(os.path.realpath(q.filename) == os.path.realpath(guarda) for q in traceback.extract_tb(tb))
            if estado == 'falha' and no_guarda:
                item['resultado'] = 'erro'
            item.update(tipo=tipo.__name__, mensagem=str(valor)[:4000], origem_no_guarda=no_guarda)
        if motivo is not None:
            item['mensagem'] = str(motivo)
        testes[t.id()] = item

    class Resultado(unittest.TextTestResult):
        def addSuccess(self, t): super().addSuccess(t); registrar(t, 'ok')
        def addFailure(self, t, e): super().addFailure(t, e); registrar(t, 'falha', e)
        def addError(self, t, e): super().addError(t, e); registrar(t, 'erro', e)
        def addSkip(self, t, m): super().addSkip(t, m); registrar(t, 'pulado', motivo=m)
        def addExpectedFailure(self, t, e): super().addExpectedFailure(t, e); registrar(t, 'erro', e)
        def addUnexpectedSuccess(self, t): super().addUnexpectedSuccess(t); registrar(t, 'erro', motivo='unexpected success')

    suite = unittest.defaultTestLoader.loadTestsFromTestCase(Guarda)
    r = unittest.TextTestRunner(stream=sys.stderr, verbosity=2, resultclass=Resultado).run(suite)
    dados = {'schema': 'g4-suite-report/1', 'guarda': guarda, 'testes_executados': r.testsRun,
             'sucesso': r.wasSuccessful(), 'testes': testes}
    tmp = caminho + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(dados, f, ensure_ascii=False, indent=1)
    os.replace(tmp, caminho)
    return 0 if r.wasSuccessful() else 1


if __name__ == '__main__':
    if RELATORIO:
        sys.exit(rodar_com_relatorio(RELATORIO))
    unittest.main(verbosity=2)
