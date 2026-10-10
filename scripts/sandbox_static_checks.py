#!/usr/bin/env python3
"""Offline guards. New workflows use the JSON subset of YAML for stdlib parsing.
Inherited workflows are inspected for effective triggers for this scoped change;
public unauthenticated GET audits remain allowed. Other financial workflow risks
are reported separately, not silently edited or certified safe.
"""
import ast
import fnmatch
import hashlib
import json
import pathlib
import re
import socket
import sys
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
MANUAL = '.github/workflows/mercadopago-combo-sandbox.yml'
STATIC = '.github/workflows/sandbox-static-checks.yml'
SCRIPT = 'scripts/mercadopago_combo_sandbox.py'
CHECKER = 'scripts/sandbox_static_checks.py'
TEST = 'tests/test_sandbox_guards.py'
SCOPE = (MANUAL, STATIC, SCRIPT, CHECKER, TEST)
ALLOWED_SECRETS = {'MERCADOPAGO_TEST_PUBLIC_KEY', 'MERCADOPAGO_TEST_ACCESS_TOKEN',
                   'SANDBOX_IDENTITY_MANIFEST', 'SANDBOX_INBOX_READ_TOKEN', 'CERTIFICATION_E2E_TOKEN'}
HOSTS = {'api.mercadopago.com', 'zevanory.api.br'}
REGISTERED_EXCEPTION = {
    'filename': 'zees16-control-reconciler.yml',
    'blob': '70466f7d797f6e2046ed53dabd77f6ca8ec15243',
    'justification': 'T7 não financeiro; execuções serializadas, readback de fidelidade exata e aceitação 16/16 permanece fail-closed; 2026-10-08: grava no KV só quando o estado semântico muda (orçamento de 1.000 escritas/dia do Workers Free); 2026-10-10: concurrency por head_sha com cancel-in-progress, filtro gh-pages e nome real do quorum (open-provider); gatilhos preservados (Ordem 38); 2026-10-10: concurrency no nível do job, sem cancelamento (Ordem 48)',
}


def check(ok, name):
    if not ok:
        raise AssertionError(name)


