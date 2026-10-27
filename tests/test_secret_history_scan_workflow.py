"""Contract for the public full-history secret scan (T5).

The three secret-scan workflows are pinned byte-for-byte: SHA-256 of the file after
normalising only the self-referential test-hash and test-count lines. Any edit to a
run block, env, step, trigger or comment fails. Structural checks below make the
intent readable and give precise failure messages.

Runs (1) as an early step of the scan job and (2) in secret-scan-contract.yml, both on
the PR's own checkout (tamper-evident: the workflow first checks this file's SHA-256,
but a PR can change both), and (3) in secret-scan-contract-protected.yml, where THIS
file comes from the base branch, SCAN_CONTRACT_ROOT points at the PR tree (data only),
and the PR's copy of this file must be identical to the base copy. Changing the scan,
its workflows or this test therefore needs the owner (bypass of the protected check).

Offline. Files under SCAN_CONTRACT_ROOT are only parsed (yaml.BaseLoader) or read as text.
"""
import hashlib
import os
import pathlib
import re
import unittest

import yaml

ROOT = pathlib.Path(os.environ.get('SCAN_CONTRACT_ROOT') or pathlib.Path(__file__).resolve().parents[1]).resolve()
PROTECTED_MODE = bool(os.environ.get('SCAN_CONTRACT_ROOT'))
WF_DIR = ROOT / '.github' / 'workflows'
WORKFLOW = WF_DIR / 'secret-history-scan.yml'
CONTRACT_WF = WF_DIR / 'secret-scan-contract.yml'
PROTECTED_WF = WF_DIR / 'secret-scan-contract-protected.yml'
IGNORE = ROOT / '.gitleaksignore'
BASELINE = ROOT / 'docs' / 'security' / 'secret-scan-baseline.md'
THIS_TEST = 'tests/test_secret_history_scan_workflow.py'
FINGERPRINT = re.compile(r'^[0-9a-f]{40}:[^:\s]+:[a-z0-9-]+:[0-9]+$')
TEST_HASH_LINE = re.compile(r'[0-9a-f]{64}  tests/test_secret_history_scan_workflow\.py')
TEST_COUNT_LINE = re.compile(r'Ran [0-9]+ tests in \.\*')

# SHA-256 of each workflow after normalise(). Update deliberately (owner review).
PINNED_FILES = {
    'scan': 'secret-history-scan.yml',
    'contract': 'secret-scan-contract.yml',
    'protected': 'secret-scan-contract-protected.yml',
}
PINNED_SHA256 = {
    'scan': '429d4dddafefdcf2e33cd6a2bff855fd31b49e11baf1099fa68947fb03a6ecf4',
    'contract': 'ff8980b8f811d8ab33dcbccb748253d77d8a913342a3995ee695efde3620416c',
    'protected': 'cc1cbd6a29e6bf8973c702bd3750c392edd2bd605862286bc1065f4b4a4c4941',
}

STEP_ORDER = [
    'Checkout complete history',
    'Verify complete Git history',
    'Secret scan contract (offline)',
    'Install pinned scanners (checksum-verified)',
    'Refuse repository gitleaks configuration',
    'Gitleaks full-history scan',
    'Gitleaks merge-commit scan (remerge-diff)',
    'TruffleHog verified full-history scan',
    'Consolidate secret scan',
    'Upload sanitized evidence',
]
ACTION_PINS = {
    'Checkout complete history': 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
    'Upload sanitized evidence': 'actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9',
}
ALLOWED_URLS = {
    'https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz',
    'https://github.com/trufflesecurity/trufflehog/releases/download/v${TRUFFLEHOG_VERSION}/trufflehog_${TRUFFLEHOG_VERSION}_linux_amd64.tar.gz',
}
GITLEAKS_COMMITS_CMD = (
    '"$RUNNER_TEMP/scanners/gitleaks" git --config "$RUNNER_TEMP/gitleaks.toml" --log-opts="--all" --redact '
    '--ignore-gitleaks-allow --no-banner --no-color --gitleaks-ignore-path .gitleaksignore '
    '--report-format json --report-path secret-scan/gitleaks.json . 2> "$RUNNER_TEMP/gitleaks.log" || code=$?'
)
GITLEAKS_MERGES_CMD = (
    '"$RUNNER_TEMP/scanners/gitleaks" git --config "$RUNNER_TEMP/gitleaks.toml" --log-opts="--all --merges --remerge-diff" '
    '--redact --ignore-gitleaks-allow --no-banner --no-color --gitleaks-ignore-path .gitleaksignore '
    '--report-format json --report-path secret-scan/gitleaks-merges.json . 2> "$RUNNER_TEMP/gitleaks-merges.log" || code=$?'
)
TRUFFLEHOG_CMD = (
    '"$RUNNER_TEMP/scanners/trufflehog" git "file://$PWD" --only-verified --no-ignore-tag --json --no-update '
    '> secret-scan/trufflehog.raw.jsonl 2> "$RUNNER_TEMP/trufflehog.err" || code=$?'
)


