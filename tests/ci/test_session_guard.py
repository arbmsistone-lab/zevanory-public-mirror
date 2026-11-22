"""Testes do scripts/ci/session_guard.py (22/11/2026). Rodar: python3 -I tests/ci/test_session_guard.py"""
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

RAIZ = pathlib.Path(__file__).resolve().parents[2]
SCRIPT = RAIZ / 'scripts' / 'ci' / 'session_guard.py'
A = 'session_013qEayJV2BctKApuM3NnNgu'
B = 'session_01BEoZWaBFoF9w15T3McDGya'
X = 'session_0XXforeignXXsession00'


def rodar(lista, commits, corpo='', esperado=None, executor_bruto=None):
    with tempfile.TemporaryDirectory() as d:
        ex, cm, bd = (os.path.join(d, n) for n in ('executor.json', 'commits.json', 'body.txt'))
        with open(ex, 'w', encoding='utf-8') as f:
            f.write(executor_bruto if executor_bruto is not None else json.dumps({'authorized_claude_sessions': lista}))
        with open(cm, 'w', encoding='utf-8') as f:
            json.dump([[{'commit': {'message': m}} for m in commits]], f)
        with open(bd, 'w', encoding='utf-8') as f:
            f.write(corpo)
        args = [sys.executable, '-I', str(SCRIPT), '--executor', ex, '--commits', cm, '--body', bd]
        if esperado is not None:
            args += ['--expected-commits', str(esperado)]
        p = subprocess.run(args, capture_output=True, text=True, timeout=30)
        return p.returncode, json.loads(p.stdout)


class SessionGuard(unittest.TestCase):
    def test_autorizada_em_commit_passa(self):
        rc, r = rodar([A, B], ['fix: x\n\nClaude-Session: https://claude.ai/code/' + A], esperado=1)
        self.assertEqual((rc, r['verdict'], r['declared']), (0, 'PASS', [A]))

    def test_autorizada_so_no_corpo_passa(self):
        rc, r = rodar([A], ['fix: x'], corpo='https://claude.ai/code/' + A, esperado=1)
        self.assertEqual((rc, r['verdict']), (0, 'PASS'))

    def test_ausente_reprova(self):
        rc, r = rodar([A], ['fix: x'], corpo='sem sessao', esperado=1)
        self.assertEqual((rc, r['reason']), (1, 'EXECUTOR_IDENTITY_NOT_ESTABLISHED'))

    def test_estrangeira_reprova(self):
        rc, r = rodar([A], ['fix\n' + X], esperado=1)
        self.assertEqual((rc, r['reason'], r['unauthorised']), (1, 'UNAUTHORISED_EXECUTOR_SESSION', [X]))

    def test_mista_reprova(self):
        rc, r = rodar([A], ['a\n' + A, 'b\n' + X], esperado=2)
        self.assertEqual((rc, r['unauthorised']), (1, [X]))

    def test_contagem_divergente_reprova(self):
        rc, r = rodar([A], ['a\n' + A], esperado=2)
        self.assertEqual((rc, r['reason']), (1, 'COMMIT_COUNT_MISMATCH'))

    def test_lista_vazia_reprova(self):
        rc, r = rodar([], ['a\n' + A], esperado=1)
        self.assertEqual((rc, r['reason']), (1, 'INPUT_ERROR'))

    def test_lista_mal_formada_reprova(self):
        for bruto in ('{', '[]', json.dumps({'authorized_claude_sessions': ['x']}),
                      json.dumps({'authorized_claude_sessions': [A, A]})):
            rc, r = rodar([], ['a\n' + A], esperado=1, executor_bruto=bruto)
            self.assertEqual((rc, r['reason']), (1, 'INPUT_ERROR'), bruto)

    def test_lista_so_da_base(self):
        # O PR pode trazer outra lista em ops/executor.json: o script só lê o caminho passado (checkout da BASE).
        rc, r = rodar([A], ['a\n' + X + '\n{"authorized_claude_sessions": ["' + X + '"]}'], esperado=1)
        self.assertEqual((rc, r['verdict'], r['list_source']), (1, 'FAIL', 'base'))


class WorkflowDaBase(unittest.TestCase):
    def test_workflow_roda_da_base_sem_codigo_do_pr(self):
        y = (RAIZ / '.github' / 'workflows' / 'session-guard.yml').read_text(encoding='utf-8')
        self.assertIn('pull_request_target:', y)
        self.assertNotIn('\n  pull_request:', y)
        self.assertIn('ref: ${{ github.event.pull_request.base.sha }}', y)
        self.assertNotIn('head.ref', y)
        self.assertNotIn('pull_request.head.sha }}\n', y.split('Checkout da base')[1].split('- name:')[0])
        self.assertIn('--executor ops/executor.json', y)
        self.assertIn('persist-credentials: false', y)
        self.assertNotIn('secrets.', y)
        for ev in ('opened', 'synchronize', 'reopened', 'edited'):
            self.assertIn(ev, y)

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


if __name__ == '__main__':
    unittest.main(verbosity=2)
