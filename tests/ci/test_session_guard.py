"""Testes do scripts/ci/session_guard.py (22/11/2026, r3). Rodar: python3 -I tests/ci/test_session_guard.py"""
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

RAIZ = pathlib.Path(__file__).resolve().parents[2]
SCRIPT = RAIZ / 'scripts' / 'ci' / 'session_guard.py'
A = 'session_013qEayJV2BctKApuM3NnNgu'
B = 'session_01BEoZWaBFoF9w15T3McDGya'
X = 'session_0XXforeignXXsession00'
H1, H2, H3 = '1' * 40, '2' * 40, '3' * 40
OUTRO = 'a' * 40
HEAD_RAIZ = subprocess.run(['git', '-C', str(RAIZ), 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip()


def pr_json(head, n, corpo=''):
    return {'head': {'sha': head}, 'base': {'sha': 'b' * 40}, 'commits': n, 'body': corpo}


def rodar(lista, commits, corpo='', evento=None, antes=None, depois=None, executor_bruto=None, commits_bruto=None):
    """commits: lista de (sha, mensagem). Por padrão PR antes/depois coerentes com o último commit."""
    head = commits[-1][0] if commits else H1
    evento = evento or head
    antes = antes or pr_json(head, len(commits), corpo)
    depois = depois or pr_json(head, len(commits), corpo)
    with tempfile.TemporaryDirectory() as d:
        p = {n: os.path.join(d, n) for n in ('ex.json', 'cm.json', 'a.json', 'b.json')}
        with open(p['ex.json'], 'w', encoding='utf-8') as f:
            f.write(executor_bruto if executor_bruto is not None else json.dumps({'authorized_claude_sessions': lista}))
        with open(p['cm.json'], 'w', encoding='utf-8') as f:
            f.write(commits_bruto if commits_bruto is not None else
                    json.dumps([[{'sha': s, 'commit': {'message': m}} for s, m in commits]]))
        for k, v in (('a.json', antes), ('b.json', depois)):
            with open(p[k], 'w', encoding='utf-8') as f:
                json.dump(v, f)
        args = [sys.executable, '-I', str(SCRIPT), '--executor', p['ex.json'], '--commits', p['cm.json'],
                '--pr-before', p['a.json'], '--pr-after', p['b.json'], '--event-head-sha', evento,
                '--repo', str(RAIZ), '--base-sha', HEAD_RAIZ]
        r = subprocess.run(args, capture_output=True, text=True, timeout=30)
        return r.returncode, json.loads(r.stdout)


class Decisao(unittest.TestCase):
    def test_autorizada_em_commit_passa(self):
        rc, r = rodar([A, B], [(H1, 'fix: x\n\nClaude-Session: https://claude.ai/code/' + A)])
        self.assertEqual((rc, r['verdict'], r['declared'], r['revision_checked']['head']), (0, 'PASS', [A], H1))

    def test_autorizada_so_no_corpo_passa(self):
        rc, r = rodar([A], [(H1, 'fix: x')], corpo='https://claude.ai/code/' + A)
        self.assertEqual((rc, r['verdict']), (0, 'PASS'))

    def test_ausente_reprova(self):
        rc, r = rodar([A], [(H1, 'fix: x')], corpo='sem sessao')
        self.assertEqual((rc, r['reason']), (1, 'EXECUTOR_IDENTITY_NOT_ESTABLISHED'))

    def test_estrangeira_reprova(self):
        rc, r = rodar([A], [(H1, 'fix\n' + X)])
        self.assertEqual((rc, r['reason'], r['unauthorised']), (1, 'UNAUTHORISED_EXECUTOR_SESSION', [X]))

    def test_mista_reprova(self):
        rc, r = rodar([A], [(H1, 'a\n' + A), (H2, 'b\n' + X)])
        self.assertEqual((rc, r['unauthorised']), (1, [X]))

    def test_lista_vazia_ou_mal_formada_reprova(self):
        for bruto in ('{', '[]', json.dumps({'authorized_claude_sessions': []}),
                      json.dumps({'authorized_claude_sessions': ['x']}),
                      json.dumps({'authorized_claude_sessions': [A, A]})):
            rc, r = rodar([], [(H1, 'a\n' + A)], executor_bruto=bruto)
            self.assertEqual((rc, r['reason']), (1, 'INPUT_ERROR'), bruto)

    def test_lista_so_da_base(self):
        rc, r = rodar([A], [(H1, 'a\n' + X + '\n{"authorized_claude_sessions": ["' + X + '"]}')])
        self.assertEqual((rc, r['verdict'], r['list_source']), (1, 'FAIL', 'base'))


class MesmaRevisao(unittest.TestCase):
    """O pedido do titular: commits e corpo avaliados pertencem à revisão do evento."""

    def test_head_muda_durante_coleta_mesma_contagem_reprova(self):
        # force-push com a mesma quantidade de commits entre as duas leituras do PR
        rc, r = rodar([A], [(H1, 'a\n' + A)], antes=pr_json(H1, 1), depois=pr_json(OUTRO, 1))
        self.assertEqual((rc, r['reason']), (1, 'HEAD_CHANGED_DURING_COLLECTION'))

    def test_head_api_diferente_do_evento_reprova(self):
        rc, r = rodar([A], [(H1, 'a\n' + A)], evento=OUTRO)
        self.assertEqual((rc, r['reason']), (1, 'HEAD_NOT_EVENT_HEAD'))

    def test_lista_de_commits_de_outra_revisao_reprova(self):
        # PR antes/depois e evento em H1, mas a lista veio de uma revisão cujo topo é H2 (mesma contagem)
        rc, r = rodar([A], [(H2, 'a\n' + A)], evento=H1, antes=pr_json(H1, 1), depois=pr_json(H1, 1))
        self.assertEqual((rc, r['reason']), (1, 'COMMIT_LIST_NOT_AT_HEAD'))

    def test_corpo_muda_durante_coleta_reprova(self):
        rc, r = rodar([A], [(H1, 'a')], antes=pr_json(H1, 1, A), depois=pr_json(H1, 1, A + ' editado'))
        self.assertEqual((rc, r['reason']), (1, 'BODY_CHANGED_DURING_COLLECTION'))

    def test_contagem_divergente_reprova(self):
        rc, r = rodar([A], [(H2, 'a\n' + A)], antes=pr_json(H2, 2), depois=pr_json(H2, 2))
        self.assertEqual((rc, r['reason']), (1, 'COMMIT_COUNT_MISMATCH'))

    def test_contagem_muda_entre_leituras_reprova(self):
        rc, r = rodar([A], [(H1, 'a\n' + A)], antes=pr_json(H1, 2), depois=pr_json(H1, 1))
        self.assertEqual((rc, r['reason']), (1, 'COMMIT_COUNT_CHANGED_DURING_COLLECTION'))

    def test_mais_commits_que_a_api_lista_reprova(self):
        lista = [('%040x' % (i + 1), 'c\n' + A) for i in range(251)]
        rc, r = rodar([A], lista)
        self.assertEqual((rc, r['reason']), (1, 'TOO_MANY_COMMITS_FOR_API'))

    def test_commit_sem_sha_reprova(self):
        rc, r = rodar([A], [(H1, 'a\n' + A)], commits_bruto=json.dumps([[{'commit': {'message': 'a ' + A}}]]))
        self.assertEqual((rc, r['reason']), (1, 'INPUT_ERROR'))

    def test_commits_repetidos_reprova(self):
        rc, r = rodar([A], [(H1, 'a\n' + A), (H1, 'b\n' + A)])
        self.assertEqual((rc, r['reason']), (1, 'COMMIT_LIST_DUPLICATED'))


class WorkflowDaBase(unittest.TestCase):
    def test_workflow_roda_da_base_sem_codigo_do_pr(self):
        y = (RAIZ / '.github' / 'workflows' / 'session-guard.yml').read_text(encoding='utf-8')
        self.assertIn('pull_request_target:', y)
        self.assertNotIn('\n  pull_request:', y)
        # r3: topo atual da base (github.sha), nunca o base.sha congelado do evento nem o head do PR
        self.assertIn('ref: ${{ github.sha }}', y)
        self.assertNotIn('ref: ${{ github.event.pull_request.base.sha }}', y)
        self.assertNotIn('ref: ${{ github.event.pull_request.head', y)
        self.assertIn('loaded="$(git rev-parse HEAD)"', y)
        self.assertIn('if [ "$loaded" != "$EXPECTED_BASE_SHA" ]; then', y)
        bloco = y.split('if [ "$loaded" != "$EXPECTED_BASE_SHA" ]; then')[1].split('fi')[0]
        self.assertIn('exit 1', bloco)
        self.assertIn('echo "LOADED_BASE_SHA=$loaded" >> "$GITHUB_ENV"', y)
        self.assertIn('EXPECTED_BASE_SHA: ${{ github.sha }}', y)
        self.assertIn('--base-sha "$LOADED_BASE_SHA"', y)
        self.assertIn('EVENT_BASE_SHA: ${{ github.event.pull_request.base.sha }}', y)
        self.assertNotIn('head.ref', y)
        self.assertIn('--executor ops/executor.json', y)
        self.assertIn('persist-credentials: false', y)
        self.assertNotIn('secrets.', y)
        for ev in ('opened', 'synchronize', 'reopened', 'edited'):
            self.assertIn(ev, y)

    def test_workflow_le_pr_antes_e_depois_dos_commits(self):
        y = (RAIZ / '.github' / 'workflows' / 'session-guard.yml').read_text(encoding='utf-8')
        i_antes, i_commits, i_depois = (y.index(s) for s in ('pr-before.json', '/commits?per_page=100', '> /tmp/sg/pr-after.json'))
        self.assertLess(i_antes, i_commits)
        self.assertLess(i_commits, i_depois)
        self.assertIn('--event-head-sha "$EVENT_HEAD_SHA"', y)
        self.assertIn('EVENT_HEAD_SHA: ${{ github.event.pull_request.head.sha }}', y)

    def test_job_antigo_removido(self):
        y = (RAIZ / '.github' / 'workflows' / 't1-publisher-guard.yml').read_text(encoding='utf-8')
        self.assertNotIn('\n  session-guard:', y)
        self.assertNotIn('ops/executor.json)"', y)

    def test_caminhos_reservados(self):
        d = json.loads((RAIZ / 'ops' / 'owner-reserved-paths.json').read_text(encoding='utf-8'))
        g = d['classes']['guardas_de_governanca']['globs']
        for c in ('ops/executor.json', '.github/workflows/session-guard.yml', 'scripts/ci/session_guard.py',
                  'tests/ci/test_session_guard.py', '.github/workflows/session-guard-selftest.yml'):
            self.assertIn(c, g)



def git(repo, *args):
    env = dict(os.environ, GIT_AUTHOR_NAME='t', GIT_AUTHOR_EMAIL='t@t', GIT_COMMITTER_NAME='t', GIT_COMMITTER_EMAIL='t@t')
    return subprocess.run(['git', '-C', repo, *args], capture_output=True, text=True, check=True, env=env).stdout.strip()


class RegressaoBaseCongelada(unittest.TestCase):
    """Caso real do #1079 (22/11/2026): pull_request.base.sha do evento era anterior à introdução do guard."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.repo = os.path.join(self.tmp, 'repo')
        os.makedirs(self.repo)
        git(self.repo, 'init', '-q')
        with open(os.path.join(self.repo, 'README'), 'w') as f:
            f.write('base antiga, sem guard\n')
        git(self.repo, 'add', '-A'); git(self.repo, 'commit', '-q', '-m', 'A')
        self.base_antiga = git(self.repo, 'rev-parse', 'HEAD')
        os.makedirs(os.path.join(self.repo, 'scripts', 'ci')); os.makedirs(os.path.join(self.repo, 'ops'))
        shutil.copy(SCRIPT, os.path.join(self.repo, 'scripts', 'ci', 'session_guard.py'))
        with open(os.path.join(self.repo, 'ops', 'executor.json'), 'w') as f:
            json.dump({'authorized_claude_sessions': [A]}, f)
        git(self.repo, 'add', '-A'); git(self.repo, 'commit', '-q', '-m', 'B: guard')
        self.base_atual = git(self.repo, 'rev-parse', 'HEAD')
        for n, v in (('a.json', pr_json(H1, 1, A)), ('b.json', pr_json(H1, 1, A)),
                     ('c.json', [[{'sha': H1, 'commit': {'message': 'x ' + A}}]])):
            with open(os.path.join(self.tmp, n), 'w') as f:
                json.dump(v, f)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def rodar(self, base_sha):
        args = [sys.executable, '-I', os.path.join(self.repo, 'scripts', 'ci', 'session_guard.py'),
                '--executor', 'ops/executor.json', '--commits', os.path.join(self.tmp, 'c.json'),
                '--pr-before', os.path.join(self.tmp, 'a.json'), '--pr-after', os.path.join(self.tmp, 'b.json'),
                '--event-head-sha', H1, '--base-sha', base_sha, '--event-base-sha', self.base_antiga, '--repo', '.']
        r = subprocess.run(args, capture_output=True, text=True, timeout=30, cwd=self.repo)
        return r.returncode, json.loads(r.stdout)

    def test_base_do_evento_anterior_ao_guard_passa_com_base_atual(self):
        rc, r = self.rodar(self.base_atual)
        self.assertEqual((rc, r['verdict'], r['base_sha'], r['event_base_sha']),
                         (0, 'PASS', self.base_atual, self.base_antiga))
        self.assertEqual(r['base_sha_expected'], self.base_atual)

    def test_base_sha_informado_diferente_do_carregado_reprova(self):
        rc, r = self.rodar(self.base_antiga)  # informar o base.sha congelado com o checkout no topo atual
        self.assertEqual((rc, r['reason'], r['carregado']), (1, 'BASE_SHA_MISMATCH', self.base_atual))
        # o relatório registra o commit EFETIVAMENTE carregado, não o valor informado
        self.assertEqual((r['base_sha'], r['base_sha_expected']), (self.base_atual, self.base_antiga))

    def test_checkout_na_base_antiga_nao_tem_o_guard(self):
        # documenta a falha original: no commit antigo o script não existe (por isso o workflow não usa base.sha)
        git(self.repo, 'checkout', '-q', self.base_antiga)
        self.assertFalse(os.path.exists(os.path.join(self.repo, 'scripts', 'ci', 'session_guard.py')))

    def test_diretorio_sem_git_reprova_como_entrada_invalida(self):
        semgit = os.path.join(self.tmp, 'semgit')
        os.makedirs(semgit)
        args = [sys.executable, '-I', os.path.join(self.repo, 'scripts', 'ci', 'session_guard.py'),
                '--executor', 'ops/executor.json', '--commits', os.path.join(self.tmp, 'c.json'),
                '--pr-before', os.path.join(self.tmp, 'a.json'), '--pr-after', os.path.join(self.tmp, 'b.json'),
                '--event-head-sha', H1, '--base-sha', self.base_atual, '--repo', semgit]
        r = subprocess.run(args, capture_output=True, text=True, timeout=30, cwd=self.repo,
                           env=dict(os.environ, GIT_CEILING_DIRECTORIES=self.tmp))
        out = json.loads(r.stdout)
        self.assertEqual((r.returncode, out['verdict'], out['reason'], out['base_sha']), (1, 'FAIL', 'INPUT_ERROR', ''))

    def test_base_sha_invalido_reprova(self):
        rc, r = self.rodar('nao-e-sha')
        self.assertEqual((rc, r['reason']), (1, 'BASE_SHA_MISMATCH'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
