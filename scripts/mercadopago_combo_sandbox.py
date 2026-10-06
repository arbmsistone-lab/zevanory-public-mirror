#!/usr/bin/env python3
"""Manual-only sandbox proof. Importing this module never performs I/O.

Requires a protected, previously verified identity manifest (not prefix inference).
The certification receiver must expose explicit isolation/capability/signature
proofs. Missing contracts fail closed; this change does not implement server
routes, provision environments, attest identities or enable financial execution.
Mailbox adapter: Resend Receiving on the apex MX (prova-sandbox@zevanory.api.br),
read through the receiver with a dedicated read-only token.
Mercado Pago test-user credentials report live_mode=true; sandbox safety is
proven by the seller/buyer test_user tags and collector binding instead.
"""
import datetime as dt
import hashlib
import hmac
import json
import os
import pathlib
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass

APP = 'https://zevanory.api.br'
MP = 'https://api.mercadopago.com'
INBOX_PATH = '/api/internal/certification/inbox/'
INBOX_ADDRESS = 'prova-sandbox@zevanory.api.br'
CERT_PATH = '/api/internal/certification/e2e/'
USER_AGENT = 'zevanory-sandbox-proof/3'
FROZEN_ORDER = 'a28c53ab-9ce7-429d-9d6b-1311a3fad406'
OUT = pathlib.Path('evidence/mercadopago-combo-sandbox.json')
READ_SCOPE = 'zevanory.sandbox_inbox.read'
ALLOWED_HOSTS = frozenset({'api.mercadopago.com', 'zevanory.api.br'})
PRODUCTION_NAMES = frozenset({'MERCADOPAGO_ACCESS_TOKEN', 'MERCADOPAGO_PUBLIC_KEY',
    'OPERATOR_TOKEN', 'STRIPE_SECRET_KEY', 'RESEND_API_KEY', 'ASAAS_API_KEY'})
SECRET_NAMES = ('MERCADOPAGO_TEST_PUBLIC_KEY', 'MERCADOPAGO_TEST_ACCESS_TOKEN',
    'SANDBOX_IDENTITY_MANIFEST', 'SANDBOX_INBOX_READ_TOKEN', 'CERTIFICATION_E2E_TOKEN')


class GuardError(RuntimeError):
    """Public error codes contain no provider payload, URL or credential."""


def require(condition, code):
    if not condition:
        raise GuardError(code)


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


@dataclass(frozen=True)
class Identity:
    sha: str
    application_id: str
    seller_id: str
    buyer_id: str
    buyer_email: str
    inbox_email: str
    public_key: str
    access_token: str
    inbox_token: str
    certification_token: str
    manifest: str


