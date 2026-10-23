#!/usr/bin/env python3
"""ZEVANORY | Higiene: falha se o índice do git rastreia bytecode Python (*.pyc, *.pyo, __pycache__/).
Também falha se as regras do .gitignore que impedem a volta desse lixo sumirem.
Só lê `git ls-files` e `git check-ignore` do repositório indicado; não usa rede nem segredos.
Uso: python3 scripts/ci/no_tracked_bytecode.py [--repo DIR]   (saída 0 = limpo; 1 = achado)"""
import argparse, re, subprocess, sys

BYTECODE = re.compile(r'(^|/)__pycache__(/|$)|\.py[co]$')
# caminhos de prova: cada um tem de ser ignorado pelo .gitignore do repositório
PROBES = ('__pycache__/x.cpython-313.pyc', 'tests/__pycache__/x.cpython-313.pyc', 'scripts/ci/x.pyc', 'x.pyo')


def git(repo, *args):
    return subprocess.run(['git', '-C', repo, *args], capture_output=True, check=False, stdin=subprocess.DEVNULL)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--repo', default='.')
    a = ap.parse_args(argv)
    ls = git(a.repo, 'ls-files', '-z')
    if ls.returncode != 0:
        print('::error title=BYTECODE_GUARD::git ls-files falhou'); return 1
    tracked = [p for p in ls.stdout.decode('utf-8', 'replace').split('\0') if p and BYTECODE.search(p)]
    for p in tracked:
        print(f'::error title=TRACKED_BYTECODE::{p}')
    missing = []
    for probe in PROBES:
        r = git(a.repo, 'check-ignore', '-q', '--no-index', probe)
        if r.returncode != 0:
            missing.append(probe)
            print(f'::error title=GITIGNORE_MISSING_BYTECODE_RULE::{probe} não é ignorado')
    print(f'TRACKED_BYTECODE={len(tracked)} GITIGNORE_GAPS={len(missing)}')
    return 1 if tracked or missing else 0


if __name__ == '__main__':
    sys.exit(main())
