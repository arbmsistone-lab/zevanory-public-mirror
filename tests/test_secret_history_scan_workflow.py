"""Contract for the public full-history secret scan (T5).

Pins byte-for-byte (SHA-256) the three secret-scan workflows and the scanner driver
scripts/ci/secret_scan.py; only the workflows' self-referential test-hash/test-count
lines are normalised. Structural checks below state the intent with precise messages.

Runs (1) in the scan job and (2) in secret-scan-contract.yml on the PR's own checkout
(tamper-evident: the test file's SHA-256 is checked first, but a PR can change both),
and (3) in secret-scan-contract-protected.yml, where THIS file comes from the base
branch, SCAN_CONTRACT_ROOT points at the PR tree (data only), and the PR's copy of this
file must equal the base copy. That workflow also runs the BASE scanner driver on the
PR head, so the verdict never depends on PR-controlled code. Changing the scan, its
workflows, the driver or this test therefore needs the owner (bypass after review).

Offline. Files under SCAN_CONTRACT_ROOT are only parsed (yaml.BaseLoader / ast) or read.
"""
import ast
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
DRIVER = ROOT / 'scripts' / 'ci' / 'secret_scan.py'
IGNORE = ROOT / '.gitleaksignore'
BASELINE = ROOT / 'docs' / 'security' / 'secret-scan-baseline.md'
THIS_TEST = 'tests/test_secret_history_scan_workflow.py'
FINGERPRINT = re.compile(r'^[0-9a-f]{40}:[^:\s]+:[a-z0-9-]+:[0-9]+$')
TEST_HASH_LINE = re.compile(r'[0-9a-f]{64}  tests/test_secret_history_scan_workflow\.py')
TEST_COUNT_LINE = re.compile(r'Ran [0-9]+ tests in \.\*')

# SHA-256 after normalise(). Update deliberately (owner review).
PINNED_FILES = {
    'scan': '.github/workflows/secret-history-scan.yml',
    'contract': '.github/workflows/secret-scan-contract.yml',
    'protected': '.github/workflows/secret-scan-contract-protected.yml',
    'driver': 'scripts/ci/secret_scan.py',
}
PINNED_SHA256 = {
    'scan': 'd890f36830808b15db8392d6fdd9bd7d2ea19b01694155593cc652024d375d1d',
    'contract': 'ff8980b8f811d8ab33dcbccb748253d77d8a913342a3995ee695efde3620416c',
    'protected': '63dc22c507104346ed76bd299209a7a95edbd2f843d06101e2ecd991feeac8ea',
    'driver': 'e710f4a5ee3f1ca18b6982ab310f7436789d3f5c77e6a021954324ed9d7730f5',
}
CHECKOUT = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1'
UPLOAD = 'actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9'
SCAN_CMD = 'python3 -I -S scripts/ci/secret_scan.py full-history --repo . --ignore .gitleaksignore --out secret-scan'
VERDICT_CMD = ('python3 -I -S base/scripts/ci/secret_scan.py pr-head --repo "$RUNNER_TEMP/pr-repo" --rev "$HEAD_SHA" '
               '--ignore base/.gitleaksignore --out "$RUNNER_TEMP/verdict"')
RELEASE_URLS = {
    'https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz',
    'https://github.com/trufflesecurity/trufflehog/releases/download/v3.99.2/trufflehog_3.99.2_linux_amd64.tar.gz',
}
TARBALL_SHA256 = {
    'gitleaks': '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb',
    'trufflehog': '3c7b0d1dc4278294269bfdd7594bca8bb28c78da0a4a06ad202ded37b48deca4',
}


def read(path):
    # Data only: refuse symlinks (a PR could point them outside its own tree).
    if path.is_symlink() or not path.resolve().is_relative_to(ROOT):
        raise AssertionError(f'{path} must be a regular file inside the checkout')
    # Exact bytes: no universal-newline translation, so a CRLF rewrite changes the pin.
    return path.read_bytes().decode('utf-8')


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
    def test_files_pinned_byte_for_byte(self):
        for key, pinned in PINNED_SHA256.items():
            digest = hashlib.sha256(normalise(read(ROOT / PINNED_FILES[key])).encode('utf-8')).hexdigest()
            self.assertEqual(digest, pinned, f'{PINNED_FILES[key]} differs from the pinned version')

    def test_test_file_hash_and_count_lines(self):
        own = read(ROOT / THIS_TEST)
        digest = hashlib.sha256(own.encode('utf-8')).hexdigest()
        count = len(test_names(own))
        for path in (WORKFLOW, CONTRACT_WF):
            source = read(path)
            self.assertEqual(TEST_HASH_LINE.findall(source), [f'{digest}  tests/test_secret_history_scan_workflow.py'], path.name)
            self.assertEqual(TEST_COUNT_LINE.findall(source), [f'Ran {count} tests in .*'], path.name)

    def test_protected_mode_test_file_identical_to_base(self):
        if not PROTECTED_MODE:
            return  # own checkout: nothing to compare against (no skip, so the run stays plain OK)
        self.assertEqual(read(ROOT / THIS_TEST), pathlib.Path(__file__).read_text(encoding='utf-8'),
                         'the PR must not change the contract test (owner review required)')


