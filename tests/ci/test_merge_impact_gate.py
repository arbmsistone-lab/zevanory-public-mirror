#!/usr/bin/env python3
"""Suíte integral do patch 05g (substitui 05d/05e/05f). T19–T27: contestações A02–A05/T4; T28–T30: B01–B05; T31–T33: C01/C02/C05 do Sol (05h).
Uso: python3 -I test_05f.py <REPO_COM_05E_APLICADO> <lista_833.txt> <gabarito_833_real.json>
- T01–T07: os 7 testes originais do 05d (sem alteração de critério).
- T08: gabarito CONGELADO — o conjunto exato (não só a contagem) bate com os runs reais disparados pelo merge do #833.
- T09: efeito fora dos YAML (GitHub Pages) sempre informado.
- T10–T18: readback fail-closed (contestação F2 do Sol), incluindo execução do passo real do workflow sob `bash -e`,
  o shell padrão do Actions, com curl falso."""
import json, os, pathlib, re, stat, subprocess, sys, tempfile, textwrap, unittest, yaml
REPO = pathlib.Path(sys.argv.pop(1)).resolve(); L833 = sys.argv.pop(1); GAB = json.load(open(sys.argv.pop(1)))
WF = str(REPO / '.github/workflows'); MI = REPO / 'scripts/ci/merge_impact.py'; LC = REPO / 'scripts/ci/live_lock_check.py'; PF = REPO / 'scripts/ci/pr_files_to_lists.py'
EVAL_YML = REPO / '.github/workflows/merge-impact-evaluator.yml'
ALT833 = [l for l in pathlib.Path(L833).read_text().split() if l]
SHA = '9e426ffc996a3b01422d21fe9085b103e46d31f6'
# Replay do #833 FIXADO no conjunto de workflows da época (o GitHub avalia os gatilhos de push com os YAML do commit
# empurrado: o merge be47edb3). O gabarito é congelado; o conjunto de workflows também precisa ser, senão qualquer
# workflow novo com push em gh-pages (ex.: guarda R4 no-forged-production-input) muda a contagem sem o avaliador mudar.
# Fail-closed: commit ausente (checkout raso) ou árvore divergente derruba a suíte; nunca cai para os YAML atuais.
SHA833 = 'be47edb3b6636291cb7f89ea70ca8412f4a1572f'
TREE833 = '54318ba86818bd2ca2f2023e7336d03d9ebb92cb'  # git rev-parse be47edb3:.github/workflows (176 YAML)
_WF833_TMP = tempfile.TemporaryDirectory()

def _extrair_wf833():
    g = ['git', '-C', str(REPO)]
    arvore = subprocess.run(g + ['rev-parse', SHA833 + ':.github/workflows'], capture_output=True, text=True)
    if arvore.returncode != 0 or arvore.stdout.strip() != TREE833:
        raise RuntimeError('WF833_INDISPONIVEL_OU_DIVERGENTE: o checkout precisa do commit ' + SHA833 +
                           ' (fetch-depth: 0); obtido=' + (arvore.stdout.strip() or arvore.stderr.strip()[:200]))
    tar = subprocess.run(g + ['archive', '--format=tar', SHA833, '.github/workflows'], capture_output=True)
    if tar.returncode != 0:
        raise RuntimeError('WF833_ARCHIVE_FALHOU')
    subprocess.run(['tar', '-x', '-C', _WF833_TMP.name], input=tar.stdout, check=True)
    destino = pathlib.Path(_WF833_TMP.name) / '.github/workflows'
    if len(list(destino.glob('*.y*ml'))) != 176:
        raise RuntimeError('WF833_CONTAGEM_DIVERGENTE')
    return str(destino)

WF833 = _extrair_wf833()

def rodar(changed, head=None, removed=None, base=None):
    with tempfile.TemporaryDirectory() as d:
        d = pathlib.Path(d); (d / 'c.txt').write_text('\n'.join(changed)); args = ['--base-workflows', base or WF, '--changed', str(d / 'c.txt')]
        if head is not None:
            (d / 'h').mkdir()
            for n, t in head.items(): (d / 'h' / n).write_text(textwrap.dedent(t))
            args += ['--head-workflows', str(d / 'h')]
        if removed is not None: (d / 'r.txt').write_text('\n'.join(removed)); args += ['--removed', str(d / 'r.txt')]
        p = subprocess.run([sys.executable, '-I', str(MI), *args], capture_output=True, text=True)
        return p.returncode, json.loads(p.stdout)

