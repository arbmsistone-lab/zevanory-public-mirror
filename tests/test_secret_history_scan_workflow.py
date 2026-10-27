"""Contract for the public full-history secret scan (T5).

Pins the security-relevant shape of .github/workflows/secret-history-scan.yml so a
pull request cannot silently weaken it: floating scanners, lost or narrowed triggers,
wider permissions, skipped/soft-failing steps, swallowed exit codes, repository or
environment gitleaks configuration, inline-allow comments, narrowed scan scope, an
undocumented ignore entry, or removal of the contract itself.

Offline: reads files only. No network, no secrets.
Runs (1) as the first step of the scan job, (2) in secret-scan-contract.yml on the PR
checkout, and (3) in secret-scan-contract-protected.yml, where THIS file comes from the
base branch and SCAN_CONTRACT_ROOT points at the PR head checked out as data only.
Files under SCAN_CONTRACT_ROOT are only parsed (yaml.BaseLoader) or read as text.
Making these checks required on gh-pages is a branch-protection decision of the owner.
"""
import os
import pathlib
import re
import unittest

import yaml

ROOT = pathlib.Path(os.environ.get('SCAN_CONTRACT_ROOT') or pathlib.Path(__file__).resolve().parents[1]).resolve()
WORKFLOW = ROOT / '.github' / 'workflows' / 'secret-history-scan.yml'
CONTRACT_WF = ROOT / '.github' / 'workflows' / 'secret-scan-contract.yml'
PROTECTED_WF = ROOT / '.github' / 'workflows' / 'secret-scan-contract-protected.yml'
IGNORE = ROOT / '.gitleaksignore'
BASELINE = ROOT / 'docs' / 'security' / 'secret-scan-baseline.md'
THIS_TEST = 'tests/test_secret_history_scan_workflow.py'
FINGERPRINT = re.compile(r'^[0-9a-f]{40}:[^:\s]+:[a-z0-9-]+:[0-9]+$')

GITLEAKS_CMD = (
    'gitleaks git --config "$RUNNER_TEMP/gitleaks.toml" --log-opts="--all" --redact '
    '--ignore-gitleaks-allow --no-banner --no-color --gitleaks-ignore-path .gitleaksignore '
    '--report-format json --report-path secret-scan/gitleaks.json . '
    '2> "$RUNNER_TEMP/gitleaks.log" || code=$?'
)
TRUFFLEHOG_CMD = (
    'trufflehog git "file://$PWD" --only-verified --no-ignore-tag --json --no-update '
    '> secret-scan/trufflehog.raw.jsonl 2> "$RUNNER_TEMP/trufflehog.err" || code=$?'
)
CONTROLLED_CONFIG = (
    "printf '%s\\n' 'title = \"zevanory-controlled-default\"' '[extend]' 'useDefault = true' "
    '> "$RUNNER_TEMP/gitleaks.toml"'
)
ALLOWED_URLS = {
    'https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz',
    'https://github.com/trufflesecurity/trufflehog/releases/download/v${TRUFFLEHOG_VERSION}/trufflehog_${TRUFFLEHOG_VERSION}_linux_amd64.tar.gz',
}
STEP_ORDER = [
    'Checkout complete history',
    'Verify complete Git history',
    'Secret scan contract (offline)',
    'Install pinned scanners (checksum-verified)',
    'Refuse repository gitleaks configuration',
    'Gitleaks full-history scan',
    'TruffleHog verified full-history scan',
    'Consolidate secret scan',
    'Upload sanitized evidence',
]
CRITICAL = STEP_ORDER[1:8]
ACTION_PINS = {
    'Checkout complete history': 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
    'Upload sanitized evidence': 'actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9',
}


def read(path):
    # Data only: refuse symlinks (a PR could point them outside its own tree).
    if path.is_symlink() or not path.resolve().is_relative_to(ROOT):
        raise AssertionError(f'{path} must be a regular file inside the checkout')
    return path.read_text(encoding='utf-8')


def load(path):
    source = read(path)
    # BaseLoader keeps the "on" key as a string instead of YAML 1.1 boolean True.
    return source, yaml.load(source, Loader=yaml.BaseLoader)