class ScanWorkflowContract(unittest.TestCase):
    def setUp(self):
        self.source, self.wf = load(WORKFLOW)

    def test_triggers_permissions_job(self):
        self.assertEqual(self.wf['on'], {'schedule': [{'cron': '23 6 * * *'}], 'push': {'branches': ['gh-pages']},
                                         'pull_request': '', 'workflow_dispatch': ''})
        self.assertEqual(self.wf['permissions'], {'contents': 'read'})
        self.assertNotIn('env', self.wf)
        self.assertEqual(list(self.wf['jobs']), ['full-history'])
        self.assertEqual(set(self.wf['jobs']['full-history']), {'runs-on', 'timeout-minutes', 'steps'})
        self.assertNotRegex(self.source, r'secrets\.|pull_request_target|workflow_run|continue-on-error')
        for banned in ('GITHUB_PATH', 'GITHUB_ENV', 'BASH_ENV', 'GITHUB_OUTPUT', 'LD_PRELOAD', 'GITLEAKS_CONFIG', '--offline-tarballs'):
            self.assertNotIn(banned, self.source, banned)

    def test_steps(self):
        steps = self.wf['jobs']['full-history']['steps']
        self.assertEqual([s.get('name') for s in steps], [
            'Checkout complete history', 'Secret scan contract (offline)',
            'Full-history secret scan (pinned, verified scanners)', 'Upload sanitized evidence'])
        self.assertEqual(steps[0]['uses'], CHECKOUT)
        self.assertEqual(steps[0]['with'], {'fetch-depth': '0', 'persist-credentials': 'false'})
        self.assertEqual(steps[1].get('env'), {'PYTHONDONTWRITEBYTECODE': '1'})
        self.assertEqual([l.strip() for l in steps[2]['run'].strip().splitlines()], ['set -euo pipefail', SCAN_CMD])
        self.assertNotIn('env', steps[2])
        self.assertEqual(steps[3]['uses'], UPLOAD)
        self.assertEqual(steps[3].get('if'), 'always()')
        for s in steps[:3]:
            self.assertNotIn('if', s)