def guarded_workflow(text, manual):
    # JSON is valid YAML; reject aliases/tags and alternate representations.
    d = json.loads(text)
    events = d.get('on', {})
    check(isinstance(events, dict), 'EVENT_MAPPING')
    check(set(events) == ({'workflow_dispatch'} if manual else {'pull_request', 'push'}), 'TRIGGERS')
    check(d.get('permissions') == {'contents': 'read'}, 'MINIMUM_PERMISSIONS')
    check(not re.search(r'\bsecrets\s*\.', text, re.I) or manual, 'STATIC_NO_SECRETS')
    secret_refs = set(re.findall(r'\bsecrets\.([A-Za-z0-9_]+)', text))
    check(secret_refs <= ALLOWED_SECRETS, 'NO_PRODUCTION_SECRETS')
    check(not any(x in text for x in ['RESUME_ORDER_ID', '0e59ea91', 'MERCADOPAGO_TEST_WEBHOOK_SECRET']), 'NO_RESUME_OR_RECEIVER_SECRET')
    jobs = d['jobs']
    check(set(jobs) == ({'purchase'} if manual else {'checks'}), 'JOB_SEPARATION')
    job = next(iter(jobs.values()))
    check(job.get('timeout-minutes', 0) > 0, 'TIMEOUT')
    if manual:
        check(job.get('environment') == {'name': 'sandbox-financial-approved'}, 'ENVIRONMENT_REQUIRED')
        required = ["github.event_name == 'workflow_dispatch'", "github.ref == 'refs/heads/gh-pages'",
                    'github.run_attempt == 1', "vars.SANDBOX_FINANCIAL_ENABLED == 'true'"]
        check(job.get('if') == ' && '.join(required), 'DISABLED_MANUAL_GATE')
        inputs = events['workflow_dispatch']['inputs']
        check(set(inputs) <= {'expected_sha', 'offer_id'} and 'expected_sha' in inputs and inputs['expected_sha'].get('required') is True and
              'default' not in inputs['expected_sha'], 'NO_SHA_DEFAULT')
        offer = inputs.get('offer_id')
        # Optional SKU selector: a closed choice of the canonical catalog only.
        check(offer is None or (offer.get('type') == 'choice' and offer.get('required') is True and
              offer.get('options') == ['ALL', 'ZEV-IA-011', 'ZEV-VEN-011', 'ZEV-LCX-011', 'ZEV-CMB-011', 'ZEV-NGC-011'] and
              offer.get('default') == 'ZEV-CMB-011'), 'OFFER_CHOICE_CLOSED')
    else:
        check(all(events[e] == {'branches': ['gh-pages']} for e in events), 'STATIC_BRANCHES')
    steps = job['steps']
    for step in steps:
        if 'uses' in step:
            check(re.fullmatch(r'actions/(checkout|upload-artifact)@[0-9a-f]{40}', step['uses']), 'PINNED_ACTIONS')
            if step['uses'].startswith('actions/checkout@'):
                check(step.get('with', {}).get('persist-credentials') is False, 'NO_PERSISTED_CREDENTIALS')
    check(any(s.get('uses', '').startswith('actions/checkout@') for s in steps), 'CHECKOUT_REQUIRED')
    if manual:
        uploads = [s for s in steps if s.get('uses', '').startswith('actions/upload-artifact@')]
        check(len(uploads) == 1 and uploads[0].get('if') == 'always()' and
              uploads[0]['with'].get('path') == 'evidence/mercadopago-combo-sandbox.json' and
              'env' not in uploads[0], 'SANITIZED_ARTIFACT')
        env_steps = [s for s in steps if s.get('run') == 'python3 ' + SCRIPT]
        check(len(env_steps) == 1 and set(re.findall(r'secrets\.([A-Za-z0-9_]+)', json.dumps(env_steps[0]))) == ALLOWED_SECRETS,
              'MANUAL_SECRET_SCOPE')
    else:
        runs = [s.get('run') for s in steps if 'run' in s]
        check(runs == ['python3 ' + CHECKER] and not any('env' in s for s in steps), 'OFFLINE_ONLY')
    return d


def script_guards(text):
    tree = ast.parse(text)
    check(not any(x in text for x in ['/users/test', 'RESUME_ORDER_ID', 'creator', '0e59ea91']), 'NO_IDENTITY_CREATION_OR_RESUME')
    check(not any(isinstance(n, ast.Constant) and isinstance(n.value, str) and
                  re.match(r'https?://', n.value) and
                  __import__('urllib.parse', fromlist=['urlsplit']).urlsplit(n.value).hostname not in HOSTS
                  for n in ast.walk(tree)),
          'NO_UNKNOWN_HOST')
    check('NoRedirect' in text and 'validate_request(url, method, headers, self.identity)' in text, 'CENTRAL_TRANSPORT_GUARD')
    check('excluded_from_revenue' in text and 'real_customer_delivery' in text and 'created_new' in text, 'ORDER_ISOLATION')
    check('signature_verified_by' in text and 'receiver' in text, 'RECEIVER_SIGNATURE_EVIDENCE')
    # Import must have no executing financial call; only the guarded entrypoint.
    for n in tree.body:
        if isinstance(n, ast.Expr):
            check(not isinstance(n.value, ast.Call), 'NO_IMPORT_SIDE_EFFECTS')
    return tree


def event_block(text, event):
    match = re.search(r'^  ' + re.escape(event) + r':([^\n]*)\n((?:[ \t]+[^\n]*\n|\n)*)', text, re.M)
    if not match:
        return None
    # Stop when indentation returns to the event level.
    lines = []
    for line in match.group(2).splitlines():
        if line.strip() and len(line) - len(line.lstrip()) <= 2:
            break
        lines.append(line)
    return match.group(1) + '\n' + '\n'.join(lines)


