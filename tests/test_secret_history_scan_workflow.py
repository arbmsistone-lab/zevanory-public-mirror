"""Contract for the public full-history secret scan (T5).

Fails if the scan reverts to unpinned scanners (:latest / no checksum), loses its
daily schedule or its push-to-gh-pages / every-PR triggers, widens permissions,
drops redaction or verified-only TruffleHog, or if .gitleaksignore gains anything
other than exact, documented fingerprints.

Offline: reads files from the checkout only. No network, no secrets.
"""
import pathlib
import re
import unittest

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / '.github' / 'workflows' / 'secret-history-scan.yml'
IGNORE = ROOT / '.gitleaksignore'
BASELINE = ROOT / 'docs' / 'security' / 'secret-scan-baseline.md'
FINGERPRINT = re.compile(r'^[0-9a-f]{40}:[^:\s]+:[a-z0-9-]+:[0-9]+$')
T5_MARKER = '# Reviewed 2026-10-27 (T5'


def load_workflow():
    source = WORKFLOW.read_text(encoding='utf-8')
    # BaseLoader keeps the "on" key as a string instead of YAML 1.1 boolean True.
    return source, yaml.load(source, Loader=yaml.BaseLoader)


class TriggerContract(unittest.TestCase):
    def setUp(self):
        self.source, self.wf = load_workflow()
        self.on = self.wf['on']

    def test_daily_schedule(self):
        crons = [entry.get('cron', '') for entry in self.on.get('schedule') or []]
        self.assertTrue(crons, 'schedule trigger missing')
        daily = [c for c in crons if re.fullmatch(r'\d{1,2} \d{1,2} \* \* \*', c.strip())]
        self.assertTrue(daily, f'no daily cron in {crons}')

    def test_push_to_gh_pages_without_path_filter(self):
        push = self.on.get('push')
        self.assertIsInstance(push, dict, 'push trigger missing')
        self.assertIn('gh-pages', push.get('branches') or [])
        for key in ('paths', 'paths-ignore', 'branches-ignore'):
            self.assertNotIn(key, push, f'push must not be narrowed by {key}')

    def test_every_pull_request(self):
        self.assertIn('pull_request', self.on)
        pr = self.on.get('pull_request') or {}
        if isinstance(pr, dict):
            for key in ('paths', 'paths-ignore'):
                self.assertNotIn(key, pr, f'pull_request must not be narrowed by {key}')

    def test_minimal_permissions(self):
        self.assertEqual(self.wf.get('permissions'), {'contents': 'read'})
        for job in self.wf['jobs'].values():
            self.assertNotIn('permissions', job, 'job-level permissions must not widen access')
        self.assertNotIn('secrets.', self.source, 'scan must not use repository secrets')
        self.assertNotRegex(self.source, r'pull_request_target|workflow_run')


class PinningContract(unittest.TestCase):
    def setUp(self):
        self.source, self.wf = load_workflow()
        self.env = self.wf.get('env') or {}

    def test_no_latest_or_floating_images(self):
        for pattern in (r':latest\b', r'releases/latest', r'[Dd]ocker run[^\n]*(gitleaks|trufflehog)'):
            hits = re.findall(r'^.*' + pattern + r'.*$', self.source, re.M)
            self.assertEqual(hits, [], f'floating scanner reference: {pattern}')

    def test_exact_versions_and_digests(self):
        for name in ('GITLEAKS', 'TRUFFLEHOG'):
            self.assertRegex(self.env.get(f'{name}_VERSION', ''), r'^\d+\.\d+\.\d+$')
            self.assertRegex(self.env.get(f'{name}_SHA256', ''), r'^[0-9a-f]{64}$')
            self.assertIn(f'${{{name}_SHA256}}', self.source)
        self.assertEqual(self.source.count('sha256sum -c -'), 2, 'both downloads must be checksum-verified')
        self.assertIn('releases/download/v${GITLEAKS_VERSION}/', self.source)
        self.assertIn('releases/download/v${TRUFFLEHOG_VERSION}/', self.source)

    def test_scanner_modes_preserved(self):
        self.assertRegex(self.source, r'gitleaks git --log-opts="--all" --redact ')
        self.assertIn('--gitleaks-ignore-path .gitleaksignore', self.source)
        self.assertRegex(self.source, r'trufflehog git [^\n]*--only-verified')
        self.assertNotIn('--no-verification', self.source)
        self.assertIn('fetch-depth: 0', self.source)
        self.assertIn('persist-credentials: false', self.source)

    def test_execution_errors_fail_closed(self):
        self.assertIn('GITLEAKS_EXECUTION_ERROR', self.source)
        self.assertIn('TRUFFLEHOG_EXECUTION_ERROR', self.source)


class IgnoreFileContract(unittest.TestCase):
    def setUp(self):
        self.lines = [l.strip() for l in IGNORE.read_text(encoding='utf-8').splitlines()]
        self.entries = [l for l in self.lines if l and not l.startswith('#')]

    def test_only_exact_fingerprints(self):
        bad = [l for l in self.entries if not FINGERPRINT.match(l)]
        self.assertEqual(bad, [], 'only commit:file:rule:line fingerprints are allowed')
        self.assertEqual(len(self.entries), len(set(self.entries)), 'duplicate fingerprints')

    def test_t5_fingerprints_documented(self):
        self.assertIn(T5_MARKER, '\n'.join(self.lines))
        start = next(i for i, l in enumerate(self.lines) if l.startswith(T5_MARKER))
        t5 = [l for l in self.lines[start:] if l and not l.startswith('#')]
        self.assertGreater(len(t5), 0)
        doc = BASELINE.read_text(encoding='utf-8')
        missing = [fp for fp in t5 if f'`{fp}`' not in doc]
        self.assertEqual(missing, [], 'every T5 fingerprint needs a classification row')


if __name__ == '__main__':
    unittest.main()