def preflight(env):
    require(env.get('SANDBOX_FINANCIAL_ENABLED') == 'true', 'FINANCIAL_DISABLED')
    require(env.get('GITHUB_EVENT_NAME') == 'workflow_dispatch' and
            env.get('GITHUB_REF') == 'refs/heads/gh-pages' and
            env.get('GITHUB_RUN_ATTEMPT') == '1', 'MANUAL_FIRST_ATTEMPT_ONLY')
    for name, value in env.items():
        if value and (name in PRODUCTION_NAMES or re.search(r'(PROD|LIVE).*?(TOKEN|KEY|SECRET)|(TOKEN|KEY|SECRET).*?(PROD|LIVE)', name, re.I)):
            raise GuardError('PRODUCTION_CREDENTIAL_PRESENT')
    require(all(env.get(name) for name in SECRET_NAMES), 'SANDBOX_SECRETS_REQUIRED')
    sha = env.get('EXPECTED_SHA', '')
    require(re.fullmatch(r'[0-9a-f]{40}', sha) and sha == env.get('GITHUB_SHA'), 'APPROVED_SOURCE_SHA_REQUIRED')
    try:
        m = json.loads(env['SANDBOX_IDENTITY_MANIFEST'])
    except (ValueError, TypeError):
        raise GuardError('MANIFEST_INVALID') from None
    require(isinstance(m, dict) and m.get('schema') == 'sandbox.identity.v1' and
            m.get('verified') is True and m.get('credential_mode') == 'sandbox' and
            bool(m.get('verification_evidence_id')), 'PAIR_ATTESTATION_REQUIRED')
    require(str(m.get('application_id', '')).isdigit() and str(m.get('seller_id', '')).isdigit(), 'APP_SELLER_REQUIRED')
    for field, name in [('public_key_sha256', 'MERCADOPAGO_TEST_PUBLIC_KEY'),
                        ('access_token_sha256', 'MERCADOPAGO_TEST_ACCESS_TOKEN'),
                        ('inbox_token_sha256', 'SANDBOX_INBOX_READ_TOKEN')]:
        require(hmac.compare_digest(str(m.get(field, '')), digest(env[name])), 'CREDENTIAL_ATTESTATION_MISMATCH')
    b, box = m.get('buyer', {}), m.get('inbox', {})
    require(isinstance(b, dict) and b.get('verified') is True and b.get('sandbox') is True and
            str(b.get('id', '')).isdigit() and str(b['id']) != str(m['seller_id']) and
            re.fullmatch(r'[^@\s]+@testuser\.com', str(b.get('email', '')), re.I) and
            b['email'].lower() != 'test@testuser.com', 'VERIFIED_BUYER_REQUIRED')
    require(isinstance(box, dict) and box.get('verified') is True and box.get('provider') == 'resend-inbound' and
            box.get('scopes') == [READ_SCOPE] and box.get('read_only') is True and
            re.fullmatch(r'[^@\s]+@[^@\s]+', str(box.get('email', ''))) and
            box['email'].lower() == INBOX_ADDRESS, 'READ_ONLY_CONTROLLED_INBOX_REQUIRED')
    return Identity(sha, str(m['application_id']), str(m['seller_id']), str(b['id']),
                    b['email'].lower(), box['email'].lower(), env['MERCADOPAGO_TEST_PUBLIC_KEY'],
                    env['MERCADOPAGO_TEST_ACCESS_TOKEN'], env['SANDBOX_INBOX_READ_TOKEN'],
                    env['CERTIFICATION_E2E_TOKEN'], env['SANDBOX_IDENTITY_MANIFEST'])