def CMP(sha=None, status='ahead'):
    return json.dumps({'status': status, 'base_commit': {'sha': sha or SHA}})

def lock(rc, corpo, compare=None, extra=None):
    """compare=None usa um compare válido (ancestral); compare='' omite o arquivo de compare."""
    with tempfile.TemporaryDirectory() as d:
        d = pathlib.Path(d); f = d / 'r.json'
        if corpo is not None: f.write_text(corpo)
        args = [sys.executable, '-I', str(LC), '--curl-rc', str(rc), str(f)]
        if extra: args += extra
        else:
            c = d / 'c.json'
            if compare != '': c.write_text(CMP() if compare is None else compare)
            args += ['--compare-json', str(c)]
        p = subprocess.run(args, capture_output=True, text=True)
        return p.returncode, p.stdout.strip()

def passo_readback():
    y = yaml.safe_load(EVAL_YML.read_text())
    passos = [s for s in y['jobs']['impacto']['steps'] if 'FAIL-CLOSED' in s.get('name', '')]
    assert len(passos) == 1; return passos[0]

def executar_passo(curl_script, gh_script=None):
    """Executa o bloco run: do passo real como o Actions faz por padrão (bash -e), com curl falso no PATH."""
    s = passo_readback()
    with tempfile.TemporaryDirectory() as d:
        d = pathlib.Path(d); (d / 'bin').mkdir(); c = d / 'bin' / 'curl'
        c.write_text('#!/bin/bash\n' + curl_script); c.chmod(c.stat().st_mode | stat.S_IEXEC)
        g = d / 'bin' / 'gh'
        g.write_text('#!/bin/bash\n' + (gh_script if gh_script is not None else f"echo '{CMP()}'\n")); g.chmod(g.stat().st_mode | stat.S_IEXEC)
        env = dict(PATH=f"{d/'bin'}:/usr/bin:/bin", GITHUB_STEP_SUMMARY=str(d / 'sum'), REPO='o/r', GH_TOKEN='x')
        # o script grava em /tmp/release.json como no runner; remover sobra de execução anterior
        pathlib.Path('/tmp/release.json').unlink(missing_ok=True)
        p = subprocess.run(['bash', '-e', '-c', s['run']], cwd=REPO, env=env, capture_output=True, text=True)
        return p.returncode, p.stdout + p.stderr

