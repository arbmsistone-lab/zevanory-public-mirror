#!/usr/bin/env python3
"""ZEVANORY | Contagem EXATA da suíte Node derivada de um manifesto versionado (contestação Sol C071-3).

Substitui o literal "# tests N" do gate trava-vendas-integracao-postgres: o total esperado é a SOMA do
manifesto tests/node-suite.manifest (uma linha "<arquivo> <quantidade>" por arquivo de teste). Cada PR que
adiciona testes edita só a(s) linha(s) do(s) seu(s) arquivo(s), então PRs paralelas deixam de disputar a
mesma linha. Continua fechado em falha:
  - manifesto ausente, vazio, ilegível, com linha duplicada, quantidade não inteira ou < 1  -> falha
  - arquivo de teste no disco fora do manifesto, ou listado e ausente no disco             -> falha
  - arquivo listado que não reportou testes (descartado em silêncio)                        -> falha
  - quantidade real de um arquivo diferente da do manifesto                                 -> falha
  - resultado no nível do arquivo (erro de carga, process.exit antes dos testes)            -> falha
  - resumo TAP: tests/pass != soma, ou fail/cancelled/skipped/todo != 0, ou linha ausente   -> falha
Uso: node_suite_check.py --manifest tests/node-suite.manifest --tap all.txt --per-file per-file.json
     [--glob 'tests/*.test.mjs'] [--root .]     |  --print-manifest (gera linhas a partir do per-file.json)
Sem rede, sem segredos; só lê arquivos."""
import argparse, glob, json, os, re, sys

LINE = re.compile(r'^(tests/[A-Za-z0-9._/-]+\.test\.mjs) ([0-9]+)$')
SUMMARY = ('tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo')


def err(code, msg=''):
    print(f'::error title={code}::{msg}')


def parse_manifest(path):
    if not os.path.isfile(path):
        return None, [('MANIFEST_MISSING', path)]
    entries, problems = {}, []
    with open(path, encoding='utf-8') as f:
        for n, raw in enumerate(f, 1):
            line = raw.rstrip('\n')
            if not line.strip() or line.lstrip().startswith('#'):
                continue
            m = LINE.match(line)
            if not m:
                problems.append(('MANIFEST_BAD_LINE', f'{path}:{n}: {line!r}')); continue
            name, count = m.group(1), int(m.group(2))
            if count < 1:
                problems.append(('MANIFEST_BAD_COUNT', f'{name} {count}'))
            if name in entries:
                problems.append(('MANIFEST_DUPLICATE', name))
            entries[name] = count
    if not entries:
        problems.append(('MANIFEST_EMPTY', path))
    return entries, problems


def parse_tap(path):
    if not os.path.isfile(path):
        return None, [('TAP_MISSING', path)]
    found, problems = {}, []
    with open(path, encoding='utf-8', errors='replace') as f:
        for line in f:
            m = re.fullmatch(r'# (tests|pass|fail|cancelled|skipped|todo) ([0-9]+)\n?', line)
            if m:
                if m.group(1) in found:
                    problems.append(('TAP_SUMMARY_DUPLICATE', m.group(1)))
                found[m.group(1)] = int(m.group(2))
    for k in SUMMARY:
        if k not in found:
            problems.append(('TAP_SUMMARY_MISSING', k))
    return found, problems


def check(manifest, tap, per_file, pattern, root):
    problems = []
    entries, p = parse_manifest(manifest); problems += p
    summary, p = parse_tap(tap); problems += p
    try:
        with open(per_file, encoding='utf-8') as f:
            pf = json.load(f)
        files = pf['files'] if pf.get('schema') == 'zevanory.node-suite-per-file.v1' else None
        if not isinstance(files, dict):
            raise ValueError('schema')
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as e:
        files = None; problems.append(('PER_FILE_UNREADABLE', f'{per_file}: {e}'))
    if entries is None or not entries or files is None or summary is None:
        return problems, None
    on_disk = {os.path.relpath(p, root).replace(os.sep, '/') for p in glob.glob(os.path.join(root, pattern))}
    for name in sorted(on_disk - entries.keys()):
        problems.append(('MANIFEST_UNLISTED_FILE', f'{name} existe no disco e não está no manifesto'))
    for name in sorted(entries.keys() - on_disk):
        problems.append(('MANIFEST_FILE_ABSENT', f'{name} está no manifesto e não existe no disco'))
    for name in sorted(set(files) - entries.keys()):
        problems.append(('UNEXPECTED_FILE_REPORTED', name))
    for name, want in sorted(entries.items()):
        got = files.get(name)
        if got is None:
            problems.append(('FILE_DROPPED', f'{name}: nenhum teste reportado (esperado {want})')); continue
        if got.get('tests') != want:
            problems.append(('FILE_COUNT_MISMATCH', f'{name}: real {got.get("tests")} != manifesto {want}'))
        for k in ('fail', 'skip', 'todo', 'file_level'):
            if got.get(k, 0) != 0:
                problems.append((f'FILE_{k.upper()}', f'{name}: {k}={got.get(k)}'))
    expected = sum(entries.values())
    if summary.get('tests') != expected:
        problems.append(('TOTAL_MISMATCH', f'# tests {summary.get("tests")} != soma do manifesto {expected}'))
    if summary.get('pass') != expected:
        problems.append(('PASS_MISMATCH', f'# pass {summary.get("pass")} != soma do manifesto {expected}'))
    for k in ('fail', 'cancelled', 'skipped', 'todo'):
        if summary.get(k) != 0:
            problems.append((f'TAP_{k.upper()}', f'# {k} {summary.get(k)}'))
    reported = sum(int(v.get('tests', 0)) for v in files.values())
    if reported != summary.get('tests'):
        problems.append(('REPORTER_TAP_DISAGREE', f'reporter {reported} != TAP {summary.get("tests")}'))
    return problems, expected


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--manifest', default='tests/node-suite.manifest')
    ap.add_argument('--tap', default='all.txt')
    ap.add_argument('--per-file', default='per-file.json')
    ap.add_argument('--glob', default='tests/*.test.mjs')
    ap.add_argument('--root', default='.')
    ap.add_argument('--print-manifest', action='store_true')
    a = ap.parse_args(argv)
    if a.print_manifest:
        with open(a.per_file, encoding='utf-8') as f:
            files = json.load(f)['files']
        for name in sorted(files):
            print(f'{name} {files[name]["tests"]}')
        return 0
    problems, expected = check(a.manifest, a.tap, a.per_file, a.glob, a.root)
    for code, msg in problems:
        err(code, msg)
    if problems:
        print(f'NODE_SUITE_MANIFEST=FAIL problems={len(problems)} expected={expected}')
        return 1
    print(f'NODE_SUITE_MANIFEST=PASS expected={expected} (soma do manifesto) tests={expected} pass={expected} '
          'fail=0 cancelled=0 skipped=0 todo=0')
    return 0


if __name__ == '__main__':
    sys.exit(main())
