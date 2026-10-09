"""Adversarial guard tests: fake HTTP transport only, never financial execution."""
import base64
import copy
import io
import json
import pathlib
import sys
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import mercadopago_combo_sandbox as proof
import sandbox_static_checks as guards

NEW_ORDER = '11111111-2222-4333-8444-555555555555'
NOW = 1800000000
DOWNLOAD = proof.APP + proof.CERT_PATH + 'download?token=temporary-download-value'


def environment():
    env = {'SANDBOX_FINANCIAL_ENABLED': 'true', 'GITHUB_EVENT_NAME': 'workflow_dispatch',
           'GITHUB_REF': 'refs/heads/gh-pages', 'GITHUB_RUN_ATTEMPT': '1',
           'EXPECTED_SHA': 'a' * 40, 'GITHUB_SHA': 'a' * 40,
           'MERCADOPAGO_TEST_PUBLIC_KEY': 'test-public-key-unique-value',
           'MERCADOPAGO_TEST_ACCESS_TOKEN': 'sandbox-access-unique-value',
           'SANDBOX_INBOX_READ_TOKEN': 'mailbox-read-unique-value',
           'CERTIFICATION_E2E_TOKEN': 'certification-only-unique-value'}
    m = {'schema': 'sandbox.identity.v1', 'verified': True, 'credential_mode': 'sandbox',
         'verification_evidence_id': 'protected-verification-1', 'application_id': '123', 'seller_id': '10',
         'buyer': {'id': '20', 'email': 'verified-buyer@testuser.com', 'sandbox': True, 'verified': True},
         'inbox': {'email': 'prova-sandbox@zevanory.api.br', 'provider': 'resend-inbound', 'read_only': True,
                   'verified': True, 'scopes': [proof.READ_SCOPE]}}
    for field, name in [('public_key_sha256', 'MERCADOPAGO_TEST_PUBLIC_KEY'),
                        ('access_token_sha256', 'MERCADOPAGO_TEST_ACCESS_TOKEN'),
                        ('inbox_token_sha256', 'SANDBOX_INBOX_READ_TOKEN')]:
        m[field] = proof.digest(env[name])
    env['SANDBOX_IDENTITY_MANIFEST'] = json.dumps(m)
    return env


def change_manifest(env, fn):
    m = json.loads(env['SANDBOX_IDENTITY_MANIFEST'])
    fn(m)
    env['SANDBOX_IDENTITY_MANIFEST'] = json.dumps(m)


class Response(io.BytesIO):
    status = 200


