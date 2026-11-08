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
RESERVADOS_ARQ = REPO / 'ops/owner-reserved-paths.json'
RESERVADOS = G.carregar_reservados(RESERVADOS_ARQ)
ROTINA_RX = G.carregar_rotina(RESERVADOS_ARQ)
ROTINA = ('scripts/ci/mutants_p18.py', 'scripts/ci/mutants_p03_pages_allow.json', 'tests/ci/p16-target-lifecycle.test.mjs')


def base(nome):
    return (WF / nome).read_text()


def arq(nome, status='modified', anterior=None):
    d = {'filename': nome, 'status': status}
    if anterior: d['previous_filename'] = anterior
    return d


def rotulo(sha=SHA, ator=OWNER, remover=False, prefixo='owner-approved:'):
    nome = prefixo + sha[:12]
    ev = [{'event': 'labeled', 'label': {'name': nome}, 'actor': {'login': ator}}]
    if remover: ev.append({'event': 'unlabeled', 'label': {'name': nome}, 'actor': {'login': ator}})
    return ([] if remover else [nome]), ev


def autonomo(sha=SHA, ator=OWNER, remover=False):
    return rotulo(sha, ator, remover, 'autonomo-auditado:')


def auditoria(sha=SHA, autor=OWNER, veredito='PASS'):
    return {'user': {'login': autor}, 'body': f'Contra-auditoria independente.\nCONTRA-AUDITORIA: {veredito} {sha}\nfim'}


