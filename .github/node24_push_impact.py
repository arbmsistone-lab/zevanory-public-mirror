#!/usr/bin/env python3
"""Prove which push workflows a Node 24 migration candidate would trigger."""
import argparse
import json
import pathlib
import subprocess
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'scripts' / 'ci'))
import merge_impact as impact  # noqa: E402


def git_text(*args):
    result = subprocess.run(
        ['git', *args], check=True, text=True, encoding='utf-8',
        stdout=subprocess.PIPE,
    )
    return result.stdout


def load_workflows(ref):
    prefix = '.github/workflows/'
    paths = [
        line for line in git_text('ls-tree', '-r', '--name-only', ref, prefix).splitlines()
        if line.endswith(('.yml', '.yaml'))
    ]
    loaded = {}
    for path in paths:
        source = git_text('show', f'{ref}:{path}')
        try:
            parsed = impact.yaml.load(source, Loader=impact.yaml.BaseLoader) or {}
        except impact.yaml.YAMLError:
            parsed = {}
        loaded[pathlib.PurePosixPath(path).name] = (
            parsed if isinstance(parsed, dict) else {}, source,
        )
    return loaded


def classify(base_ref, candidate_ref, explicit_paths):
    changed = explicit_paths or [
        line for line in git_text('diff', '--name-only', f'{base_ref}...{candidate_ref}').splitlines()
        if line
    ]
    changed_workflows = sorted(
        path for path in changed
        if path.startswith('.github/workflows/') and path.endswith(('.yml', '.yaml'))
    )
    effective = load_workflows(candidate_ref)
    by_file = {}
    for path in changed_workflows:
        by_file[path] = sorted(
            name for name, (parsed, _) in effective.items()
            if impact.dispara_por_push(parsed, [path])
        )
    triggered = sorted(
        name for name, (parsed, _) in effective.items()
        if impact.dispara_por_push(parsed, changed)
    )
    return {
        'base_ref': base_ref,
        'candidate_ref': candidate_ref,
        'changed_files': len(changed),
        'changed_workflows': len(changed_workflows),
        'safe_workflows': [path for path, matches in by_file.items() if not matches],
        'unsafe_workflows': [
            {'path': path, 'triggers': matches}
            for path, matches in by_file.items() if matches
        ],
        'push_workflows_triggered_by_complete_diff': triggered,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--base-ref', required=True)
    parser.add_argument('--candidate-ref', default='HEAD')
    parser.add_argument('--path', action='append', default=[])
    parser.add_argument('--assert-safe', action='store_true')
    parser.add_argument('--summary', action='store_true')
    args = parser.parse_args()
    report = classify(args.base_ref, args.candidate_ref, args.path)
    shown = report
    if args.summary:
        shown = {
            'base_ref': report['base_ref'],
            'candidate_ref': report['candidate_ref'],
            'changed_files': report['changed_files'],
            'changed_workflows': report['changed_workflows'],
            'safe_workflow_count': len(report['safe_workflows']),
            'unsafe_workflow_count': len(report['unsafe_workflows']),
            'push_workflows_triggered_by_complete_diff': report['push_workflows_triggered_by_complete_diff'],
        }
    print(json.dumps(shown, ensure_ascii=False, indent=2))
    # The contract is specifically about changed workflow definitions. Repository-wide
    # validation gates may still run for this proof script itself and remain reported.
    if args.assert_safe and report['unsafe_workflows']:
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