class FakeProvider:
    def __init__(self):
        self.calls = []
        self.checkout_changes = {}
        self.card_changes = {}
        self.signature = True
        self.recipient = 'prova-sandbox@zevanory.api.br'
        self.buyer = 'verified-buyer@testuser.com'
        self.contract = True
        self.error = None
        self.http_errors = {}
        self.download_calls = 0
        self.requires_reconcile = False
        self.reconciled = False
        self.refunded = False
        self.offer = 'ZEV-CMB-011'
        self.persisted = {}
        self.payment_amounts = []
        self.served = None

    def artifact_bytes(self):
        return ('private sandbox artifact ' + str(self.offer)).encode()

    def __call__(self, req, timeout):
        self.calls.append(req)
        if self.error:
            raise self.error
        url = proof.urllib.parse.urlsplit(req.full_url)
        path = url.path
        if path in self.http_errors:
            raise proof.urllib.error.HTTPError(req.full_url, self.http_errors[path], 'provider', {}, io.BytesIO(b''))
        isolation = {'sale_globally_enabled': False, 'sales_mode': 'globally-blocked', 'sandbox': True,
            'excluded_from_revenue': True, 'real_customer_delivery': False, 'commercial_unlock': False,
            'buyer_id': '20', 'buyer_email': self.buyer, 'email_recipient': self.recipient, 'order_id': NEW_ORDER}
        if path == proof.CERT_PATH + 'status' and not url.query:
            data = {'sale_globally_enabled': False, 'sales_mode': 'globally-blocked',
                    'sandbox_proof_contract': 'v2' if self.contract else 'v1',
                    'sandbox_checkout_isolated': True, 'receiver_test_signature_evidence': True,
                    'certification_download_isolated': True}
        elif path == '/users/me':
            data = {'id': 10, 'tags': ['test_user']}
        elif path == '/users/20':
            data = {'id': 20, 'nickname': 'TESTUSER827000000'}
        elif path == proof.INBOX_PATH + 'profile':
            data = {'email_address': self.recipient, 'read_only': True}
        elif path == proof.CERT_PATH + 'checkout':
            self.offer = json.loads(req.data or b'{}').get('offer_id')
            data = {**isolation, 'accepted': True, 'created_new': True, 'offer_id': self.offer,
                    'amount_brl': proof.SANDBOX_OFFERS.get(self.offer), **self.checkout_changes}
        elif path == '/v1/card_tokens':
            data = {'id': 'mock-card-token', 'status': 'active', 'live_mode': True, 'public_key': 'test-public-key-unique-value', **self.card_changes}
        elif path == '/v1/payments':
            data = {'id': 77, 'live_mode': True, 'collector_id': 10, 'status': 'approved', 'external_reference': NEW_ORDER}
        elif path == '/v1/payments/77':
            data = {'id': 77, 'live_mode': True, 'collector_id': 10, 'status': 'approved',
                    'external_reference': NEW_ORDER,
                    'notification_url': proof.APP + '/api/webhooks?provider=mercadopago_test'}
        elif path == proof.CERT_PATH + 'reconcile':
            payload = json.loads(req.data.decode()) if req.data else {}
            self.assert_reconcile_payload = payload
            self.reconciled = True
            data = {'accepted': True, 'order_id': NEW_ORDER, 'payment_id': '77',
                    'receipt_source': 'reconciliation'}
        elif path == proof.CERT_PATH + 'status':
            if self.requires_reconcile and not self.reconciled:
                data = {**isolation, 'receipt_source': None, 'order': {'status': 'checkout_ready'},
                        'fulfillment': {'status': ''}, 'financial_events': [],
                        'delivery_evidence': {}}
                return Response(json.dumps(data).encode())
            data = {**isolation, 'receipt_source': 'reconciliation' if self.reconciled else 'webhook',
                'order': {'status': 'refunded' if self.refunded else 'paid', 'offer_id': self.offer,
                          'amount_brl': proof.SANDBOX_OFFERS.get(self.offer), 'currency': 'BRL',
                          'certification_pilot': True, **self.persisted}, 'fulfillment': {'status': 'delivered'},
                'financial_events': [{'normalized_event': 'payment_confirmed', 'provider_payment_id': 77,
                    'order_id': NEW_ORDER, 'source_class': 'provider_webhook', 'signature_verified': self.signature,
                    'signature_secret_class': 'sandbox', 'signature_verified_by': 'receiver'}],
                'delivery_evidence': {'email_status': 'sent', 'email_recipient': self.recipient,
                    'verification_url': DOWNLOAD, 'expires_at': '2027-01-15T09:00:00+00:00',
                    'artifact_sha256': proof.digest_bytes(self.artifact_bytes())}}
            # Set expiration from the mock clock, not a fixed calendar assumption.
            data['delivery_evidence']['expires_at'] = proof.dt.datetime.fromtimestamp(NOW + 120,
                proof.dt.timezone.utc).isoformat()
        elif path == '/api/support/refund-request':
            payload = json.loads(req.data.decode()) if req.data else {}
            assert payload == {'order_id': NEW_ORDER, 'email': self.recipient}, payload
            data = {'received': True, 'status': 'pending'}
        elif path == proof.CERT_PATH + 'post-sale':
            payload = json.loads(req.data.decode()) if req.data else {}
            assert payload == {'order_id': NEW_ORDER, 'step': 'd1'}, payload
            data = {'ok': True, 'step': 'd1', 'sent': True}
        elif path == proof.CERT_PATH + 'refund-approve':
            self.refunded = True
            data = {'ok': True, 'status': 'approved', 'refund_id': 'mock-refund-1', 'order_status': 'refunded'}
        elif path == proof.INBOX_PATH + 'messages':
            data = {'messages': [{'id': 'mockmessage1', 'to': [self.recipient], 'received_at_ms': NOW * 1000 + 1,
                'x_zevanory_order_id': NEW_ORDER, 'delivered_via': 'resend-inbound', 'text': DOWNLOAD}]}
        elif path == proof.CERT_PATH + 'download':
            self.download_calls += 1
            if self.download_calls > 1:
                raise proof.urllib.error.HTTPError(req.full_url, 410, 'gone', {}, io.BytesIO(b''))
            return Response(self.served if self.served is not None else self.artifact_bytes())
        else:
            raise AssertionError('Unexpected mock endpoint')
        return Response(json.dumps(data).encode())