def read(path):
    # Data only: refuse symlinks (a PR could point them outside its own tree).
    if path.is_symlink() or not path.resolve().is_relative_to(ROOT):
        raise AssertionError(f'{path} must be a regular file inside the checkout')
    return path.read_text(encoding='utf-8')


def load(path):
    source = read(path)
    # BaseLoader keeps the "on" key as a string instead of YAML 1.1 boolean True.
    return source, yaml.load(source, Loader=yaml.BaseLoader)


def normalise(source):
    source = TEST_HASH_LINE.sub('TEST_SHA256  tests/test_secret_history_scan_workflow.py', source)
    return TEST_COUNT_LINE.sub('Ran N tests in .*', source)


def test_names(text):
    return re.findall(r'(?m)^    def (test_\w+)\(', text)


class PinContract(unittest.TestCase):
    def test_workflows_pinned_byte_for_byte(self):
        for key, pinned in PINNED_SHA256.items():
            name = PINNED_FILES[key]
            digest = hashlib.sha256(normalise(read(WF_DIR / name)).encode('utf-8')).hexdigest()
            self.assertEqual(digest, pinned, f'{name} differs from the pinned version')

    def test_test_file_hash_and_count_lines(self):
        own = read(ROOT / THIS_TEST)
        digest = hashlib.sha256(own.encode('utf-8')).hexdigest()
        count = len(test_names(own))
        for name in ('secret-history-scan.yml', 'secret-scan-contract.yml'):
            source = read(WF_DIR / name)
            self.assertEqual(TEST_HASH_LINE.findall(source), [f'{digest}  tests/test_secret_history_scan_workflow.py'], name)
            self.assertEqual(TEST_COUNT_LINE.findall(source), [f'Ran {count} tests in .*'], name)

    def test_protected_mode_test_file_identical_to_base(self):
        if not PROTECTED_MODE:
            return  # own checkout: nothing to compare against (no skip, so the run stays plain OK)
        self.assertEqual(read(ROOT / THIS_TEST), pathlib.Path(__file__).read_text(encoding='utf-8'),
                         'the PR must not change the contract test (owner review required)')


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
        self.assertEqual(self.on, {'schedule': [{'cron': '23 6 * * *'}], 'push': {'branches': ['gh-pages']},
                                   'pull_request': '', 'workflow_dispatch': ''})

    def test_minimal_permissions(self):
        self.assertEqual(self.wf.get('permissions'), {'contents': 'read'})
        for job in self.jobs.values():
            self.assertNotIn('permissions', job)
        self.assertNotIn('secrets.', self.source)
        self.assertNotRegex(self.source, r'pull_request_target|workflow_run')


class JobIntegrityContract(Base):
    def test_single_job_never_skipped_or_soft(self):
        self.assertEqual(list(self.jobs), ['full-history'])
        self.assertEqual(set(self.job), {'runs-on', 'timeout-minutes', 'steps'})
        self.assertEqual(self.job['timeout-minutes'], '30')

    def test_step_order_conditions_and_env(self):
        self.assertEqual([s.get('name') for s in self.steps], STEP_ORDER)
        for step in self.steps:
            self.assertNotIn('continue-on-error', step)
            if step['name'] == 'Upload sanitized evidence':
                self.assertEqual(step.get('if'), 'always()')
            else:
                self.assertNotIn('if', step, f"step {step['name']!r} must not be conditional")
            if step['name'] == 'Secret scan contract (offline)':
                self.assertEqual(step.get('env'), {'PYTHONDONTWRITEBYTECODE': '1'})
            else:
                self.assertNotIn('env', step, f"step {step['name']!r} must not set env")
        self.assertEqual(set(self.wf['env']), {'GITLEAKS_VERSION', 'GITLEAKS_SHA256', 'TRUFFLEHOG_VERSION', 'TRUFFLEHOG_SHA256'})

    def test_no_runner_environment_files(self):
        for banned in ('GITHUB_PATH', 'GITHUB_ENV', 'BASH_ENV', 'GITHUB_OUTPUT', 'LD_PRELOAD'):
            self.assertNotIn(banned, self.source, banned)

    def test_actions_pinned_by_full_sha(self):
        uses = [s['uses'] for s in self.steps if 'uses' in s]
        self.assertEqual(sorted(uses), sorted(ACTION_PINS.values()))
        for name, ref in ACTION_PINS.items():
            self.assertEqual(self.by_name[name].get('uses'), ref)

    def test_critical_steps_do_not_swallow_errors(self):
        for name in STEP_ORDER[1:9]:
            run = self.run_of(name)
            self.assertEqual(self.by_name[name].get('shell'), 'bash')
            self.assertTrue(run.lstrip().startswith('set -euo pipefail'), name)
            self.assertNotRegex(run, r'set \+[a-z]*e', name)
            for op in re.findall(r'\|\|[^\n]*', run):
                self.assertEqual(op.strip(), '|| code=$?', f'{name}: {op!r}')