def rodar(arquivos, head=None, labels=(), eventos=(), sha=SHA, esperado=None, comentarios=(), reservados=RESERVADOS,
          rotina=ROTINA_RX):
    return G.avaliar(arquivos, head or {}, sha, list(labels), list(eventos), esperado, list(comentarios), reservados, rotina)


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
                                       '--head-sha', SHA, '--labels', str(d / 'l.json'), '--events', str(d / 'e.json'),
                                       '--reserved', str(RESERVADOS_ARQ), *extra],
                                      capture_output=True, text=True).returncode
            self.assertEqual(cli([arq('index.html')], ['--expected-count', '1']), 0)
            self.assertEqual(cli([arq('.github/workflows/a.yml')]), 1)
            (d / 'e.json').write_text('{quebrado'); self.assertEqual(cli([arq('index.html')]), 2)

    # --- merge autônomo (decisão do proprietário 08/11/2026 18:12): autonomo-auditado + CONTRA-AUDITORIA: PASS <SHA> ---
    def test_T24_rotina_com_rotulo_autonomo_e_auditoria_do_sha_exato_passa(self):
        l, e = autonomo()
        for c in ROTINA:
            self.assertEqual(G.reservado(c, RESERVADOS), [], c); self.assertTrue(G.protegido(c) and G.rotineiro(c, ROTINA_RX), c)
            r = rodar([arq(c)], labels=l, eventos=e, comentarios=[auditoria()])
            self.ok(r); self.assertTrue(r['aprovacao_autonoma']['valida'])
        self.ok(rodar([arq(c) for c in ROTINA], labels=l, eventos=e,
                      comentarios=[{'user': {'login': 'Copilot'}, 'body': 'x'}, auditoria()]))

    def test_T25_rotina_com_rotulo_autonomo_sem_auditoria_valida_falha(self):
        l, e = autonomo()
        c = ROTINA[0]
        self.falha(rodar([arq(c)], labels=l, eventos=e), duro=False)
        self.falha(rodar([arq(c)], labels=l, eventos=e, comentarios=[{'user': {'login': OWNER}, 'body': 'LGTM'}]), duro=False)
        # registro escrito por quem não está em OWNERS não conta
        self.falha(rodar([arq(c)], labels=l, eventos=e, comentarios=[auditoria(autor='Copilot')]), duro=False)
        self.falha(rodar([arq(c)], labels=l, eventos=e, comentarios=[{'body': f'CONTRA-AUDITORIA: PASS {SHA}'}]), duro=False)
        # auditoria sem o rótulo não libera
        self.falha(rodar([arq(c)], comentarios=[auditoria()]), duro=False)

    def test_T26_auditoria_de_outro_sha_ou_reprovada_falha(self):
        l, e = autonomo()
        c = ROTINA[1]
        self.falha(rodar([arq(c)], labels=l, eventos=e, comentarios=[auditoria(OUTRO)]), duro=False)
        for corpo in (f'CONTRA-AUDITORIA: PASS {SHA[:12]}', f'CONTRA-AUDITORIA: PASS {SHA}0', f'CONTRA-AUDITORIA: PASS {SHA.upper()}',
                      f'nota: CONTRA-AUDITORIA: PASS {SHA}', f'CONTRA-AUDITORIA: PASSOU {SHA}'):
            self.falha(rodar([arq(c)], labels=l, eventos=e, comentarios=[{'user': {'login': OWNER}, 'body': corpo}]), duro=False)
        # FAIL de dono para o mesmo SHA derruba o PASS, em qualquer ordem
        for cs in ([auditoria(), auditoria(veredito='FAIL')], [auditoria(veredito='FAIL'), auditoria()]):
            self.falha(rodar([arq(c)], labels=l, eventos=e, comentarios=cs), duro=False)
        # FAIL de outro SHA (push anterior) não derruba o PASS do head atual
        self.ok(rodar([arq(c)], labels=l, eventos=e, comentarios=[auditoria(OUTRO, veredito='FAIL'), auditoria()]))

    def test_T27_caminho_reservado_com_rotulo_autonomo_falha(self):
        l, e = autonomo()
        for c in ('data/products.json', 'worker/sales-public-worker.mjs', 'data/p18-commercial-allowlist.json',
                  'termos/index.html', 'privacidade/index.html', 'reembolso/index.html', 'sales-public/termos.html',
                  'contracts/zevanory-one-saas.v1.json', 'ops/token-cutover.json', 'worker/sales-control.mjs',
                  'scripts/sales_switch_workflow.py', '.github/workflows/zevanory-open-sales.yml',
                  '.github/workflows/mercadopago-production-token-rotate.yml', '.github/workflows/owner-oauth-key-bootstrap.yml',
                  '.github/workflows/gemini-key-to-worker.yml', 'wrangler.sales.toml', '.github/workflows/zero-cost-guard.yml',
                  'scripts/ci/required_check_guard.py', '.github/workflows/required-check-guard.yml',
                  '.github/workflows/merge-impact-evaluator.yml', '.github/workflows/t1-publisher-guard.yml',
                  'tests/ci/test_required_check_guard.py', 'docs/governanca/merge-autonomo.md', 'data/p23/fiscal-process.json'):
            r = rodar([arq(c)], labels=l, eventos=e, comentarios=[auditoria()])
            self.falha(r, duro=False); self.assertIn(c, r['caminhos_reservados_alterados'])
            self.assertFalse(r['aprovacao_autonoma']['valida'], c)
        # misturar rotina com um único reservado também falha
        self.falha(rodar([arq(ROTINA[0]), arq('data/products.json')], labels=l, eventos=e, comentarios=[auditoria()]), duro=False)
        # renomear um reservado para fora conta o nome antigo
        self.falha(rodar([arq('data/produtos.json', 'renamed', 'data/products.json')], labels=l, eventos=e,
                         comentarios=[auditoria()]), duro=False)

    def test_T28_caminho_reservado_exige_rotulo_do_dono(self):
        for c in ('data/products.json', 'termos/index.html', 'ops/token-cutover.json', 'scripts/ci/required_check_guard.py'):
            self.falha(rodar([arq(c)]), duro=False)  # reservado é brando mesmo fora de PROTECTED
            l, e = rotulo(); self.ok(rodar([arq(c)], labels=l, eventos=e))
            lo, eo = rotulo(OUTRO); self.falha(rodar([arq(c)], labels=lo, eventos=eo), duro=False)

    def test_T29_rotulo_autonomo_de_outro_sha_ator_ou_removido_falha(self):
        c = ROTINA[0]
        for l, e in (autonomo(OUTRO), autonomo(ator='Copilot')):
            self.falha(rodar([arq(c)], labels=l, eventos=e, comentarios=[auditoria()]), duro=False)
        l, e = autonomo(remover=True)
        self.falha(rodar([arq(c)], labels=['autonomo-auditado:' + SHA[:12]], eventos=e, comentarios=[auditoria()]), duro=False)
        # rótulo autônomo nunca libera violação dura
        l, e = autonomo()
        self.falha(rodar([arq('.github/workflows/sombra.yml', 'added')], {'sombra.yml': novo_wf(G.GUARD_NAME)}, l, e,
                         comentarios=[auditoria()]), 'COLISAO_DE_NOME')

    def test_T30_lista_de_reservados_e_reservada_e_fail_closed(self):
        l, e = autonomo()
        r = rodar([arq('ops/owner-reserved-paths.json')], labels=l, eventos=e, comentarios=[auditoria()])
        self.falha(r, duro=False); self.assertIn('ops/owner-reserved-paths.json', r['caminhos_reservados_alterados'])
        lo, eo = rotulo(); self.ok(rodar([arq('ops/owner-reserved-paths.json')], labels=lo, eventos=eo))
        self.falha(rodar([arq('index.html')], reservados=[]), 'LISTA_DE_RESERVADOS_AUSENTE')
        d = json.loads(RESERVADOS_ARQ.read_text())
        with tempfile.TemporaryDirectory() as t:
            ruim = pathlib.Path(t) / 'r.json'
            sem_si = json.loads(json.dumps(d))
            sem_si['classes']['guardas_de_governanca']['globs'].remove('ops/owner-reserved-paths.json')
            for conteudo in (sem_si, dict(d, schema='x'), dict(d, classes={}), dict(d, classes={'a': {'globs': []}})):
                ruim.write_text(json.dumps(conteudo))
                with self.assertRaises(ValueError):
                    G.carregar_reservados(ruim)

    def test_T31_globs_e_cli_do_merge_autonomo(self):
        rx = G.glob_rx
        self.assertTrue(rx('termos/**').match('termos/a/b.html')); self.assertFalse(rx('termos/**').match('termos2/a'))
        self.assertTrue(rx('**/wrangler*.toml').match('wrangler.sales.toml'))
        self.assertTrue(rx('**/wrangler*.toml').match('sandbox/x/wrangler.toml'))
        self.assertFalse(rx('.github/workflows/*token*').match('.github/workflows/sub/token.yml'))
        self.assertFalse(rx('data/products.json').match('data/products.jsonx'))
        self.assertEqual(G.reservado('index.html', RESERVADOS), [])
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d); (d / 'h').mkdir()
            (d / 'f.json').write_text(json.dumps([[arq(ROTINA[1])]]))
            l, e = autonomo()
            (d / 'l.json').write_text(json.dumps([l])); (d / 'e.json').write_text(json.dumps([e]))
            def cli(coment, reserved=str(RESERVADOS_ARQ)):
                (d / 'c.json').write_text(json.dumps([coment]))
                return subprocess.run([sys.executable, '-I', str(GUARD), '--files', str(d / 'f.json'), '--head-workflows', str(d / 'h'),
                                       '--head-sha', SHA, '--labels', str(d / 'l.json'), '--events', str(d / 'e.json'),
                                       '--comments', str(d / 'c.json'), '--reserved', reserved],
                                      capture_output=True, text=True).returncode
            self.assertEqual(cli([auditoria()]), 0)
            self.assertEqual(cli([auditoria(OUTRO)]), 1)
            self.assertEqual(cli([auditoria()], str(d / 'inexistente.json')), 2)

    # --- contra-auditoria NC-1/NC-2: .github inteiro e deploy/segredos reservados; autônomo só na allowlist de rotina ---
    def test_T32_qualquer_workflow_com_rotulo_autonomo_falha(self):
        l, e = autonomo()
        wfs = sorted(f.name for f in WF.glob('*.y*ml'))
        self.assertGreater(len(wfs), 200)
        for nome in wfs + ['novo-qualquer.yml']:
            c = '.github/workflows/' + nome
            r = rodar([arq(c)], labels=l, eventos=e, comentarios=[auditoria()])
            self.falha(r, duro=False); self.assertIn('credenciais:.github/**', r['caminhos_reservados_alterados'][c], c)
        for c in ('.github/actions/a/action.yml', '.github/dependabot.yml'):
            self.falha(rodar([arq(c)], labels=l, eventos=e, comentarios=[auditoria()]), duro=False)

    def test_T33_script_de_deploy_ou_segredo_com_rotulo_autonomo_falha(self):
        l, e = autonomo()
        for c in ('scripts/ci/cloudflare-build.sh', 'scripts/ci/cloudflare-post-deploy-verify.sh', 'scripts/ci/secret_scan.py',
                  'scripts/ci/credential_separation_gate.py', 'scripts/ci/operator_token_gate.py',
                  'scripts/ci/production-secret-names.mjs', 'scripts/ci/production-worker-state.sh',
                  'scripts/ci/mutants_credential_separation.py', 'scripts/ci/mutants_operator_token_allow.json',
                  'tests/ci/operator-token-gate.test.mjs'):
            r = rodar([arq(c)], labels=l, eventos=e, comentarios=[auditoria()])
            self.falha(r, duro=False); self.assertTrue(r['caminhos_reservados_alterados'].get(c), c)

    def test_T34_arquivo_comercial_ou_de_reembolso_com_rotulo_autonomo_falha(self):
        l, e = autonomo()
        for c in ('worker/nc015-sales-scope.mjs', 'worker/politica-unica.mjs', 'data/politica-unica.json', 'worker/refund-flow.mjs',
                  'worker/refund-provider-claims.mjs', 'worker/asaas-pix-refund-auth.mjs', 'worker/commercial-checkout-guard.mjs',
                  'worker/payment-link-expiry.mjs', 'worker/sales-ledger.mjs', 'worker/sales-lock-content.mjs',
                  'db/migrations/003_orders_checkout.sql', 'db/migrations/004_partial_refund_snapshots.sql', 'docs/nfse/x.md', 'worker/nfse-emissor.mjs'):
            r = rodar([arq(c)], labels=l, eventos=e, comentarios=[auditoria()])
            self.falha(r, duro=False); self.assertTrue(r['caminhos_reservados_alterados'].get(c), c)
            lo, eo = rotulo(); self.ok(rodar([arq(c)], labels=lo, eventos=eo))
        # worker comum não é protegido nem reservado: segue sem rótulo
        self.ok(rodar([arq('worker/site-chat.mjs')]))

    def test_T35_autonomo_so_libera_protegido_da_allowlist_de_rotina(self):
        l, e = autonomo()
        for c in ('scripts/ci/nc015-kit-harness.mjs', 'scripts/ci/site_crawl_baseline.json', 'scripts/ci/node_suite_check.py',
                  'scripts/ci/novo_gate.py', 'scripts/ci/sub/x.py'):
            self.assertEqual(G.reservado(c, RESERVADOS), [], c); self.assertTrue(G.protegido(c), c)
            r = rodar([arq(c)], labels=l, eventos=e, comentarios=[auditoria()])
            self.falha(r, duro=False); self.assertIn(c, r['protegidos_fora_da_rotina'])
            lo, eo = rotulo(); self.ok(rodar([arq(c)], labels=lo, eventos=eo))
        # sem allowlist carregada nenhum protegido é rotina (fail-closed)
        self.falha(rodar([arq(ROTINA[0])], labels=l, eventos=e, comentarios=[auditoria()], rotina=()), duro=False)
        d = json.loads(RESERVADOS_ARQ.read_text())
        with tempfile.TemporaryDirectory() as t:
            ruim = pathlib.Path(t) / 'r.json'
            for rot in (None, {'globs': []}, {'globs': ['.github/**']}, {'globs': ['**']}, {'globs': ['scripts/ci/*.py']},
                        {'globs': ['ops/*.json']}):
                x = dict(d)
                if rot is None: x.pop('rotina_autonoma')
                else: x['rotina_autonoma'] = rot
                ruim.write_text(json.dumps(x))
                with self.assertRaises(ValueError):
                    G.carregar_rotina(ruim)

    def test_T36_comentario_de_contra_auditoria_reexecuta_o_guarda(self):
        import yaml
        t = base('contra-auditoria-reavaliar.yml'); y = yaml.load(t, Loader=yaml.BaseLoader)
        self.assertEqual(sorted(y['on']), ['issue_comment'])
        self.assertEqual(sorted(y['on']['issue_comment']['types']), ['created', 'deleted', 'edited'])
        self.assertEqual(y['permissions'], {'actions': 'write', 'checks': 'read', 'pull-requests': 'read'})
        job = y['jobs']['reavaliar']; passos = job['steps']
        self.assertNotIn(job['name'], G.REQUIRED_CHECKS)
        self.assertFalse(any('uses' in p for p in passos)); self.assertNotRegex(t, r'secrets\s*[.\[]')
        for p in passos:
            self.assertNotIn('${{', p.get('run', ''), p.get('name'))
        run = passos[-1]['run']
        self.assertIn('check_name="required-check-guard / protected-paths"', run)
        self.assertIn('/rerun', run); self.assertIn('CONTRA-AUDITORIA', run)
        self.assertEqual(G.analisar_workflow('contra-auditoria-reavaliar.yml', t), [])

    # --- NC-1006-02 (contra-auditoria GPT-6): preço em fonte única + gate reservado no check obrigatório ---
    PRECO = ('data/products.json', 'worker/product-prices.mjs', 'tests/governanca/price-gate.mjs',
             'tests/governanca/price-consistency-gate.test.mjs', 'tests/governanca/novo.test.mjs')

    def test_T37_gate_de_preco_e_reservado_e_fora_da_rotina(self):
        l, e = autonomo()
        for c in self.PRECO:
            r = rodar([arq(c)], labels=l, eventos=e, comentarios=[auditoria()])
            self.falha(r, duro=False); self.assertIn(c, r['caminhos_reservados_alterados'])
            self.assertFalse(G.rotineiro(c, ROTINA_RX), c)
            lo, eo = rotulo(); self.ok(rodar([arq(c)], labels=lo, eventos=eo))
        d = json.loads(RESERVADOS_ARQ.read_text())
        with tempfile.TemporaryDirectory() as t:
            ruim = pathlib.Path(t) / 'r.json'
            # tirar o gate da lista torna a lista inválida (um PR não se torna autônomo desreservando o gate)
            sem_gate = json.loads(json.dumps(d))
            sem_gate['classes']['guardas_de_governanca']['globs'].remove('tests/governanca/**')
            ruim.write_text(json.dumps(sem_gate))
            with self.assertRaises(ValueError):
                G.carregar_reservados(ruim)
            # e a rotina não pode passar a cobrir o gate
            for rot in (['tests/**'], ['tests/governanca/*.mjs'], ['**/*.test.mjs']):
                ruim.write_text(json.dumps(dict(d, rotina_autonoma={'globs': rot})))
                with self.assertRaises(ValueError):
                    G.carregar_rotina(ruim)

    def test_T38_preco_em_arquivo_comum_com_rotulo_autonomo_e_barrado_pelo_gate_obrigatorio(self):
        import shutil
        c = 'worker/lead-magnet.mjs'
        l, e = autonomo()
        # o guarda não segura (arquivo comum, nem protegido nem reservado) ...
        r = rodar([arq(c)], labels=l, eventos=e, comentarios=[auditoria()])
        self.ok(r); self.assertEqual(r['caminhos_protegidos_alterados'], []); self.assertEqual(G.reservado(c, RESERVADOS), [])
        # ... quem segura é o gate de preço, que roda nos DOIS emissores do check obrigatório (sem if/continue-on-error)
        for nome, (jid, cmd) in G.REQUIRED_STEP.items():
            self.assertEqual(G.REQUIRED_CHECKS['product-pages / static-audit'].get(nome), jid, nome)
            self.assertEqual(G.analisar_workflow(nome, base(nome)), [], nome)
            self.assertIn(cmd, base(nome))
        # ... e reprova (rc 1 = CI vermelho) a troca de um preço de kit em cópia do lead-magnet.mjs
        node = shutil.which('node')
        self.assertTrue(node, 'node ausente: o gate de preço não pode ser verificado (fail-closed)')
        src = (REPO / c).read_text()
        de = 'price: priceBySlug("ia-na-pratica")'
        self.assertIn(de, src)
        for conteudo, rc in ((src, 0), (src.replace(de, 'price: 99', 1), 1),
                             (src.replace('por R$ ${priceBySlug("negocio-completo")}', 'por R$ 199', 1), 1)):
            with tempfile.TemporaryDirectory() as t:
                t = pathlib.Path(t); (t / 'data').mkdir(); (t / 'worker').mkdir()
                (t / 'data/products.json').write_text((REPO / 'data/products.json').read_text())
                (t / c).write_text(conteudo)
                p = subprocess.run([node, str(REPO / 'tests/governanca/price-gate.mjs'), '--root', str(t)],
                                   capture_output=True, text=True, timeout=60)
                self.assertEqual(p.returncode, rc, p.stdout[-800:] + p.stderr[-400:])

    def test_T39_emissor_obrigatorio_sem_gate_de_preco_falha(self):
        lo, eo = rotulo()
        for nome, (jid, cmd) in G.REQUIRED_STEP.items():
            for ruim in (base(nome).replace(cmd, 'node --version'), base(nome).replace(cmd, cmd.replace('price-consistency-gate', 'outro'))):
                r = rodar([arq('.github/workflows/' + nome)], {nome: ruim}, lo, eo)
                self.falha(r, 'GATE_DE_PRECO_AUSENTE')


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