class Base(unittest.TestCase):
    def setUp(self):
        self.source, self.wf = load(WORKFLOW)
        self.on = self.wf['on']
        self.jobs = self.wf['jobs']
        self.job = self.jobs['full-history']
        self.steps = self.job['steps']
        self.by_name = {s.get('name'): s for s in self.steps}

    def run_of(self, name):
        return self.by_name[name].get('run', '')


class TriggerContract(Base):
    def test_trigger_set_is_exact(self):
        self.assertEqual(set(self.on), {'schedule', 'push', 'pull_request', 'workflow_dispatch'})

    def test_daily_schedule(self):
        schedule = self.on.get('schedule')
        self.assertIsInstance(schedule, list)
        self.assertEqual(len(schedule), 1)
        cron = schedule[0].get('cron', '').strip()
        m = re.fullmatch(r'(\d{1,2}) (\d{1,2}) \* \* \*', cron)
        self.assertIsNotNone(m, f'not a daily cron: {cron!r}')
        self.assertLess(int(m.group(1)), 60)
        self.assertLess(int(m.group(2)), 24)

    def test_push_to_gh_pages_only_filter(self):
        self.assertEqual(self.on.get('push'), {'branches': ['gh-pages']})

    def test_every_pull_request_unfiltered(self):
        self.assertIn('pull_request', self.on)
        self.assertIn(self.on['pull_request'], ('', None, {}), 'pull_request must have no filters')

    def test_minimal_permissions(self):
        self.assertEqual(self.wf.get('permissions'), {'contents': 'read'})
        for job in self.jobs.values():
            self.assertNotIn('permissions', job)
        self.assertNotIn('secrets.', self.source)
        self.assertNotRegex(self.source, r'pull_request_target|workflow_run')


class JobIntegrityContract(Base):
    def test_single_job_never_skipped_or_soft(self):
        self.assertEqual(list(self.jobs), ['full-history'])
        for key in ('if', 'continue-on-error', 'strategy', 'needs', 'uses', 'env'):
            self.assertNotIn(key, self.job, f'job must not set {key}')
        self.assertNotRegex(self.source, r'continue-on-error')

    def test_step_order_and_no_conditions(self):
        self.assertEqual([s.get('name') for s in self.steps], STEP_ORDER)
        for step in self.steps:
            self.assertNotIn('continue-on-error', step)
            if step['name'] == 'Upload sanitized evidence':
                self.assertEqual(step.get('if'), 'always()')
            else:
                self.assertNotIn('if', step, f"step {step['name']!r} must not be conditional")

    def test_actions_pinned_by_full_sha(self):
        uses = [s['uses'] for s in self.steps if 'uses' in s]
        self.assertEqual(sorted(uses), sorted(ACTION_PINS.values()))
        for name, ref in ACTION_PINS.items():
            self.assertEqual(self.by_name[name].get('uses'), ref)

    def test_critical_steps_do_not_swallow_errors(self):
        for name in CRITICAL:
            run = self.run_of(name)
            step = self.by_name[name]
            self.assertEqual(step.get('shell'), 'bash')
            self.assertTrue(run.lstrip().startswith('set -euo pipefail'), f'{name}: must start with set -euo pipefail')
            self.assertNotRegex(run, r'set \+[a-z]*e', f'{name}: set +e')
            for op in re.findall(r'\|\|[^\n]*', run):
                self.assertEqual(op.strip(), '|| code=$?', f'{name}: only "|| code=$?" may follow ||, got {op!r}')
            self.assertNotRegex(run, r'(?m)^\s*exit 0\b', f'{name}: explicit exit 0')
            self.assertNotRegex(run, r'(?m)^\s*trap\b', f'{name}: trap')
        self.assertNotRegex(self.source, r'\|\|\s*(true|:)\b')

    def test_consolidate_fails_on_any_failure(self):
        run = self.run_of('Consolidate secret scan')
        self.assertIn("'pass':bool(g['pass'] and t['pass'])", run)
        self.assertIn("if not out['pass']: raise SystemExit(1)", run)