class DriverContract(unittest.TestCase):
    def setUp(self):
        self.source = read(DRIVER)
        self.tree = ast.parse(self.source)
        self.funcs = {n.name: n for n in ast.walk(self.tree) if isinstance(n, ast.FunctionDef)}

    def test_pinned_releases(self):
        self.assertEqual(set(re.findall(r'https?://[^\s\'"]+', self.source)), RELEASE_URLS)
        for name, digest in TARBALL_SHA256.items():
            self.assertIn(f"'tar_sha256': '{digest}'", self.source)
        self.assertEqual(len(re.findall(r"'bin_sha256': '[0-9a-f]{64}'", self.source)), 2)
        self.assertIn("GIT = '/usr/bin/git'", self.source)

    def test_only_git_or_verified_binaries_are_executed(self):
        for node in ast.walk(self.tree):
            if isinstance(node, ast.Call):
                fn = ast.unparse(node.func)
                self.assertNotRegex(fn, r'^(os\.(system|popen|exec\w*|spawn\w*)|subprocess\.(Popen|call|check_call|check_output|getoutput|getstatusoutput))$', fn)
                if fn == 'subprocess.run':
                    self.assertFalse(any(k.arg == 'shell' for k in node.keywords), 'shell=True is forbidden')
                    first = node.args[0]
                    self.assertIsInstance(first, ast.List)
                    head = ast.unparse(first.elts[0])
                    self.assertIn(head, ('GIT', 'str(path)'), f'unexpected executable {head}')
                    self.assertTrue(any(k.arg == 'env' for k in node.keywords), 'every subprocess needs the clean env')
        # The only call that executes str(path) is in run_scanner, right after verify_binary.
        body = self.funcs['run_scanner'].body
        self.assertEqual(ast.unparse(body[0]), 'verify_binary(name, path)')
        runs = [n for n in ast.walk(self.tree) if isinstance(n, ast.Call) and ast.unparse(n.func) == 'subprocess.run'
                and ast.unparse(n.args[0].elts[0]) == 'str(path)']
        self.assertEqual(len(runs), 1)
        self.assertIn("env.update({'PATH': '/usr/bin:/bin', 'HOME': str(home), 'LANG': 'C.UTF-8', 'TMPDIR': str(home),", self.source)
        passthrough = ast.literal_eval(re.search(r'PASSTHROUGH = (\([^)]*\))', self.source).group(1))
        self.assertEqual(set(passthrough), {'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy',
                                            'SSL_CERT_FILE', 'SSL_CERT_DIR', 'GIT_SSL_CAINFO'})

    def test_fail_closed_rules_present(self):
        for marker in ("if scanned != expected:", "if not report.is_file():", "GITLEAKS_EXIT_1_WITHOUT_FINDINGS",
                       "GITLEAKS_EXIT_0_WITH_FINDINGS", "GITLEAKS_FINDINGS_OUTSIDE_SCANNED_HISTORY",
                       "'--ignore-gitleaks-allow'", "'--only-verified', '--no-ignore-tag'",
                       "TRUFFLEHOG_VERIFIED_MISMATCH", "if chunks <= 0 or nbytes <= 0 or chunks > nbytes:",
                       "'--merges', '--remerge-diff'", "REPO_GITLEAKS_CONFIG_REFUSED", "HISTORY_INCOMPLETE",
                       "raise IntegrityError(f'{name}: binary SHA-256 mismatch (substituted tool)')",
                       "'GIT_ATTR_SOURCE': EMPTY_TREE, 'GIT_ATTR_NOSYSTEM': '1', 'GIT_CONFIG_NOSYSTEM': '1'",
                       "EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'", "MIN_PATCH_RATIO = 0.9",
                       "PATCH_COMMITS_TOO_FEW", "if scanned != total:", "body.replace(b'\\0', b'')",
                       "if b'\\0' in body[:8000]:", "parts['gitleaks-binary-as-text'] = binary_blob_text_pass("):
            self.assertIn(marker, self.source)
        main = self.funcs['main']
        try_node = next(n for n in main.body if isinstance(n, ast.Try))
        self.assertEqual(ast.unparse(try_node.body[0]), 'attributes_selftest(env, work)',
                         'the attribute neutralisation self-test must run before anything else')
        self.assertIn("        if a.mode == 'full-history':\n            parts['trufflehog'] = trufflehog_pass(", self.source,
                      'TruffleHog (verification calls) must not run on PR content in pr-head mode')