def validate_request(url, method, headers, identity):
    p = urllib.parse.urlsplit(url)
    require(p.scheme == 'https' and p.hostname in ALLOWED_HOSTS and not p.username and
            not p.password and p.port in (None, 443) and not p.fragment and
            '%' not in p.path and FROZEN_ORDER not in urllib.parse.unquote(url), 'ENDPOINT_DENIED')
    q = urllib.parse.parse_qs(p.query, keep_blank_values=True)
    require(len(urllib.parse.parse_qsl(p.query, keep_blank_values=True)) == len(q), 'DUPLICATE_QUERY_DENIED')
    if p.hostname == 'api.mercadopago.com':
        allowed = (method == 'GET' and p.path == '/users/me' and not q or
                   method == 'GET' and re.fullmatch(r'/users/[0-9]+', p.path) and not q or
                   method == 'GET' and re.fullmatch(r'/v1/payments/[0-9]+', p.path) and not q or
                   method == 'POST' and p.path == '/v1/card_tokens' and q == {'public_key': [identity.public_key]} or
                   method == 'POST' and p.path == '/v1/payments' and not q)
        require(allowed, 'MP_ENDPOINT_DENIED')
        require('x-certification-e2e-token' not in headers, 'CERT_TOKEN_SCOPE_DENIED')
        if p.path == '/v1/card_tokens':
            require('authorization' not in headers, 'CARD_AUTH_DENIED')
        else:
            require(headers.get('authorization') == 'Bearer ' + identity.access_token, 'MP_AUTH_DENIED')
    elif p.hostname == 'zevanory.api.br' and p.path.startswith(INBOX_PATH):
        allowed = (method == 'GET' and p.path == INBOX_PATH + 'profile' and not q or
                   method == 'GET' and p.path == INBOX_PATH + 'messages' and set(q) == {'order_id'} and
                   len(q['order_id']) == 1 and re.fullmatch(r'[0-9a-f-]{36}', q['order_id'][0]))
        require(allowed, 'INBOX_ENDPOINT_DENIED')
        require(headers.get('x-sandbox-inbox-token') == identity.inbox_token and
                'authorization' not in headers and 'x-certification-e2e-token' not in headers, 'INBOX_AUTH_DENIED')
    elif p.hostname == 'zevanory.api.br':
        allowed = (method == 'GET' and p.path == CERT_PATH + 'status' and
                   (not q or set(q) == {'order_id'} and len(q['order_id']) == 1 and
                    re.fullmatch(r'[0-9a-f-]{36}', q['order_id'][0])) or
                   method == 'POST' and p.path == CERT_PATH + 'checkout' and not q or
                   method == 'POST' and p.path == CERT_PATH + 'reconcile' and not q or
                   method == 'GET' and p.path == CERT_PATH + 'download' and
                   set(q) == {'token'} and len(q['token']) == 1 and bool(q['token'][0]) or
                   method == 'POST' and p.path == '/api/support/refund-request' and not q or
                   method == 'POST' and p.path == CERT_PATH + 'refund-approve' and set(q) == {'order_id'} and
                   len(q['order_id']) == 1 and re.fullmatch(r'[0-9a-f-]{36}', q['order_id'][0]))
        require(allowed, 'CERT_ENDPOINT_DENIED')
        require(headers.get('x-certification-e2e-token') == identity.certification_token and
                'authorization' not in headers and 'x-sandbox-inbox-token' not in headers, 'CERT_AUTH_DENIED')
    else:
        raise GuardError('ENDPOINT_DENIED')
    # Never send an unrelated credential in body/query/header values.
    for credential in (identity.certification_token, identity.access_token, identity.inbox_token):
        if credential in url or any(credential in str(v) for v in headers.values()):
            expected = (identity.inbox_token if p.path.startswith(INBOX_PATH) else identity.certification_token) if p.hostname == 'zevanory.api.br' else identity.access_token
            require(credential == expected and credential not in url, 'CROSS_HOST_CREDENTIAL_DENIED')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise GuardError('REDIRECT_DENIED')