class ScannerContract(Base):
    def test_downloads_only_from_exact_release_urls(self):
        self.assertEqual(set(re.findall(r'https?://[^\s"\']+', self.source)), ALLOWED_URLS)
        self.assertEqual(self.source.count('curl '), 2)

    def test_exact_scanner_invocations(self):
        for name, cmd in (('Gitleaks full-history scan', GITLEAKS_COMMITS_CMD),
                          ('Gitleaks merge-commit scan (remerge-diff)', GITLEAKS_MERGES_CMD),
                          ('TruffleHog verified full-history scan', TRUFFLEHOG_CMD)):
            lines = [l.strip() for l in self.run_of(name).splitlines() if 'scanners/' in l]
            self.assertEqual(lines, [cmd], name)
        self.assertEqual(len(re.findall(r'scanners/gitleaks" git ', self.source)), 2)
        self.assertEqual(len(re.findall(r'scanners/trufflehog" git ', self.source)), 1)

    def test_exact_count_and_fail_closed_logic_identical_in_both_gitleaks_steps(self):
        a = self.run_of('Gitleaks full-history scan').split("python3 - <<'PY'\n", 1)[1].split('\nPY\n', 1)[0]
        b = self.run_of('Gitleaks merge-commit scan (remerge-diff)').split("python3 - <<'PY'\n", 1)[1].split('\nPY\n', 1)[0]
        self.assertEqual(a, b)
        for marker in ("if scanned != expected:", "'--raw', '--numstat', '--format=@%H'",
                       "if not report.exists():", "raise SystemExit(f'GITLEAKS_EXECUTION_ERROR {kind} '"):
            self.assertIn(marker, a)

    def test_no_repository_gitleaks_config_in_tree(self):
        found = []
        for dirpath, dirnames, filenames in os.walk(ROOT, followlinks=False):
            dirnames[:] = [d for d in dirnames if d != '.git']
            for name in filenames + dirnames:
                rel = (pathlib.Path(dirpath) / name).relative_to(ROOT).as_posix()
                looks_like_config = name.startswith('.gitleaks') or ('gitleaks' in name.lower() and name.lower().endswith('.toml'))
                if looks_like_config and rel != '.gitleaksignore':
                    found.append(rel)
        self.assertEqual(found, [])


class OtherWorkflowsContract(unittest.TestCase):
    def test_contract_workflow(self):
        source, wf = load(CONTRACT_WF)
        self.assertEqual(wf['on'], {'pull_request': ''})
        self.assertEqual(wf.get('permissions'), {'contents': 'read'})
        self.assertEqual(list(wf['jobs']), ['contract'])
        self.assertNotIn('if', wf['jobs']['contract'])

    def test_protected_contract_workflow(self):
        source, wf = load(PROTECTED_WF)
        self.assertEqual(wf['on'], {'pull_request_target': ''})
        self.assertEqual(wf.get('permissions'), {'contents': 'read'})
        self.assertNotIn('secrets.', source)
        job = wf['jobs']['protected-contract']
        self.assertNotIn('if', job)
        uses = [s.get('uses') for s in job['steps'] if 'uses' in s]
        self.assertEqual(uses, ['actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1'])
        self.assertEqual(job['steps'][0]['with']['ref'], '${{ github.event.pull_request.base.sha }}')
        self.assertNotIn('allow-unsafe-pr-checkout', source)
        self.assertIn('git -C "$RUNNER_TEMP/pr.git" fetch -q --no-tags --depth=1 "$REPO_URL" "$HEAD_SHA"', source)
        self.assertIn('cd base', source)


class IgnoreFileContract(unittest.TestCase):
    def setUp(self):
        lines = [l.strip() for l in read(IGNORE).splitlines()]
        self.entries = [l for l in lines if l and not l.startswith('#')]

    def test_only_exact_fingerprints(self):
        bad = [l for l in self.entries if not FINGERPRINT.match(l)]
        self.assertEqual(bad, [])
        self.assertEqual(len(self.entries), len(set(self.entries)))

    def test_every_fingerprint_documented(self):
        doc = read(BASELINE)
        documented = set(re.findall(r'\| C\d+ \|[^\n]*\| `([0-9a-f]{40}:[^`]+)` \|', doc))
        self.assertEqual([fp for fp in self.entries if fp not in documented], [])
        self.assertEqual(sorted(documented - set(self.entries)), [])

    def test_every_class_defined(self):
        doc = read(BASELINE)
        used = set(re.findall(r'(?m)^\| (C\d+) \| `', doc))
        defined = set(re.findall(r'(?m)^\| (C\d+) \| [^`|][^|]*\| [^|]+\|$', doc))
        self.assertTrue(used)
        self.assertEqual(sorted(used - defined), [])


if __name__ == '__main__':
    unittest.main()