class GuardTests(unittest.TestCase):
    def setUp(self):
        self._catalog = dict(proof.CATALOG_ARTIFACTS)
        for sku in proof.CATALOG_ARTIFACTS:
            proof.CATALOG_ARTIFACTS[sku] = proof.digest_bytes(('private sandbox artifact ' + sku).encode())
        self.addCleanup(lambda saved=self._catalog: proof.CATALOG_ARTIFACTS.update(saved))
        self.env = environment()
        self.identity = proof.preflight(self.env)
        self.fake = FakeProvider()

    def denied_preflight(self, code):
        with self.assertRaisesRegex(proof.GuardError, code):
            proof.preflight(self.env)

    def run_fake(self):
        return proof.run(self.env, self.fake, now=lambda: NOW,
            sleep=lambda _: (_ for _ in ()).throw(proof.GuardError('RECEIPT_WEBHOOK_TIMEOUT')))

    def test_delivered_file_of_another_product_fails(self):
        self.env['SANDBOX_OFFER_ID'] = 'ZEV-NGC-011'
        original = proof.CATALOG_ARTIFACTS['ZEV-NGC-011']
        try:
            proof.CATALOG_ARTIFACTS['ZEV-NGC-011'] = proof.digest_bytes(b'private sandbox artifact ZEV-IA-011')
            report = self.run_fake()
        finally:
            proof.CATALOG_ARTIFACTS['ZEV-NGC-011'] = original
        self.assertEqual(report['cause'], 'DOWNLOAD_PRODUCT_MISMATCH')

    def test_each_catalog_sku_runs_at_its_table_price(self):
        for sku, price in proof.SANDBOX_OFFERS.items():
            self.setUp()
            self.env['SANDBOX_OFFER_ID'] = sku
            report = self.run_fake()
            self.assertEqual(report['status'], 'PASS', (sku, report))
            self.assertEqual((report['offer_id'], report['amount_brl']), (sku, price))
            self.assertEqual(report['checks'].get('CANONICAL_ORDER'), 'PASS')
            pays = [json.loads(r.data) for r in self.fake.calls
                    if proof.urllib.parse.urlsplit(r.full_url).path == '/v1/payments' and r.method == 'POST']
            self.assertEqual([p['transaction_amount'] for p in pays], [price])

    def test_unknown_sku_fails_before_any_network_call(self):
        self.env['SANDBOX_OFFER_ID'] = 'ZEV-XYZ-999'
        report = self.run_fake()
        self.assertEqual(report['cause'], 'SANDBOX_OFFER_NOT_IN_CATALOG')
        self.assertEqual(self.fake.calls, [])

    def test_checkout_amount_divergence_stops_before_payment(self):
        self.env['SANDBOX_OFFER_ID'] = 'ZEV-NGC-011'
        self.fake.checkout_changes = {'amount_brl': 347}
        report = self.run_fake()
        self.assertEqual(report['cause'], 'CATALOG_AMOUNT_REQUIRED')
        self.assertFalse(any('/v1/payments' in r.full_url for r in self.fake.calls))

    def test_persisted_order_mismatch_fails(self):
        for change in ({'amount_brl': 147}, {'offer_id': 'ZEV-IA-011'}, {'certification_pilot': False}, {'currency': 'USD'}):
            self.setUp()
            self.fake.persisted = change
            report = self.run_fake()
            self.assertEqual(report['cause'], 'PERSISTED_ORDER_CATALOG_MISMATCH', change)

    def test_full_mock_proof_and_sanitized_evidence(self):
        report = self.run_fake()
        self.assertEqual(report['status'], 'PASS', report)
        saved = json.dumps(report)
        for name in proof.SECRET_NAMES:
            self.assertNotIn(self.env[name], saved)
        self.assertNotIn('temporary-download-value', saved)
        self.assertNotIn('sha256', saved)
        self.assertNotIn(proof.FROZEN_ORDER, saved)
        self.assertTrue(all(proof.FROZEN_ORDER not in r.full_url for r in self.fake.calls))
        self.assertTrue(all(r.method == 'GET' for r in self.fake.calls if proof.INBOX_PATH in r.full_url))

    def test_reconciles_after_90_seconds_when_provider_is_still_approved(self):
        self.fake.requires_reconcile = True
        clock = [NOW]

        def sleep(seconds):
            clock[0] += seconds

        report = proof.run(self.env, self.fake, now=lambda: clock[0], sleep=sleep)
        self.assertEqual(report['status'], 'PASS', report)
        self.assertEqual(report.get('receipt_source'), 'reconciliation')
        self.assertEqual(self.fake.assert_reconcile_payload,
                         {'order_id': NEW_ORDER, 'payment_id': '77'})
        reconcile_calls = [r for r in self.fake.calls
                           if proof.urllib.parse.urlsplit(r.full_url).path == proof.CERT_PATH + 'reconcile']
        self.assertEqual(len(reconcile_calls), 1)

    def test_disabled_default(self):
        self.env.pop('SANDBOX_FINANCIAL_ENABLED')
        self.denied_preflight('FINANCIAL_DISABLED')

    def test_pull_request_refused(self):
        self.env['GITHUB_EVENT_NAME'] = 'pull_request'
        self.denied_preflight('MANUAL_FIRST_ATTEMPT_ONLY')

    def test_rerun_refused(self):
        self.env['GITHUB_RUN_ATTEMPT'] = '2'
        self.denied_preflight('MANUAL_FIRST_ATTEMPT_ONLY')

    def test_other_branch_refused(self):
        self.env['GITHUB_REF'] = 'refs/heads/other'
        self.denied_preflight('MANUAL_FIRST_ATTEMPT_ONLY')

    def test_no_sha_default(self):
        self.env.pop('EXPECTED_SHA')
        self.denied_preflight('APPROVED_SOURCE_SHA_REQUIRED')

    def test_sha_mismatch(self):
        self.env['EXPECTED_SHA'] = 'b' * 40
        self.denied_preflight('APPROVED_SOURCE_SHA_REQUIRED')

    def test_production_env_refused(self):
        self.env['MERCADOPAGO_ACCESS_TOKEN'] = 'production-credential'
        self.denied_preflight('PRODUCTION_CREDENTIAL_PRESENT')

    def test_live_secret_refused(self):
        self.env['OTHER_LIVE_SECRET'] = 'production-credential'
        self.denied_preflight('PRODUCTION_CREDENTIAL_PRESENT')

    def test_mixed_pair_refused_before_network(self):
        self.env['MERCADOPAGO_TEST_PUBLIC_KEY'] = 'different-key'
        report = self.run_fake()
        self.assertEqual(report['cause'], 'CREDENTIAL_ATTESTATION_MISMATCH')
        self.assertEqual(self.fake.calls, [])

    def test_unverified_pair_refused(self):
        change_manifest(self.env, lambda m: m.update(verified=False))
        self.denied_preflight('PAIR_ATTESTATION_REQUIRED')

    def test_production_pair_refused(self):
        change_manifest(self.env, lambda m: m.update(credential_mode='production'))
        self.denied_preflight('PAIR_ATTESTATION_REQUIRED')

    def test_fallback_buyer_refused(self):
        change_manifest(self.env, lambda m: m['buyer'].update(email='test@testuser.com'))
        self.denied_preflight('VERIFIED_BUYER_REQUIRED')

    def test_missing_buyer_id_refused(self):
        change_manifest(self.env, lambda m: m['buyer'].pop('id'))
        self.denied_preflight('VERIFIED_BUYER_REQUIRED')

    def test_buyer_same_as_seller_refused(self):
        change_manifest(self.env, lambda m: m['buyer'].update(id='10'))
        self.denied_preflight('VERIFIED_BUYER_REQUIRED')

    def test_inbox_write_scope_refused(self):
        change_manifest(self.env, lambda m: m['inbox'].update(scopes=['zevanory.sandbox_inbox.write']))
        self.denied_preflight('READ_ONLY_CONTROLLED_INBOX_REQUIRED')

    def test_sink_refused(self):
        change_manifest(self.env, lambda m: m['inbox'].update(email='delivered@resend.dev'))
        self.denied_preflight('READ_ONLY_CONTROLLED_INBOX_REQUIRED')

    def test_creation_endpoint_refused(self):
        with self.assertRaises(proof.GuardError):
            proof.Client(self.identity, self.fake).mp('/users/test', 'POST', {})
        self.assertEqual(self.fake.calls, [])

    def test_unknown_host_refused(self):
        with self.assertRaises(proof.GuardError):
            proof.Client(self.identity, self.fake).request('https://evil.example/v1/payments')
        self.assertEqual(self.fake.calls, [])

    def test_noncert_app_route_refused(self):
        with self.assertRaises(proof.GuardError):
            proof.Client(self.identity, self.fake).cert('../release')
        self.assertEqual(self.fake.calls, [])

    def test_cert_token_cannot_escape(self):
        with self.assertRaises(proof.GuardError):
            proof.Client(self.identity, self.fake).mp('/users/me', headers={'x-certification-e2e-token': self.identity.certification_token})
        self.assertEqual(self.fake.calls, [])

    def test_no_creator_token(self):
        with self.assertRaises(proof.GuardError):
            proof.Client(self.identity, self.fake).mp('/users/me', headers={'authorization': 'Bearer unrelated-token'})
        self.assertEqual(self.fake.calls, [])

    def test_frozen_order_never_read(self):
        with self.assertRaises(proof.GuardError):
            proof.Client(self.identity, self.fake).cert('status?order_id=' + proof.FROZEN_ORDER)
        self.assertEqual(self.fake.calls, [])

    def test_frozen_order_response_stops_before_status_or_card(self):
        self.fake.checkout_changes['order_id'] = proof.FROZEN_ORDER
        report = self.run_fake()
        self.assertEqual(report['cause'], 'NEW_OR_REUSED_SANDBOX_ORDER_REQUIRED')
        self.assertFalse(any('/v1/card_tokens' in r.full_url for r in self.fake.calls))

    def test_missing_isolation_stops_before_card(self):
        self.fake.checkout_changes['excluded_from_revenue'] = False
        self.assertEqual(self.run_fake()['cause'], 'SANDBOX_ISOLATION_REQUIRED')
        self.assertFalse(any('/v1/card_tokens' in r.full_url for r in self.fake.calls))

    def test_recipient_divergence_stops(self):
        self.fake.checkout_changes['email_recipient'] = 'other@example.com'
        self.assertEqual(self.run_fake()['cause'], 'IDENTITY_DIVERGENCE')

    def test_missing_contract_stops_before_provider(self):
        self.fake.contract = False
        self.assertEqual(self.run_fake()['cause'], 'RECEIVER_CONTRACT_V2_REQUIRED')
        self.assertTrue(all(r.host != 'api.mercadopago.com' for r in self.fake.calls))

    def test_card_app_mismatch_no_payment(self):
        self.fake.card_changes['public_key'] = 'other-application-key'
        self.assertEqual(self.run_fake()['cause'], 'SANDBOX_CARD_TOKEN_REQUIRED')
        self.assertFalse(any('/v1/payments' in r.full_url for r in self.fake.calls))

    def test_app_http_detail_is_not_labeled_provider(self):
        original = self.fake.__call__
        def call(req, timeout):
            if proof.urllib.parse.urlsplit(req.full_url).path == proof.CERT_PATH + 'checkout':
                body = io.BytesIO(json.dumps({'error': 'sandbox_daily_limit'}).encode())
                raise proof.urllib.error.HTTPError(req.full_url, 429, 'local', {}, body)
            return original(req, timeout)
        report = proof.run(self.env, call, now=lambda: NOW)
        self.assertEqual(report['cause'], 'checkout_canonical_http_429_detail_sandbox_daily_limit')

    def test_provider_http_detail_keeps_provider_label(self):
        original = self.fake.__call__
        def call(req, timeout):
            if proof.urllib.parse.urlsplit(req.full_url).path == '/v1/payments':
                body = io.BytesIO(json.dumps({'error': 'provider_limit'}).encode())
                raise proof.urllib.error.HTTPError(req.full_url, 429, 'provider', {}, body)
            return original(req, timeout)
        report = proof.run(self.env, call, now=lambda: NOW)
        self.assertEqual(report['cause'], 'checkout_payment_http_429_provider_provider_limit')
    def test_card_token_500_has_stable_route_code(self):
        self.fake.http_errors['/v1/card_tokens'] = 500
        report = self.run_fake()
        self.assertEqual(report['cause'], 'checkout_card_token_http_500')
        self.assertEqual(report['checks']['ISOLATED_CHECKOUT'], 'PASS')
        self.assertNotIn('PAYMENT', report['checks'])

    def test_payment_500_has_stable_route_code(self):
        self.fake.http_errors['/v1/payments'] = 500
        report = self.run_fake()
        self.assertEqual(report['cause'], 'checkout_payment_http_500')
        self.assertEqual(report['checks']['ISOLATED_CHECKOUT'], 'PASS')
        self.assertNotIn('PAYMENT', report['checks'])

    def test_transient_order_status_request_failure_is_retried(self):
        original = self.fake.__call__
        attempts = [0]
        def call(req, timeout):
            url = proof.urllib.parse.urlsplit(req.full_url)
            if url.path == proof.CERT_PATH + 'status' and url.query:
                attempts[0] += 1
                if attempts[0] == 1:
                    raise TimeoutError('transient status timeout')
            return original(req, timeout)
        report = proof.run(self.env, call, now=lambda: NOW, sleep=lambda _: None)
        self.assertEqual(report['status'], 'PASS', report)
        self.assertGreaterEqual(attempts[0], 2)
    def test_payment_is_rechecked_with_test_access_token(self):
        report = self.run_fake()
        self.assertEqual(report['checks']['PAYMENT_LOOKUP'], 'PASS')
        lookups = [r for r in self.fake.calls if r.full_url.endswith('/v1/payments/77')]
        self.assertEqual(len(lookups), 1)
        self.assertEqual(lookups[0].get_header('Authorization'), 'Bearer ' + self.identity.access_token)
        self.assertEqual(lookups[0].get_header('X-test-token'), 'true')

    def test_audit_id_is_sanitized_and_reaches_certification_routes(self):
        report = self.run_fake()
        self.assertRegex(report['audit_id'], r'^[0-9a-f-]{36}$')
        cert_calls = [r for r in self.fake.calls if r.full_url.startswith(proof.APP + proof.CERT_PATH)]
        self.assertTrue(cert_calls)
        self.assertTrue(all(r.get_header('X-audit-id') == report['audit_id'] for r in cert_calls))
        saved = json.dumps(report)
        for name in proof.SECRET_NAMES:
            self.assertNotIn(self.env[name], saved)

    def test_payment_for_other_collector_cannot_pass(self):
        original = self.fake.__call__
        def call(req, timeout):
            if req.full_url.endswith('/v1/payments'):
                return Response(json.dumps({'id': 77, 'collector_id': 99, 'status': 'approved',
                                            'external_reference': NEW_ORDER}).encode())
            return original(req, timeout)
        self.assertEqual(proof.run(self.env, call, now=lambda: NOW)['cause'], 'APPROVED_SANDBOX_PAYMENT_REQUIRED')

    def test_seller_without_test_user_tag_cannot_pay(self):
        original = self.fake.__call__
        def call(req, timeout):
            if req.full_url.endswith('/users/me'):
                return Response(json.dumps({'id': 10, 'tags': ['normal']}).encode())
            return original(req, timeout)
        self.assertEqual(proof.run(self.env, call, now=lambda: NOW)['cause'], 'PROVIDER_IDENTITY_MISMATCH')
        self.assertFalse(any('/v1/payments' in r.full_url for r in self.fake.calls))

    def test_inbox_outside_isolated_subdomain_denied(self):
        change_manifest(self.env, lambda m: m['inbox'].update(email='suporte@zevanory.api.br'))
        self.denied_preflight('READ_ONLY_CONTROLLED_INBOX_REQUIRED')

    def test_inbox_token_never_sent_to_certification_routes(self):
        with self.assertRaisesRegex(proof.GuardError, 'CERT_AUTH_DENIED'):
            proof.validate_request(proof.APP + proof.CERT_PATH + 'status', 'GET',
                {'x-certification-e2e-token': self.identity.certification_token,
                 'x-sandbox-inbox-token': self.identity.inbox_token}, self.identity)

    def test_invalid_signature_cannot_pass(self):
        self.fake.signature = False
        self.assertEqual(self.run_fake()['cause'], 'RECEIPT_WEBHOOK_TIMEOUT')

    def test_manual_replay_not_accepted(self):
        state = {'financial_events': [{'normalized_event': 'payment_confirmed', 'provider_payment_id': 77,
            'order_id': NEW_ORDER, 'source_class': 'manual_replay', 'signature_verified': True,
            'signature_secret_class': 'sandbox', 'signature_verified_by': 'receiver'}]}
        self.assertFalse(proof.verified_webhook(state, NEW_ORDER, '77'))

    def test_redirect_refused(self):
        with self.assertRaisesRegex(proof.GuardError, 'REDIRECT_DENIED'):
            proof.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://evil.example')

    def test_raw_provider_error_sanitized(self):
        self.fake.error = ValueError('secret=' + self.identity.access_token + '&token=download-token')
        report = self.run_fake()
        self.assertEqual(report['cause'], 'order_capabilities_request_failed')
        self.assertNotIn(self.identity.access_token, json.dumps(report))

    def test_unmocked_network_blocked(self):
        # This test asserts the suite-wide socket guard itself, not provider access.
        with patch.object(proof.urllib.request, 'build_opener') as opener:
            opener.return_value.open.side_effect = AssertionError('NETWORK_FORBIDDEN')
            report = proof.run(self.env)
        self.assertEqual(report['cause'], 'order_capabilities_request_failed')

    def test_changed_environment_detected(self):
        original = proof.preflight
        count = [0]
        def mutate(env):
            count[0] += 1
            value = original(env)
            if count[0] == 2:
                return proof.Identity(**{**value.__dict__, 'buyer_email': 'changed@testuser.com'})
            return value
        with patch.object(proof, 'preflight', side_effect=mutate):
            report = self.run_fake()
        self.assertEqual(report['cause'], 'IDENTITY_CHANGED_AFTER_PREFLIGHT')
        self.assertEqual(self.fake.calls, [])


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.manual = json.loads((ROOT / guards.MANUAL).read_text())
        self.static = json.loads((ROOT / guards.STATIC).read_text())

    def reject_manual(self, edit):
        d = copy.deepcopy(self.manual)
        edit(d)
        with self.assertRaises((AssertionError, ValueError)):
            guards.guarded_workflow(json.dumps(d), True)

    def test_forbidden_triggers(self):
        for event in ['pull_request', 'push', 'workflow_run', 'schedule']:
            with self.subTest(event=event):
                self.reject_manual(lambda d: d['on'].update({event: None}))

    def test_production_secret_reference(self):
        self.reject_manual(lambda d: d['jobs']['purchase']['steps'][2]['env'].update(
            MERCADOPAGO_ACCESS_TOKEN='${{ secrets.MERCADOPAGO_ACCESS_TOKEN }}'))

    def test_static_secret_reference(self):
        self.static['jobs']['checks']['env'] = {'TOKEN': '${{ secrets.ANY_TOKEN }}'}
        with self.assertRaises(AssertionError):
            guards.guarded_workflow(json.dumps(self.static), False)

    def test_disabled_variable_required(self):
        self.reject_manual(lambda d: d['jobs']['purchase'].update({'if': "github.event_name == 'workflow_dispatch'"}))

    def test_environment_required(self):
        self.reject_manual(lambda d: d['jobs']['purchase'].pop('environment'))

    def test_action_tag_refused(self):
        self.reject_manual(lambda d: d['jobs']['purchase']['steps'][0].update(uses='actions/checkout@v4'))

    def test_persisted_credentials_refused(self):
        self.reject_manual(lambda d: d['jobs']['purchase']['steps'][0]['with'].update({'persist-credentials': True}))

    def test_receiver_secret_refused(self):
        self.reject_manual(lambda d: d['jobs']['purchase']['steps'][2]['env'].update(
            MERCADOPAGO_TEST_WEBHOOK_SECRET='${{ secrets.MERCADOPAGO_TEST_WEBHOOK_SECRET }}'))

    def test_artifact_wildcard_refused(self):
        self.reject_manual(lambda d: d['jobs']['purchase']['steps'][3]['with'].update(path='evidence/**'))

    def test_automatic_public_get_allowed(self):
        guards.automatic_workflow_guard('permissions:\n  contents: read\nrun: curl -fsS https://zevanory.api.br/api/release')

    def test_automatic_payment_write_rejected(self):
        with self.assertRaises(AssertionError):
            guards.automatic_workflow_guard('run: curl -X POST https://api.mercadopago.com/v1/payments')

    def test_automatic_financial_secret_rejected(self):
        with self.assertRaises(AssertionError):
            guards.automatic_workflow_guard('env: ${{ secrets.MERCADOPAGO_TEST_ACCESS_TOKEN }}')

    def test_automatic_provider_contact_rejected(self):
        with self.assertRaises(AssertionError):
            guards.automatic_workflow_guard('run: curl https://api.mercadopago.com/users/me')

    def test_automatic_script_rejected(self):
        with self.assertRaises(AssertionError):
            guards.automatic_workflow_guard('run: python3 ' + guards.SCRIPT)

    def test_script_forbidden_creation_guard(self):
        with self.assertRaises(AssertionError):
            guards.script_guards((ROOT / guards.SCRIPT).read_text() + '\n# /users/test\n')

    def test_script_forbidden_creator_guard(self):
        with self.assertRaises(AssertionError):
            guards.script_guards((ROOT / guards.SCRIPT).read_text() + '\n# creator\n')

    def test_script_forbidden_host_guard(self):
        with self.assertRaises(AssertionError):
            guards.script_guards((ROOT / guards.SCRIPT).read_text() + '\nBAD = "https://evil.example/api"\n')

    def test_downstream_secret_write_rejected(self):
        text = "name: downstream\non:\n  workflow_run:\n    workflows: [public-audit]\n    types: [completed]\njobs:\n  persist:\n    env: ${{ secrets.MERCADOPAGO_TEST_ACCESS_TOKEN }}\n"
        with self.assertRaisesRegex(AssertionError, 'DOWNSTREAM'):
            guards.downstream_guards({'downstream.yml': text}, {'public-audit'})

    def test_downstream_public_get_allowed(self):
        text = "name: downstream\non:\n  workflow_run:\n    workflows: [public-audit]\n    types: [completed]\npermissions:\n  contents: read\njobs:\n  observe:\n    run: curl -fsS https://zevanory.api.br/api/release\n"
        self.assertEqual(guards.downstream_guards({'downstream.yml': text}, {'public-audit'}), {'downstream.yml'})

    def test_existing_nonfinancial_cloudflare_secret_allowed(self):
        guards.automatic_workflow_guard('env: ${{ secrets.CLOUDFLARE_API_TOKEN }}\nrun: wrangler kv key put state value --remote')

    def test_changed_exception_blob_rejected(self):
        text = (ROOT / '.github/workflows/zees16-control-reconciler.yml').read_text() + '\n# changed\n'
        with self.assertRaisesRegex(AssertionError, 'ZEES_EXCEPTION_BLOB_CHANGED'):
            guards.downstream_guards({'zees16-control-reconciler.yml': text}, {'zevanory-remote-quality-gates'})