class T(unittest.TestCase):
    # --- T01–T07: originais do 05d
    def test_T01_retroativo_833_18_disparos_classe_B(self):
        rc, r = rodar(ALT833, base=WF833); d = {x['workflow'] for x in r['disparos_diretos']}
        self.assertEqual(len(d), 18); self.assertIn('central-production-deploy.yml', d); self.assertIn('financial-e2e-closure.yml', d)
        self.assertEqual(rc, 3); self.assertEqual(r['classe'], 'B')
    def test_T02_retroativo_833_cadeia_indireta(self):
        _, r = rodar(ALT833, base=WF833); i = {x['workflow'] for x in r['disparos_indiretos_workflow_run']}
        self.assertIn('engine-dispatcher.yml', i); self.assertIn('auto-rerun-transient.yml', i)
    def test_T03_caminho_nao_publicado_classe_A(self):
        # 05g: só caminhos ocultos (".") não afetam o Pages; ".zevanory/" não dispara workflow
        rc, r = rodar(['.zevanory/nota-teste.md']); self.assertEqual(rc, 0, r['com_risco']); self.assertEqual(r['classe'], 'A')
    def test_T04_workflow_novo_de_deploy_detectado(self):
        novo = {'novo-deploy.yml': '''
            on: {push: {branches: [gh-pages], paths: ['docs/**']}}
            jobs: {d: {runs-on: ubuntu-latest, steps: [{run: "npx wrangler deploy"}]}}
        '''}
        rc, r = rodar(['docs/nota.md', '.github/workflows/novo-deploy.yml'], head=novo)
        self.assertEqual(rc, 3); self.assertIn('novo-deploy.yml', r['com_risco'])
    def test_T05_alteracao_de_workflow_dispara_o_proprio(self):
        _, r = rodar(['.github/workflows/zero-cost-guard.yml'])
        self.assertIn('zero-cost-guard.yml', {x['workflow'] for x in r['disparos_diretos']})
    def test_T06_workflow_removido_sai(self):
        _, r = rodar(['.github/workflows/central-production-deploy.yml'], head={}, removed=['.github/workflows/central-production-deploy.yml'])
        self.assertNotIn('central-production-deploy.yml', {x['workflow'] for x in r['disparos_diretos']})
    def test_T07_permissao_escrita_e_oidc(self):
        novo = {'w.yml': '''
            on: {push: {branches: [gh-pages]}}
            permissions: {id-token: write, contents: write}
            jobs: {j: {runs-on: ubuntu-latest, steps: [{run: "echo ok"}]}}
        '''}
        _, r = rodar(['x.txt', '.github/workflows/w.yml'], head=novo)
        rs = [x for x in r['disparos_diretos'] if x['workflow'] == 'w.yml'][0]['riscos']
        self.assertIn('oidc_id_token', rs); self.assertIn('permissao_escrita', rs)
    def test_T07b_cadeia_indireta_de_segundo_nivel(self):
        head = {'a.yml': '''
            name: A
            on: {push: {branches: [gh-pages]}}
            jobs: {j: {runs-on: ubuntu-latest, steps: [{run: "echo"}]}}
        ''', 'b.yml': '''
            name: B
            on: {workflow_run: {workflows: [A], types: [completed]}}
            jobs: {j: {runs-on: ubuntu-latest, steps: [{run: "echo"}]}}
        ''', 'c.yml': '''
            name: C
            on: {workflow_run: {workflows: [B], types: [completed]}}
            jobs: {j: {runs-on: ubuntu-latest, steps: [{run: "npx wrangler deploy"}]}}
        '''}
        rc, r = rodar(['x.txt', '.github/workflows/a.yml', '.github/workflows/b.yml', '.github/workflows/c.yml'], head=head)
        self.assertIn(('c.yml', 'b.yml'), {(x['workflow'], x['acionado_por']) for x in r['disparos_indiretos_workflow_run']})
        self.assertIn('c.yml', r['com_risco']); self.assertEqual(rc, 3)
    # --- T08–T09: melhoria do Sol (gabarito congelado) e efeito fora dos YAML
    def test_T08_conjunto_exato_igual_aos_runs_reais_do_merge_833(self):
        _, r = rodar(ALT833, base=WF833)
        self.assertEqual(sorted(x['workflow'] for x in r['disparos_diretos']), GAB['push'])
        previsto = {x['workflow'] for x in r['disparos_diretos']} | {x['workflow'] for x in r['disparos_indiretos_workflow_run']}
        real = set(GAB['push']) | set(GAB['workflow_run'])
        self.assertEqual(previsto, real, f'faltou {real - previsto}; sobrou {previsto - real}')
    def test_T09_pages_sempre_informado(self):
        _, r = rodar(['docs/nota.md'])
        self.assertTrue(any('pages-build-deployment' in e for e in r['efeitos_fora_dos_yaml']))
        self.assertEqual(GAB['dynamic'], ['pages-build-deployment'])
    # --- T10–T16: verificador de trava (unidade)
    def test_T10_leitura_http_falha_bloqueia(self):
        self.assertEqual(lock(6, '')[0], 4)
    def test_T10b_falha_http_com_corpo_valido_residual_bloqueia(self):
        # corpo válido de leitura anterior não pode compensar falha de leitura atual
        self.assertEqual(lock(22, json.dumps({'deployment': {'commit_sha': SHA}, 'sales_mode': 'globally-blocked'}))[0], 4)
    def test_T11_sales_mode_enabled_bloqueia(self):
        self.assertEqual(lock(0, json.dumps({'deployment': {'commit_sha': SHA}, 'sales_mode': 'enabled'}))[0], 4)
    def test_T12_sales_mode_ausente_ou_nulo_bloqueia(self):
        self.assertEqual(lock(0, json.dumps({'deployment': {'commit_sha': SHA}}))[0], 4)
        self.assertEqual(lock(0, json.dumps({'deployment': {'commit_sha': SHA}, 'sales_mode': None}))[0], 4)
    def test_T13_variacao_de_grafia_bloqueia(self):
        for m in ['globally-blocked ', 'GLOBALLY-BLOCKED', 'blocked', ['globally-blocked']]:
            self.assertEqual(lock(0, json.dumps({'deployment': {'commit_sha': SHA}, 'sales_mode': m}))[0], 4, m)
    def test_T14_json_invalido_ou_nao_objeto_bloqueia(self):
        for c in ['<html>503</html>', '[]', 'null', '']: self.assertEqual(lock(0, c)[0], 4, c)
        self.assertEqual(lock(0, None)[0], 4)
    def test_T15_commit_ausente_ou_malformado_bloqueia(self):
        for dep in [None, {}, {'commit_sha': 'abc'}, {'commit_sha': SHA.upper()}]:
            self.assertEqual(lock(0, json.dumps({'deployment': dep, 'sales_mode': 'globally-blocked'}))[0], 4, dep)
    def test_T16_caso_valido_aprova(self):
        rc, out = lock(0, json.dumps({'deployment': {'commit_sha': SHA}, 'sales_mode': 'globally-blocked'}))
        self.assertEqual(rc, 0); self.assertIn(SHA, out)
    # --- T17–T18: passo REAL do workflow sob o shell padrão do Actions
    def test_T17_passo_real_falha_com_dns_e_com_vendas_abertas(self):
        self.assertNotEqual(executar_passo('exit 6\n')[0], 0)
        aberto = json.dumps({'deployment': {'commit_sha': SHA}, 'sales_mode': 'enabled'})
        self.assertNotEqual(executar_passo(f'''for a; do [ "$p" = "-o" ] && o="$a"; p="$a"; done; echo '{aberto}' > "$o"\n''')[0], 0)
    def test_T18_passo_real_aprova_trava_fechada_e_sem_caminho_de_aviso(self):
        ok = json.dumps({'deployment': {'commit_sha': SHA}, 'sales_mode': 'globally-blocked'})
        rc, out = executar_passo(f'''for a; do [ "$p" = "-o" ] && o="$a"; p="$a"; done; echo '{ok}' > "$o"\n''')
        self.assertEqual(rc, 0, out)
        s = passo_readback(); self.assertNotIn('continue-on-error', s); self.assertNotIn('::warning', s['run'])
        self.assertIsNone(re.search(r'\|\|\s*(echo|true|:)', s['run']))
    # --- T19–T27: contestações do Sol na Ordem 005 (05f)
    def test_T19_A02_chave_duplicada_bloqueia(self):
        corpo = '{"deployment": {"commit_sha": "%s"}, "sales_mode": "enabled", "sales_mode": "globally-blocked"}' % SHA
        rc, out = lock(0, corpo); self.assertEqual(rc, 4); self.assertIn('JSON_AMBIGUO', out)
        corpo2 = '{"deployment": {"commit_sha": "%s", "commit_sha": "%s"}, "sales_mode": "globally-blocked"}' % (SHA, SHA)
        self.assertEqual(lock(0, corpo2)[0], 4)
    def test_T20_A03_commit_nao_ancestral_bloqueia(self):
        ok = json.dumps({'deployment': {'commit_sha': SHA}, 'sales_mode': 'globally-blocked'})
        for st in ['diverged', 'behind', None]:
            self.assertEqual(lock(0, ok, compare=CMP(status=st))[0], 4, st)
        self.assertEqual(lock(0, ok, compare=CMP(sha='0' * 40))[0], 4)
        self.assertEqual(lock(0, ok, compare='{"status":"ahead"}')[0], 4)
        self.assertEqual(lock(0, ok, compare='<html>404</html>')[0], 4)
    def test_T21_A03_sem_compare_bloqueia_e_print_sha(self):
        ok = json.dumps({'deployment': {'commit_sha': SHA}, 'sales_mode': 'globally-blocked'})
        self.assertEqual(lock(0, ok, extra=['--compare-json', '/nao/existe'])[0], 4)
        p = subprocess.run([sys.executable, '-I', str(LC), '--curl-rc', '0', '/dev/stdin'], input=ok, capture_output=True, text=True)
        self.assertEqual(p.returncode, 4)  # sem --compare-json nem --print-sha não aprova
        p = subprocess.run([sys.executable, '-I', str(LC), '--curl-rc', '0', '/dev/stdin', '--print-sha'], input=ok, capture_output=True, text=True)
        self.assertEqual((p.returncode, p.stdout.strip()), (0, SHA))
    def test_T22_A03_passo_real_bloqueia_se_compare_falha_ou_diverge(self):
        ok = json.dumps({'deployment': {'commit_sha': SHA}, 'sales_mode': 'globally-blocked'})
        cs = f'''for a; do [ "$p" = "-o" ] && o="$a"; p="$a"; done; echo '{ok}' > "$o"\n'''
        self.assertNotEqual(executar_passo(cs, gh_script='exit 1\n')[0], 0)
        self.assertNotEqual(executar_passo(cs, gh_script=f"echo '{CMP(status='diverged')}'\n")[0], 0)
    def test_T23_A04_renomeado_sai_da_definicao_efetiva(self):
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            (d / 'f.json').write_text(json.dumps([[{'filename': '.github/workflows/novo-nome.yml', 'status': 'renamed', 'previous_filename': '.github/workflows/zero-cost-guard.yml'}]]))
            subprocess.run([sys.executable, '-I', str(PF), str(d / 'f.json'), str(d)], check=True, capture_output=True)
            changed = (d / 'changed.txt').read_text().split(); removed = (d / 'removed.txt').read_text().split()
            wf = (d / 'workflows_head.txt').read_text().split()
        self.assertIn('.github/workflows/zero-cost-guard.yml', removed); self.assertEqual(wf, ['.github/workflows/novo-nome.yml'])
        novo = open(pathlib.Path(WF) / 'zero-cost-guard.yml').read()
        _, r = rodar(changed, head={'novo-nome.yml': novo}, removed=removed)
        nomes = [x['workflow'] for x in r['disparos_diretos']]
        self.assertNotIn('zero-cost-guard.yml', nomes); self.assertEqual(nomes.count('novo-nome.yml'), 1)
    def test_T24_A04_nome_inseguro_aborta(self):
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            (d / 'f.json').write_text(json.dumps([[{'filename': '.github/workflows/a b;$(x).yml', 'status': 'added'}]]))
            p = subprocess.run([sys.executable, '-I', str(PF), str(d / 'f.json'), str(d)], capture_output=True)
        self.assertNotEqual(p.returncode, 0)
    def test_T25_A05_negacao_e_estrela_sem_barra(self):
        head = {'neg.yml': '''
            on: {push: {branches: [gh-pages], paths: ['docs/**', '!docs/privado/**']}}
            jobs: {j: {runs-on: ubuntu-latest, steps: [{run: "npx wrangler deploy"}]}}
        ''', 'raiz.yml': '''
            on: {push: {branches: [gh-pages], paths: ['*.md']}}
            jobs: {j: {runs-on: ubuntu-latest, steps: [{run: "echo"}]}}
        '''}
        _, r = rodar(['docs/privado/x.md'], head=head); d = {x['workflow'] for x in r['disparos_diretos']}
        self.assertNotIn('neg.yml', d); self.assertNotIn('raiz.yml', d)
        _, r = rodar(['docs/publico/x.md', 'LEIAME.md'], head=head); d = {x['workflow'] for x in r['disparos_diretos']}
        self.assertIn('neg.yml', d); self.assertIn('raiz.yml', d)
    def test_T26_T4_conteudo_publicado_eleva_classe(self):
        rc, r = rodar(['docs/nota.md'])
        self.assertEqual(r['conteudo_publicado_alterado'], ['docs/nota.md']); self.assertIn('pages-build-deployment', r['com_risco'])
        self.assertEqual((rc, r['classe']), (3, 'B'))
    def test_T27_T4_arquivos_ocultos_nao_sao_publicados(self):
        _, r = rodar(['.github/CODEOWNERS', '.zevanory/x.md'])
        self.assertEqual(r['conteudo_publicado_alterado'], [])
    def test_T28_B01_B03_classe_de_caracteres_e_quantificadores(self):
        head = {'q.yml': '''
            on: {push: {branches: [gh-pages], paths: ['src/v[0-9].js', 'docs?/**', 'a+.txt', 'lit\\?.md']}}
            jobs: {j: {runs-on: ubuntu-latest, steps: [{run: "npx wrangler deploy"}]}}
        '''}
        for alterado in ['src/v7.js', 'doc/x.md', 'docs/x.md', 'aaa.txt', 'lit?.md']:
            _, r = rodar([alterado], head=head)
            self.assertIn('q.yml', {x['workflow'] for x in r['disparos_diretos']}, alterado)
        for alterado in ['src/vx.js', 'docss/x.md', '.txt', 'lit.md']:
            _, r = rodar([alterado], head=head)
            self.assertNotIn('q.yml', {x['workflow'] for x in r['disparos_diretos']}, alterado)
    def test_T29_B04_B05_configuracao_do_pages_eleva(self):
        for alterado in ['.nojekyll', '_config.yml', 'CNAME', '_layouts/padrao.html', '.well-known/security.txt']:
            rc, r = rodar([alterado])
            self.assertIn(alterado, r['conteudo_publicado_alterado'], alterado); self.assertEqual(r['classe'], 'B', alterado)
    def test_T30_branch_com_classe_de_caracteres(self):
        head = {'b.yml': '''
            on: {push: {branches: ['gh-page[s]']}}
            jobs: {j: {runs-on: ubuntu-latest, steps: [{run: "echo"}]}}
        ''', 'n.yml': '''
            on: {push: {branches: ['gh-page[x]']}}
            jobs: {j: {runs-on: ubuntu-latest, steps: [{run: "echo"}]}}
        '''}
        _, r = rodar(['.zevanory/x.md'], head=head); d = {x['workflow'] for x in r['disparos_diretos']}
        self.assertIn('b.yml', d); self.assertNotIn('n.yml', d)
    def test_T31_C01_segredo_por_indice(self):
        head = {'c01.yml': '''
            on: {push: {branches: [gh-pages]}}
            permissions: {contents: read}
            jobs: {j: {runs-on: ubuntu-latest, permissions: {contents: read}, steps: [{run: "curl -X POST https://exemplo.invalido/x -H \\"k: ${{ secrets['API_KEY'] }}\\""}]}}
        '''}
        rc, r = rodar(['.zevanory/x.md', '.github/workflows/c01.yml'], head=head)
        rs = [x for x in r['disparos_diretos'] if x['workflow'] == 'c01.yml'][0]['riscos']
        self.assertIn('segredos', rs); self.assertEqual(rc, 3)
    def test_T32_C02_secrets_inherit_em_yaml_compacto(self):
        head = {'c02.yml': '''
            on: {push: {branches: [gh-pages]}}
            permissions: {contents: read}
            jobs: {chama: {uses: ./.github/workflows/c02-alvo.yml, secrets: inherit, permissions: {contents: read}}}
        ''', 'c02-alvo.yml': '''
            on: {workflow_call: {}}
            permissions: {contents: read}
            jobs: {j: {runs-on: ubuntu-latest, permissions: {contents: read}, steps: [{run: "echo ok"}]}}
        '''}
        rc, r = rodar(['.zevanory/x.md', '.github/workflows/c02.yml', '.github/workflows/c02-alvo.yml'], head=head)
        rs = [x for x in r['disparos_diretos'] if x['workflow'] == 'c02.yml'][0]['riscos']
        self.assertIn('segredos', rs); self.assertIn('workflow_reutilizavel', rs); self.assertEqual(rc, 3)
    def test_T33_C05_efeito_financeiro_do_reutilizavel_sobe_ao_chamador(self):
        head = {'c05.yml': '''
            on: {push: {branches: [gh-pages]}}
            permissions: {contents: read}
            jobs: {chama: {uses: ./.github/workflows/c05-fin.yml, permissions: {contents: read}}}
        ''', 'c05-fin.yml': '''
            on: {workflow_call: {}}
            permissions: {contents: read}
            jobs: {j: {runs-on: ubuntu-latest, permissions: {contents: read}, steps: [{run: "curl -X POST https://api.mercadopago.com/v1/payments"}]}}
        ''', 'c05-ext.yml': '''
            on: {push: {branches: [gh-pages]}}
            permissions: {contents: read}
            jobs: {chama: {uses: terceiro/repo/.github/workflows/x.yml@v1, permissions: {contents: read}}}
        ''', 'c05-ciclo.yml': '''
            on: {push: {branches: [gh-pages]}, workflow_call: {}}
            permissions: {contents: read}
            jobs: {chama: {uses: ./.github/workflows/c05-ciclo.yml, permissions: {contents: read}}}
        '''}
        rc, r = rodar(['.zevanory/x.md'] + [f'.github/workflows/{n}' for n in head], head=head)
        rs = {x['workflow']: x['riscos'] for x in r['disparos_diretos']}
        self.assertIn('financeiro', rs['c05.yml']); self.assertIn('workflow_reutilizavel_externo', rs['c05-ext.yml'])
        self.assertIn('workflow_reutilizavel', rs['c05-ciclo.yml']); self.assertEqual(rc, 3)
if __name__ == '__main__': unittest.main(verbosity=2)