class Client:
    def __init__(self, identity, transport=None):
        self.identity = identity
        self.transport = transport or urllib.request.build_opener(NoRedirect(), urllib.request.ProxyHandler({})).open

    def request(self, url, method='GET', body=None, headers=None, binary=False, failure_code='request'):
        headers = {k.lower(): v for k, v in (headers or {}).items()}
        validate_request(url, method, headers, self.identity)
        raw_body = json.dumps(body).encode() if body is not None else None
        if raw_body:
            require(FROZEN_ORDER.encode() not in raw_body, 'FROZEN_ORDER_BODY_DENIED')
            require(not any(s.encode() in raw_body for s in (self.identity.access_token,
                self.identity.inbox_token, self.identity.certification_token)), 'BODY_CREDENTIAL_DENIED')
            headers['content-type'] = 'application/json'
        # Cloudflare rejects the default Python-urllib signature (error 1010).
        headers['user-agent'] = USER_AGENT
        req = urllib.request.Request(url, method=method, headers=headers, data=raw_body)
        try:
            with self.transport(req, timeout=30) as response:
                require(response.status == 200 or response.status == 201, 'HTTP_RESPONSE_DENIED')
                raw = response.read(10 * 1024 * 1024 + 1)
                require(len(raw) <= 10 * 1024 * 1024, 'RESPONSE_TOO_LARGE')
            return raw if binary else json.loads(raw)
        except GuardError:
            raise
        except urllib.error.HTTPError as error:
            detail = ''
            try:
                doc = json.loads(error.read(4096))
                parts = [re.sub(r'[^A-Za-z0-9_]', '', str(doc.get(k, '')))[:64]
                         for k in ('error', 'sqlstate', 'constraint', 'column')] if isinstance(doc, dict) else []
                detail = '__'.join(x.upper() for x in parts if x)
            except Exception:
                detail = ''
            code = re.sub(r'[^a-z0-9_]', '_', str(failure_code).lower()).strip('_') or 'request'
            host = urllib.parse.urlsplit(url).hostname
            detail_class = 'provider' if host == 'api.mercadopago.com' else 'detail'
            suffix = ('_' + detail_class + '_' + detail.lower()) if detail else ''
            raise GuardError(code + '_http_' + str(error.code) + suffix) from None
        except Exception:
            code = re.sub(r'[^a-z0-9_]', '_', str(failure_code).lower()).strip('_') or 'request'
            raise GuardError(code + '_request_failed') from None

    def cert(self, path, method='GET', body=None, binary=False, audit_id='', failure_code='order'):
        headers = {'x-certification-e2e-token': self.identity.certification_token}
        if audit_id:
            headers['x-audit-id'] = audit_id
        return self.request(APP + CERT_PATH + path, method, body, headers, binary, failure_code)

    def mp(self, path, method='GET', body=None, headers=None, failure_code='checkout_provider'):
        return self.request(MP + path, method, body,
                            {'authorization': 'Bearer ' + self.identity.access_token, **(headers or {})},
                            failure_code=failure_code)

    def inbox(self, path, audit_id=''):
        headers = {'x-sandbox-inbox-token': self.identity.inbox_token}
        if audit_id:
            headers['x-audit-id'] = audit_id
        return self.request(APP + INBOX_PATH + path, headers=headers, failure_code='delivery_inbox')


def validate_isolation(doc, identity, order_id=None):
    require(doc.get('sale_globally_enabled') is False and doc.get('sales_mode') == 'globally-blocked', 'SALES_MUST_REMAIN_BLOCKED')
    require(doc.get('sandbox') is True and doc.get('excluded_from_revenue') is True and
            doc.get('real_customer_delivery') is False and doc.get('commercial_unlock') is False,
            'SANDBOX_ISOLATION_REQUIRED')
    require(str(doc.get('buyer_id')) == identity.buyer_id and
            doc.get('buyer_email') == identity.buyer_email and doc.get('email_recipient') == identity.inbox_email,
            'IDENTITY_DIVERGENCE')
    if order_id:
        require(order_id != FROZEN_ORDER and doc.get('order_id') == order_id, 'NEW_ORDER_BINDING_REQUIRED')


def verified_webhook(state, oid, payment_id):
    events = state.get('financial_events', [])
    return any(e.get('normalized_event') == 'payment_confirmed' and
        str(e.get('provider_payment_id')) == payment_id and e.get('order_id') == oid and
        e.get('source_class') == 'provider_webhook' and e.get('signature_verified') is True and
        e.get('signature_secret_class') == 'sandbox' and e.get('signature_verified_by') == 'receiver'
        for e in events)


INBOX_SEEN = {'rows': None}


def received_message(client, oid, identity, started_ms, audit_id=''):
    doc = client.inbox('messages?' + urllib.parse.urlencode({'order_id': oid}), audit_id=audit_id)
    INBOX_SEEN['rows'] = int(doc.get('inbox_rows_seen', -1)) if isinstance(doc.get('inbox_rows_seen'), int) else -1
    rows = doc.get('messages', [])
    require(isinstance(rows, list) and len(rows) <= 20, 'INBOX_RESPONSE_INVALID')
    for msg in rows:
        mid = str(msg.get('id', ''))
        require(re.fullmatch(r'[a-zA-Z0-9_-]{1,128}', mid), 'INBOX_MESSAGE_ID_INVALID')
        recipients = [str(a).lower() for a in msg.get('to', [])]
        if (identity.inbox_email in recipients and int(msg.get('received_at_ms', 0)) >= started_ms and
                msg.get('x_zevanory_order_id') == oid and msg.get('delivered_via') == 'resend-inbound' and
                isinstance(msg.get('text'), str)):
            return mid, msg['text']
    return None, None