def applies_to_scope(text):
    block = event_block(text, 'pull_request')
    if block is None:
        return False
    match = re.search(r'\bpaths:\s*\[([^\]]+)\]', block)
    if match:
        pats = [p.strip().strip('\"\'') for p in match.group(1).split(',')]
        return any(fnmatch.fnmatch(path, pat) for path in SCOPE for pat in pats)
    match = re.search(r'^\s+paths:\s*\n((?:\s+-[^\n]+\n?)+)', block, re.M)
    if match:
        pats = [p.strip().lstrip('-').strip().strip('\"\'') for p in match.group(1).splitlines()]
        return any(fnmatch.fnmatch(path, pat) for path in SCOPE for pat in pats)
    # Unknown filter formats fail conservative (do not assume excluded).
    return True


def automatic_workflow_guard(text):
    # This guard covers jobs potentially reachable on this PR update. A job
    # restricted to a different exact branch is not reachable on this branch.
    conditions = re.findall(r"if:\s*github\.event\.pull_request\.head\.ref == '([^']+)'", text)
    if conditions and all(c != 'fix/mp-official-api-test-payer-20261005' for c in conditions):
        return
    references = re.findall(r'\bsecrets\.([A-Za-z0-9_]+)|\bsecrets\[[\"\']([^\"\']+)[\"\']\]', text)
    financial = r'MERCADOPAGO|MERCADO_PAGO|STRIPE|ASAAS|^MP_|PAYMENT.*WEBHOOK|WEBHOOK.*PAYMENT|WEBHOOK_SECRET'
    check(not any(re.search(financial, a or b, re.I) for a, b in references), 'AUTOMATIC_NO_FINANCIAL_SECRETS')
    check(not re.search(r'\bsecrets\[(?![\"\'])', text), 'AUTOMATIC_NO_DYNAMIC_SECRET')
    # Reject provider request targets, not inert catalog/forbidden-URL fixtures.
    check(not re.search(r'https?://(?:api\.mercadopago\.com|api\.stripe\.com|(?:api|sandbox)\.asaas\.com)|(?:curl|wget|urlopen|Request|fetch|requests\.(?:get|post))[^\n]*https?://(?:checkout\.stripe\.com|www\.mercadopago\.com)', text, re.I), 'AUTOMATIC_NO_PAYMENT_PROVIDER')
    check(not re.search(r'(?:scripts|tests)/[^\s\"\']*(?:mercadopago|financial|payment|stripe|asaas)[^\s\"\']*\.(?:py|mjs|js|sh)', text, re.I), 'AUTOMATIC_NO_FINANCIAL_SCRIPT')


def order_sql_reused_params_typed(root=ROOT):
    violations = []
    query_re = re.compile(r'(?:sql|db)\.query\(\s*`([\s\S]*?)`', re.I)
    for path in sorted((root / 'worker').rglob('*.mjs')):
        text = path.read_text('utf-8')
        for match in query_re.finditer(text):
            sql = match.group(1)
            if not re.search(r'\b(?:INSERT\s+INTO|UPDATE|FROM)\s+orders\b', sql, re.I):
                continue
            nums = re.findall(r'[$]([0-9]+)', sql)
            for number in sorted(set(nums)):
                if nums.count(number) < 2:
                    continue
                occurrences = list(re.finditer('[$]' + re.escape(number) + r'(?![0-9])', sql))
                untyped = [m for m in occurrences if not re.match(r'::[A-Za-z_][A-Za-z0-9_]*(?:\[\])?', sql[m.end():])]
                if untyped:
                    line = text[:match.start()].count('\n') + 1
                    violations.append(f'{path.relative_to(root)}:{line}:reused_${number}_without_cast')
    check(not violations, 'ORDER_SQL_REUSED_PARAM_UNTYPED:' + ','.join(violations[:20]))
    return 'PASS'

def validate_registered_exception(workflows):
    filename = REGISTERED_EXCEPTION['filename']
    if filename in workflows:
        data = workflows[filename].encode()
        actual = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
        check(actual == REGISTERED_EXCEPTION['blob'], 'ZEES_EXCEPTION_BLOB_CHANGED')
        automatic_workflow_guard(workflows[filename])