class ProtectedWorkflowContract(unittest.TestCase):
    """PR content must stay data-only in the base-controlled workflow."""
    ALLOWED_PR_LINES = {
        'git init -q "$RUNNER_TEMP/pr-repo"',
        'git -C "$RUNNER_TEMP/pr-repo" fetch -q --no-tags "$REPO_URL" "+$HEAD_SHA:refs/heads/pr-head"',
        'test "$(git -C "$RUNNER_TEMP/pr-repo" rev-parse refs/heads/pr-head)" = "$HEAD_SHA"',
        'git -C "$RUNNER_TEMP/pr-repo" symbolic-ref HEAD refs/heads/pr-head',
        'git -C "$RUNNER_TEMP/pr-repo" read-tree refs/heads/pr-head',
        'mkdir "$GITHUB_WORKSPACE/pr"',
        'git --git-dir="$RUNNER_TEMP/pr-repo/.git" --work-tree="$GITHUB_WORKSPACE/pr" checkout-index -a',
        'SCAN_CONTRACT_ROOT="$GITHUB_WORKSPACE/pr" PYTHONPATH="$RUNNER_TEMP/pydeps" python3 -P -S -m unittest discover -v -s tests -p test_secret_history_scan_workflow.py 2>&1 | tee "$RUNNER_TEMP/contract.txt"',
        VERDICT_CMD,
    }

    def setUp(self):
        self.source, self.wf = load(PROTECTED_WF)
        self.job = self.wf['jobs']['protected-contract']

    def test_trigger_permissions(self):
        self.assertEqual(self.wf['on'], {'pull_request_target': ''})
        self.assertEqual(self.wf['permissions'], {'contents': 'read'})
        self.assertNotIn('secrets.', self.source)
        self.assertEqual(list(self.wf['jobs']), ['protected-contract'])
        for key in ('if', 'continue-on-error', 'env', 'permissions', 'needs', 'container', 'services', 'defaults'):
            self.assertNotIn(key, self.job)

    def test_only_base_checkout_and_no_local_actions(self):
        uses = [s['uses'] for s in self.job['steps'] if 'uses' in s]
        self.assertEqual(uses, [CHECKOUT])
        first = self.job['steps'][0]
        self.assertEqual(first['with'], {'ref': '${{ github.event.pull_request.base.sha }}', 'path': 'base',
                                         'persist-credentials': 'false'})
        self.assertNotRegex(self.source, r'uses:\s*\./|allow-unsafe-pr-checkout|working-directory')

    def test_pr_paths_only_in_data_lines(self):
        pr_ref = re.compile(r'GITHUB_WORKSPACE/pr\b|pr-repo|\bpr/|head\.(sha|ref)')
        for step in self.job['steps']:
            self.assertNotIn('if', step)
            self.assertNotIn('continue-on-error', step)
            for line in (step.get('run') or '').splitlines():
                line = line.strip()
                if pr_ref.search(line):
                    self.assertIn(line, self.ALLOWED_PR_LINES, f'PR content referenced outside the data-only allowlist: {line!r}')
                for word in re.findall(r'(?:^|[;&|]\s*)(?:\S+=\S+\s+)*([\w./$"{}-]+)', line):
                    self.assertFalse(pr_ref.search(word), f'executes PR content: {line!r}')
            if 'env' in step:
                self.assertTrue(set(step['env']) <= {'HEAD_SHA', 'REPO_URL', 'PYTHONDONTWRITEBYTECODE'}, step['env'])
        self.assertIn('[[ "$HEAD_SHA" =~ ^[0-9a-f]{40}$ ]]', self.source)
        self.assertIn('cd base', self.source)
        self.assertIn(VERDICT_CMD, self.source)

    def test_contract_workflow(self):
        source, wf = load(CONTRACT_WF)
        self.assertEqual(wf['on'], {'pull_request': ''})
        self.assertEqual(wf['permissions'], {'contents': 'read'})
        self.assertNotIn('if', wf['jobs']['contract'])


class TreeContract(unittest.TestCase):
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

    def test_gitattributes_cannot_mark_content_binary(self):
        # The driver neutralises attributes at runtime (GIT_ATTR_SOURCE = empty tree, self-test);
        # this is defence in depth: no committed attribute may hide diffs from scanners.
        bad = []
        for dirpath, dirnames, filenames in os.walk(ROOT, followlinks=False):
            dirnames[:] = [d for d in dirnames if d != '.git']
            if '.gitattributes' not in filenames:
                continue
            path = pathlib.Path(dirpath) / '.gitattributes'
            for line in read(path).splitlines():
                attrs = line.split('#', 1)[0].split()[1:]
                if any(a in ('-diff', '!diff', 'binary') or a.startswith(('diff=', 'filter=')) for a in attrs):
                    bad.append(f'{path.relative_to(ROOT).as_posix()}: {line.strip()}')
        self.assertEqual(bad, [])

    def test_no_python_startup_hooks_from_the_tree(self):
        # The base contract and driver run with -I/-P and -S, but keep the tree free of
        # files that would be imported implicitly anywhere (site hooks, tests package).
        found = []
        for dirpath, dirnames, filenames in os.walk(ROOT, followlinks=False):
            dirnames[:] = [d for d in dirnames if d != '.git']
            for name in filenames:
                rel = (pathlib.Path(dirpath) / name).relative_to(ROOT).as_posix()
                # Only the locations a base invocation could see (repo root, tests/); -S/-I/-P already
                # block them, this keeps a PR from planting them for other tooling.
                if rel in ('sitecustomize.py', 'usercustomize.py', 'tests/__init__.py', 'tests/sitecustomize.py',
                           'tests/usercustomize.py') or (name.endswith('.pth') and '/' not in rel):
                    found.append(rel)
        self.assertEqual(found, [])


class IgnoreFileContract(unittest.TestCase):
    def setUp(self):
        lines = [l.strip() for l in read(IGNORE).splitlines()]
        self.entries = [l for l in lines if l and not l.startswith('#')]

    def test_only_exact_fingerprints(self):
        self.assertEqual([l for l in self.entries if not FINGERPRINT.match(l)], [])
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