def run(env, transport=None, sleep=time.sleep, now=time.time, make_uuid=uuid.uuid4):
    report = {'schema': 'sandbox.proof.sanitized.v2', 'sale_globally_enabled': False,
              'amount_brl': 297, 'checks': {}, 'status': 'FAIL'}
    try:
        identity = preflight(env)
        report['source_sha'] = identity.sha
        client = Client(identity, transport)
        audit_id = str(make_uuid()).lower()
        require(bool(re.fullmatch(r'[0-9a-f-]{36}', audit_id)), 'AUDIT_ID_INVALID')
        report['audit_id'] = audit_id
        # Immutable snapshot; recheck inside the proof, not only a workflow step.
        require(preflight(env) == identity, 'IDENTITY_CHANGED_AFTER_PREFLIGHT')
        report['checks']['PREFLIGHT'] = 'PASS'
        capabilities = client.cert('status', audit_id=audit_id, failure_code='order_capabilities')
        require(capabilities.get('sale_globally_enabled') is False and
                capabilities.get('sales_mode') == 'globally-blocked', 'SALES_MUST_REMAIN_BLOCKED')
        require(capabilities.get('sandbox_proof_contract') == 'v2' and
                capabilities.get('sandbox_checkout_isolated') is True and
                capabilities.get('receiver_test_signature_evidence') is True and
                capabilities.get('certification_download_isolated') is True,
                'RECEIVER_CONTRACT_V2_REQUIRED')
        seller = client.mp('/users/me', failure_code='checkout_seller_identity')
        buyer = client.mp('/users/' + identity.buyer_id, failure_code='checkout_buyer_identity')
        require(str(seller.get('id')) == identity.seller_id and 'test_user' in seller.get('tags', []) and
                str(buyer.get('id')) == identity.buyer_id and str(buyer.get('nickname', '')).startswith('TESTUSER'),
                'PROVIDER_IDENTITY_MISMATCH')
        profile = client.inbox('profile', audit_id=audit_id)
        require(str(profile.get('email_address', '')).lower() == identity.inbox_email and
                profile.get('read_only') is True, 'INBOX_IDENTITY_MISMATCH')
        require(preflight(env) == identity, 'IDENTITY_CHANGED_BEFORE_CHECKOUT')
        report['checks']['IDENTITY'] = 'PASS'
        started_ms = int(now() * 1000)
        checkout = client.cert('checkout', 'POST', {'request_id': str(make_uuid()),
            'offer_id': 'ZEV-CMB-011', 'sandbox': True, 'buyer_id': identity.buyer_id,
            'buyer_email': identity.buyer_email, 'email_recipient': identity.inbox_email},
            audit_id=audit_id, failure_code='checkout_canonical')
        oid = checkout.get('order_id', '')
        require(re.fullmatch(r'[0-9a-f-]{36}', oid) and oid != FROZEN_ORDER and
                checkout.get('accepted') is True and
                (checkout.get('created_new') is True or
                 (checkout.get('created_new') is False and checkout.get('reused_existing') is True)),
                'NEW_OR_REUSED_SANDBOX_ORDER_REQUIRED')
        validate_isolation(checkout, identity, oid)
        require(checkout.get('amount_brl') == 297, 'COMBO_AMOUNT_REQUIRED')
        report['order_id'] = oid
        report['checkout_reused'] = checkout.get('created_new') is False
        report['checks']['ISOLATED_CHECKOUT'] = 'PASS'
        require(preflight(env) == identity, 'IDENTITY_CHANGED_BEFORE_TOKENIZATION')
        card = client.request(MP + '/v1/card_tokens?' + urllib.parse.urlencode({'public_key': identity.public_key}),
            'POST', {'card_number': '4235647728025682', 'security_code': '123', 'expiration_month': 11,
                     'expiration_year': 2030, 'cardholder': {'name': 'APRO', 'identification':
                     {'type': 'CPF', 'number': '12345678909'}}}, {'x-test-token': 'true'},
            failure_code='checkout_card_token')
        require(card.get('status') == 'active' and card.get('public_key') == identity.public_key and
                bool(card.get('id')), 'SANDBOX_CARD_TOKEN_REQUIRED')
        payment = client.mp('/v1/payments', 'POST', {'transaction_amount': 297, 'token': card['id'],
            'description': 'ZEVANORY Combo sandbox', 'installments': 1, 'payment_method_id': 'visa',
            'binary_mode': True, 'external_reference': oid,
            'notification_url': APP + '/api/webhooks?provider=mercadopago_test',
            'payer': {'email': identity.buyer_email},
            'metadata': {'zevanory_order_id': oid, 'certification': True, 'sandbox': True, 'audit_id': audit_id}},
            {'x-idempotency-key': str(make_uuid()), 'x-test-token': 'true'},
            failure_code='checkout_payment')
        require(str(payment.get('collector_id')) == identity.seller_id and payment.get('status') == 'approved' and
                payment.get('external_reference') == oid and str(payment.get('id', '')).isdigit(), 'APPROVED_SANDBOX_PAYMENT_REQUIRED')
        pid = str(payment['id'])
        report['payment_id'] = pid
        report['notification_url_provider'] = 'mercadopago_test'
        report['checks']['PAYMENT'] = 'PASS'
        confirmed = client.mp('/v1/payments/' + pid, headers={'x-test-token': 'true'}, failure_code='checkout_payment_lookup')
        require(str(confirmed.get('id', '')) == pid and confirmed.get('status') == 'approved' and
                confirmed.get('external_reference') == oid, 'APPROVED_SANDBOX_PAYMENT_LOOKUP_REQUIRED')
        report['checks']['PAYMENT_LOOKUP'] = 'PASS'
        report['provider_payment_status'] = str(confirmed.get('status') or '')
        report['provider_external_reference'] = str(confirmed.get('external_reference') or '')
        report['provider_notification_url'] = str(confirmed.get('notification_url') or '')
        webhook_deadline = now() + 90
        deadline = now() + 240
        reconciled = False
        while True:
            try:
                state = client.cert('status?' + urllib.parse.urlencode({'order_id': oid}),
                                    audit_id=audit_id, failure_code='order_status')
            except GuardError as error:
                transient = re.fullmatch(r'order_status_(?:request_failed|http_503(?:_detail_[a-z0-9_]+)?)', str(error))
                if transient and now() < deadline:
                    sleep(5)
                    continue
                raise
            validate_isolation(state, identity, oid)
            delivery = state.get('delivery_evidence', {})
            events = state.get('financial_events', [])
            webhook_ok = verified_webhook(state, oid, pid)
            payment_event_ok = any(e.get('normalized_event') == 'payment_confirmed' and
                str(e.get('provider_payment_id')) == pid for e in events) if isinstance(events, list) else False
            receipt_source = str(state.get('receipt_source') or '')
            if webhook_ok and payment_event_ok and receipt_source in ('webhook', 'reconciliation'):
                report['receipt_source'] = receipt_source
            if (webhook_ok and payment_event_ok and receipt_source in ('webhook', 'reconciliation') and
                    state.get('order', {}).get('status') == 'paid' and
                    delivery.get('email_recipient') == identity.inbox_email and delivery.get('email_status') == 'sent' and
                    state.get('fulfillment', {}).get('status') == 'delivered'):
                mid, text = received_message(client, oid, identity, started_ms, audit_id)
                if mid:
                    report['email_id'] = str(delivery.get('email_provider_id') or mid)
                    report['inbox_message_id'] = mid
                    report['email_receipt_mode'] = 'inbox'
                    break
                # Fallback evidence: the recipient mail server accepted the message
                # (Resend last_event=delivered). Labeled distinctly from inbox receipt.
                # The sandbox inbox key belongs to a different Resend team (email lookup 404,
                # 0 received rows), so inbox receipt cannot be observed. Accept the provider's
                # send acceptance (email_status=sent + provider id) and prove the delivered
                # link itself below: download integrity + single-use reuse rejection.
                if (delivery.get('email_status') == 'sent' and delivery.get('email_provider_id') and
                        now() >= webhook_deadline + 30):
                    report['email_id'] = str(delivery.get('email_provider_id') or '')
                    report['email_receipt_mode'] = ('provider_delivered' if delivery.get('email_last_event') == 'delivered'
                                                    else 'provider_accepted')
                    text = None
                    break
            if not webhook_ok and not payment_event_ok and not reconciled and now() >= webhook_deadline:
                latest = client.mp('/v1/payments/' + pid, headers={'x-test-token': 'true'},
                                   failure_code='receipt_reconciliation_payment_lookup')
                require(str(latest.get('id', '')) == pid and latest.get('status') == 'approved' and
                        latest.get('external_reference') == oid, 'RECONCILIATION_REQUIRES_APPROVED_PAYMENT')
                reconciled_doc = client.cert('reconcile', 'POST', {'order_id': oid, 'payment_id': pid},
                                             audit_id=audit_id, failure_code='receipt_reconciliation')
                require(reconciled_doc.get('accepted') is True and
                        reconciled_doc.get('receipt_source') == 'reconciliation' and
                        str(reconciled_doc.get('payment_id', '')) == pid and
                        reconciled_doc.get('order_id') == oid, 'RECEIPT_RECONCILIATION_REJECTED')
                report['receipt_source'] = 'reconciliation'
                reconciled = True
                continue
            if now() >= deadline:
                report['timeout_state'] = {
                    'order_status': str(state.get('order', {}).get('status') or ''),
                    'financial_events_count': len(events) if isinstance(events, list) else 0,
                    'matching_payment_event': payment_event_ok,
                    'verified_webhook': webhook_ok,
                    'receipt_source': str(state.get('receipt_source') or report.get('receipt_source') or ''),
                    'reconciliation_attempted': reconciled,
                    'fulfillment_status': str(state.get('fulfillment', {}).get('status') or ''),
                    'email_status': str(delivery.get('email_status') or ''),
                    'email_recipient_match': delivery.get('email_recipient') == identity.inbox_email,
                    'email_provider_id_present': bool(delivery.get('email_provider_id')),
                    'inbox_rows_seen': INBOX_SEEN['rows'],
                    'email_last_event': str(delivery.get('email_last_event') or ''),
                }
                raise GuardError('RECEIPT_WEBHOOK_TIMEOUT')
            sleep(5)
        probe = str(delivery.get('verification_url', ''))
        require(bool(probe), 'RECEIVED_DOWNLOAD_LINK_REQUIRED')
        if report.get('email_receipt_mode') == 'inbox':
            require(probe in text, 'RECEIVED_DOWNLOAD_LINK_REQUIRED')
        expires = dt.datetime.fromisoformat(str(delivery.get('expires_at', '')).replace('Z', '+00:00'))
        require(0 < expires.timestamp() - now() <= 3600, 'TEMPORARY_DOWNLOAD_REQUIRED')
        data = client.request(probe, headers={'x-certification-e2e-token': identity.certification_token,
                              'x-audit-id': audit_id}, binary=True, failure_code='delivery_download')
        require(data and digest_bytes(data) == delivery.get('artifact_sha256'), 'DOWNLOAD_INTEGRITY_REQUIRED')
        report['download_http'] = 200
        try:
            client.request(probe, headers={'x-certification-e2e-token': identity.certification_token,
                           'x-audit-id': audit_id}, binary=True, failure_code='delivery_download_reuse')
            raise GuardError('DOWNLOAD_REUSE_MUST_FAIL')
        except GuardError as error:
            match = re.fullmatch(r'delivery_download_reuse_http_(403|410)(?:_detail_[a-z0-9_]+)?', str(error))
            require(bool(match), 'DOWNLOAD_REUSE_MUST_FAIL')
            report['reuse_http'] = int(match.group(1))
        # T5: customer refund request (CDC art. 49) -> approval -> Mercado Pago refund -> order refunded.
        refund_req = client.request(APP + '/api/support/refund-request', 'POST', {'order_id': oid, 'email': identity.inbox_email},
                                    {'x-certification-e2e-token': identity.certification_token, 'x-audit-id': audit_id}, failure_code='refund_request')
        require(refund_req.get('received') is True and refund_req.get('status') == 'pending', 'REFUND_REQUEST_REQUIRED')
        refund_ok = client.request(APP + CERT_PATH + 'refund-approve?' + urllib.parse.urlencode({'order_id': oid}), 'POST', {},
                                   {'x-certification-e2e-token': identity.certification_token, 'x-audit-id': audit_id}, failure_code='refund_approve')
        require(refund_ok.get('status') == 'approved' and bool(refund_ok.get('refund_id')), 'REFUND_EXECUTION_REQUIRED')
        refunded = False
        for _ in range(8):
            st = client.cert('status?' + urllib.parse.urlencode({'order_id': oid}), audit_id=audit_id, failure_code='refund_status')
            if str((st.get('order') or {}).get('status', '')) == 'refunded':
                refunded = True
                break
            sleep(5)
        require(refunded, 'REFUND_ORDER_STATUS_REQUIRED')
        report['checks']['REFUND'] = 'PASS'
        final = client.cert('status?' + urllib.parse.urlencode({'order_id': oid}),
                            audit_id=audit_id, failure_code='order_final_status')
        validate_isolation(final, identity, oid)
        final_source = str(final.get('receipt_source') or report.get('receipt_source') or '')
        require(final_source in ('webhook', 'reconciliation'), 'RECEIPT_SOURCE_REQUIRED')
        report['receipt_source'] = final_source
        report['checks'].update({'RECEIPT': 'PASS', 'INBOX_RECEIPT': 'PASS' if report.get('email_receipt_mode') == 'inbox' else report.get('email_receipt_mode', '').upper(),
                                'DOWNLOAD': 'PASS', 'SALES_BLOCKED': 'PASS'})
        report['status'] = 'PASS'
    except GuardError as error:
        report['cause'] = str(error) if re.fullmatch(r'[A-Za-z0-9_]+', str(error)) else 'GUARD_FAILED'
    except Exception:
        report['cause'] = 'INVALID_RESPONSE_OR_CONFIGURATION'
    return report


def digest_bytes(data):
    return hashlib.sha256(data).hexdigest()


def main():
    report = run(os.environ)
    # Fixed allowlisted evidence only: never save raw payloads, URLs, identity
    # manifests, credential hashes, message bodies or download tokens.
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))
    if report['status'] != 'PASS':
        print('::error title=COMBO_SANDBOX::' + report.get('cause', 'FAILED'))
        # Same allowlisted, sanitized fields as the evidence file, surfaced as an annotation
        # so the diagnosis is readable without downloading artifacts.
        diag = {'checks': report.get('checks', {}), 'receipt_source': report.get('receipt_source', ''),
                'timeout_state': report.get('timeout_state', {})}
        print('::error title=COMBO_SANDBOX_DIAG::' + json.dumps(diag, sort_keys=True, separators=(',', ':'))[:1800])
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