class PinningContract(Base):
    def test_no_floating_scanners(self):
        for pattern in (r':latest\b', r'releases/latest', r'[Dd]ocker\b', r'\bnpx\b', r'go install', r'pip install (?!--quiet --user --break-system-packages "pyyaml==6\.0\.2")'):
            hits = re.findall(r'^.*' + pattern + r'.*$', self.source, re.M)
            self.assertEqual(hits, [], f'floating scanner reference: {pattern}')

    def test_exact_versions_and_digests(self):
        env = self.wf.get('env') or {}
        self.assertEqual(set(env), {'GITLEAKS_VERSION', 'GITLEAKS_SHA256', 'TRUFFLEHOG_VERSION', 'TRUFFLEHOG_SHA256'})
        for name in ('GITLEAKS', 'TRUFFLEHOG'):
            self.assertRegex(env[f'{name}_VERSION'], r'^\d+\.\d+\.\d+$')
            self.assertRegex(env[f'{name}_SHA256'], r'^[0-9a-f]{64}$')

    def test_downloads_only_from_exact_release_urls_and_verified(self):
        urls = set(re.findall(r'https?://[^\s"\']+', self.source))
        self.assertEqual(urls, ALLOWED_URLS, 'only the two exact GitHub release URLs are allowed')
        install = self.run_of('Install pinned scanners (checksum-verified)')
        self.assertEqual(install.count('curl '), 2)
        self.assertEqual(self.source.count('curl '), 2)
        self.assertIn('echo "${GITLEAKS_SHA256}  $RUNNER_TEMP/gitleaks.tar.gz" | sha256sum -c -\n', install)
        self.assertIn('echo "${TRUFFLEHOG_SHA256}  $RUNNER_TEMP/trufflehog.tar.gz" | sha256sum -c -\n', install)
        self.assertIn('test "$("$bin/gitleaks" version)" = "${GITLEAKS_VERSION}"', install)
        self.assertIn('grep -qx "trufflehog ${TRUFFLEHOG_VERSION}"', install)