def downstream_guards(workflows, initial_names):
    validate_registered_exception(workflows)
    reachable = set(initial_names)
    reviewed = set()
    while True:
        added = False
        for filename, text in workflows.items():
            if filename in reviewed:
                continue
            block = event_block(text, 'workflow_run')
            if not block:
                continue
            watched = set(re.findall(r'^\s+-\s*[\"\']?([^\n\"\']+)[\"\']?\s*$', block, re.M))
            inline = re.search(r'workflows:\s*\[([^\]]+)\]', block)
            if inline:
                watched.update(x.strip().strip('\"\'') for x in inline.group(1).split(','))
            if not watched.intersection(reachable):
                continue
            reviewed.add(filename)
            try:
                automatic_workflow_guard(text)
            except AssertionError as error:
                raise AssertionError('DOWNSTREAM:' + filename + ':' + str(error)) from None
            name = re.search(r'^name:\s*(.+)$', text, re.M)
            if name:
                reachable.add(name.group(1).strip().strip('\"\''))
            added = True
        if not added:
            return reviewed


def guard_results(root=ROOT):
    rows = {}
    for name, operation in [
        ('MANUAL_WORKFLOW', lambda: guarded_workflow((root / MANUAL).read_text(), True)),
        ('STATIC_WORKFLOW', lambda: guarded_workflow((root / STATIC).read_text(), False)),
        ('SCRIPT_ENDPOINT_IDENTITY_ISOLATION', lambda: script_guards((root / SCRIPT).read_text())),
        ('ORDER_SQL_REUSED_PARAMS_TYPED', lambda: order_sql_reused_params_typed(root)),
    ]:
        operation()
        rows[name] = 'PASS'
    workflows = {}
    initial_names = {'Sandbox static checks'}
    for path in sorted((root / '.github/workflows').glob('*.yml')):
        if path.name in {pathlib.Path(MANUAL).name, pathlib.Path(STATIC).name}:
            continue
        text = path.read_text()
        workflows[path.name] = text
        if applies_to_scope(text):
            automatic_workflow_guard(text)
            rows['AUTOMATIC:' + path.name] = 'PASS'
            name = re.search(r'^name:\s*(.+)$', text, re.M)
            if name:
                initial_names.add(name.group(1).strip().strip('\"\''))
    validate_registered_exception(workflows)
    rows['ZEES_REGISTERED_EXCEPTION_BLOB'] = 'PASS'
    try:
        downstream_guards(workflows, initial_names)
        rows['DOWNSTREAM_AUTOMATION'] = 'PASS'
    except AssertionError as error:
        rows['DOWNSTREAM_AUTOMATION'] = 'FAIL:' + str(error)
    return rows


def main():
    try:
        rows = guard_results()
        for path in (SCRIPT, CHECKER, TEST):
            text = (ROOT / path).read_text()
            compile(text, path, 'exec')
            check(not re.search(r'[ \t]+$', text, re.M), 'TRAILING_WHITESPACE')
        sys.path.insert(0, str(ROOT / 'scripts'))
        suite = unittest.defaultTestLoader.discover(str(ROOT / 'tests'), pattern='test_sandbox_guards.py')
        # Includes a negative transport test: any unmocked network attempt fails.
        with patch.object(socket.socket, 'connect', side_effect=AssertionError('NETWORK_FORBIDDEN')), \
             patch.object(socket, 'create_connection', side_effect=AssertionError('NETWORK_FORBIDDEN')):
            result = unittest.TextTestRunner(verbosity=2).run(suite)
        check(result.wasSuccessful() and result.testsRun >= 20, 'MOCK_GUARDS_FAILED')
        print(json.dumps({'guards': rows, 'syntax': 'PASS', 'mock_tests': result.testsRun, 'network': 'BLOCKED',
            'registered_exception': REGISTERED_EXCEPTION,
            'separate_risks': ['financial-e2e-closure production-token fallback unchanged',
                               'certification token used as operator substitute in other workflows; unchanged']}))
        check(all(value == 'PASS' for value in rows.values()), 'DOWNSTREAM_AUTOMATION_UNSAFE')
        return 0
    except Exception as error:
        print('::error title=SANDBOX_STATIC::' + str(error))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