class ScannerModeContract(Base):
    def test_exact_gitleaks_invocation(self):
        run = self.run_of('Gitleaks full-history scan')
        lines = [l.strip() for l in run.splitlines() if re.match(r'\s*gitleaks\b', l)]
        self.assertEqual(lines, [GITLEAKS_CMD])
        self.assertEqual(len(re.findall(r'\bgitleaks (git|detect|dir|protect|stdin)\b', self.source)), 1)

    def test_exact_trufflehog_invocation(self):
        run = self.run_of('TruffleHog verified full-history scan')
        lines = [l.strip() for l in run.splitlines() if re.match(r'\s*trufflehog\b', l)]
        self.assertEqual(lines, [TRUFFLEHOG_CMD])
        self.assertEqual(len(re.findall(r'\btrufflehog (git|filesystem|github)\b', self.source)), 1)

    def test_no_scope_or_rule_overrides(self):
        for banned in ('--enable-rule', '--baseline-path', '--max-target-megabytes', '--exclude-paths',
                       '--exclude-detectors', '--exclude-globs', '--include-paths', '--since-commit',
                       '--max-depth', '--branch', '--no-verification', '--results', '--allow-verification-overlap',
                       '--filter-entropy'):
            self.assertNotIn(banned, self.source, banned)
        self.assertEqual(self.source.count('--log-opts'), 1)
        self.assertEqual(self.source.count('--config'), 1)
        self.assertIn('fetch-depth: 0', self.source)
        self.assertIn('persist-credentials: false', self.source)

    def test_no_gitleaks_config_from_env(self):
        def env_keys(node):
            if isinstance(node, dict):
                for k, v in node.items():
                    if k == 'env' and isinstance(v, dict):
                        yield from v.keys()
                    yield from env_keys(v)
            elif isinstance(node, list):
                for item in node:
                    yield from env_keys(item)
        keys = set(env_keys(self.wf))
        self.assertFalse({k for k in keys if k.upper().startswith('GITLEAKS_CONFIG')}, keys)
        self.assertNotRegex(self.source, r'GITLEAKS_CONFIG(_TOML)?\s*=')
        self.assertNotRegex(self.source, r'GITHUB_ENV')

    def test_repo_config_refused_and_controlled_config_used(self):
        run = self.run_of('Refuse repository gitleaks configuration')
        self.assertIn("found=\"$(find . -path ./.git -prune -o -name '.gitleaks*' ! -path ./.gitleaksignore -print)\"", run)
        self.assertIn('if [ -n "$found" ]; then', run)
        self.assertIn('for var in GITLEAKS_CONFIG GITLEAKS_CONFIG_TOML; do', run)
        self.assertIn('if [ -n "${!var:-}" ]; then', run)
        self.assertEqual(run.count('exit 1'), 2)
        self.assertIn(CONTROLLED_CONFIG, run)

    def test_no_repository_gitleaks_config_in_tree(self):
        found = []
        for dirpath, dirnames, filenames in os.walk(ROOT, followlinks=False):
            dirnames[:] = [d for d in dirnames if d != '.git']
            for name in filenames + dirnames:
                rel = (pathlib.Path(dirpath) / name).relative_to(ROOT).as_posix()
                if name.startswith('.gitleaks') and rel != '.gitleaksignore':
                    found.append(rel)
        self.assertEqual(found, [])

    def test_gitleaks_fails_closed(self):
        run = self.run_of('Gitleaks full-history scan')
        for marker in ("if not p.exists(): problems.append('GITLEAKS_REPORT_MISSING')",
                       "if code not in (0,1): problems.append(f'GITLEAKS_EXIT={code}')",
                       "if code==1 and not rows: problems.append('GITLEAKS_EXIT_1_WITHOUT_FINDINGS')",
                       "if code==0 and rows: problems.append('GITLEAKS_EXIT_0_WITH_FINDINGS')",
                       "if err_lines: problems.append",
                       "floor=math.floor(0.95*expected)",
                       "if scanned<=0 or scanned<floor: problems.append",
                       'expected="$(git rev-list --all --no-merges --count)"',
                       "raise SystemExit('GITLEAKS_EXECUTION_ERROR '",
                       "'pass':code==0 and not rows and not problems"):
            self.assertIn(marker, run)

    def test_trufflehog_fails_closed_and_shows_stderr(self):
        run = self.run_of('TruffleHog verified full-history scan')
        for marker in ("if code!=0: problems.append(f'TRUFFLEHOG_EXIT={code}')",
                       "if chunks<=0: problems.append",
                       "print('\\n'.join(err.splitlines()[-60:]))",
                       "raise SystemExit('TRUFFLEHOG_EXECUTION_ERROR '",
                       "'pass':count==0 and not problems"):
            self.assertIn(marker, run)


class SelfCoverageContract(Base):
    def test_scan_job_runs_this_contract_first(self):
        run = self.run_of('Secret scan contract (offline)')
        self.assertIn(f'test -f {THIS_TEST}', run)
        self.assertIn('test -f .github/workflows/secret-scan-contract.yml', run)
        self.assertIn('test -f .github/workflows/secret-scan-contract-protected.yml', run)
        self.assertIn('python3 -m unittest discover -v -s tests -p test_secret_history_scan_workflow.py', run)
        self.assertIn(f'grep -qx "Ran {self.expected_count()} tests in .*"', run)
        self.assertIn('grep -qx "OK"', run)

    def test_contract_workflow(self):
        source, wf = load(CONTRACT_WF)
        self.assertEqual(wf['on'], {'pull_request': ''}, 'no path/branch filters: a filtered required check stays pending')
        self.assertEqual(wf.get('permissions'), {'contents': 'read'})
        self.assertNotIn('secrets.', source)
        self.assertNotRegex(source, r'continue-on-error|\|\|\s*(true|:)\b|set \+[a-z]*e')
        job = wf['jobs']['contract']
        self.assertNotIn('if', job)
        for step in job['steps']:
            self.assertNotIn('if', step)
            self.assertNotIn('continue-on-error', step)
        self.assertIn('python3 -m unittest discover -v -s tests -p test_secret_history_scan_workflow.py', source)
        self.assertIn(f'grep -qx "Ran {self.expected_count()} tests in .*"', source)

    def expected_count(self):
        # Count from the test file in the checkout under validation (the PR's own file).
        names = re.findall(r'(?m)^    def (test_\w+)\(', read(ROOT / THIS_TEST))
        return len(names)

    def test_protected_contract_workflow(self):
        source, wf = load(PROTECTED_WF)
        self.assertEqual(wf['on'], {'pull_request_target': ''}, 'no filters on the protected trigger')
        self.assertEqual(wf.get('permissions'), {'contents': 'read'})
        self.assertNotIn('secrets.', source)
        self.assertEqual(list(wf['jobs']), ['protected-contract'])
        job = wf['jobs']['protected-contract']
        for key in ('if', 'continue-on-error', 'env', 'permissions', 'needs'):
            self.assertNotIn(key, job)
        steps = job['steps']
        self.assertEqual([s.get('name') for s in steps], [
            'Checkout trusted base (contract code)',
            'Checkout pull request head as data only',
            'Validate PR secret-scan files with the base contract'])
        pin = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1'
        self.assertEqual(steps[0].get('uses'), pin)
        self.assertEqual(steps[0]['with'], {'ref': '${{ github.event.pull_request.base.sha }}', 'path': 'base', 'persist-credentials': 'false'})
        self.assertEqual(steps[1].get('uses'), pin)
        self.assertEqual(steps[1]['with'], {'ref': '${{ github.event.pull_request.head.sha }}', 'path': 'pr', 'persist-credentials': 'false'})
        for step in steps:
            self.assertNotIn('if', step)
            self.assertNotIn('continue-on-error', step)
        run = steps[2]['run']
        self.assertEqual([l.strip() for l in run.strip().splitlines()], [
            'set -euo pipefail',
            'python3 -m pip install --quiet --target "$RUNNER_TEMP/pydeps" "pyyaml==6.0.2"',
            'cd base',
            'SCAN_CONTRACT_ROOT="$GITHUB_WORKSPACE/pr" PYTHONPATH="$RUNNER_TEMP/pydeps" python3 -P -m unittest discover -v -s tests -p test_secret_history_scan_workflow.py 2>&1 | tee "$RUNNER_TEMP/contract.txt"',
            'grep -qE "^Ran [0-9]+ tests in " "$RUNNER_TEMP/contract.txt"',
            'grep -qx "OK" "$RUNNER_TEMP/contract.txt"'])

    def test_history_coverage_step(self):
        run = self.run_of('Verify complete Git history')
        for marker in ('test "$(git rev-parse --is-shallow-repository)" = "false"',
                       "out = git('ls-remote', '--heads', 'origin')",
                       "git('cat-file', '-e', sha + '^{commit}', check=False)",
                       "'pass': not miss and len(heads) > 0 and total > 1",
                       "raise SystemExit(f'HISTORY_INCOMPLETE"):
            self.assertIn(marker, run)


class IgnoreFileContract(unittest.TestCase):
    def setUp(self):
        lines = [l.strip() for l in read(IGNORE).splitlines()]
        self.entries = [l for l in lines if l and not l.startswith('#')]

    def test_only_exact_fingerprints(self):
        bad = [l for l in self.entries if not FINGERPRINT.match(l)]
        self.assertEqual(bad, [], 'only commit:file:rule:line fingerprints are allowed')
        self.assertEqual(len(self.entries), len(set(self.entries)), 'duplicate fingerprints')
        self.assertGreater(len(self.entries), 0)

    def test_every_fingerprint_documented(self):
        doc = read(BASELINE)
        documented = set(re.findall(r'\| C\d+ \|[^\n]*\| `([0-9a-f]{40}:[^`]+)` \|', doc))
        missing = [fp for fp in self.entries if fp not in documented]
        self.assertEqual(missing, [], 'every ignore entry needs a classification row')
        stale = sorted(documented - set(self.entries))
        self.assertEqual(stale, [], 'documented fingerprints must all be in .gitleaksignore')

    def test_every_class_defined(self):
        doc = read(BASELINE)
        used = set(re.findall(r'(?m)^\| (C\d+) \| `', doc))
        defined = set(re.findall(r'(?m)^\| (C\d+) \| [^`|][^|]*\| [^|]+\|$', doc))
        self.assertTrue(used)
        self.assertEqual(sorted(used - defined), [], 'every class used by a fingerprint row needs a definition row')


if __name__ == '__main__':
    unittest.main()
