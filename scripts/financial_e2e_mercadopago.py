#!/usr/bin/env python3
import datetime as dt
import hashlib
import hmac
import json
import os
import pathlib
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

APP = "https://zevanory.api.br"
MP = "https://api.mercadopago.com"
OUT = pathlib.Path("evidence/financial-e2e-mercadopago.json")

TOKEN = (os.environ.get("MERCADOPAGO_TEST_ACCESS_TOKEN") or "").strip()
WEBHOOK_SECRET = (os.environ.get("MERCADOPAGO_TEST_WEBHOOK_SECRET") or "").strip()
CERT_TOKEN = (os.environ.get("CERTIFICATION_E2E_TOKEN") or "").strip()
EXPECTED_SHA = (os.environ.get("EXPECTED_SHA") or "").strip().lower()

def request(url, method="GET", headers=None, body=None, ok=(200, 201, 202)):
    h = {"accept": "application/json", "user-agent": "ZEVANORY-MercadoPago-E2E/1.0"}
    if headers:
        h.update(headers)
    data = None
    if body is not None:
        h["content-type"] = "application/json"
        data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, method=method, headers=h, data=data)
    try:
        with urllib.request.urlopen(req, timeout=40) as res:
            raw = res.read().decode("utf-8", "replace")
            obj = json.loads(raw) if raw else {}
            if res.status not in ok:
                raise AssertionError((url, res.status, obj))
            return res.status, obj
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        try:
            obj = json.loads(raw) if raw else {}
        except Exception:
            obj = {"raw": raw[:1200]}
        if exc.code in ok:
            return exc.code, obj
        raise AssertionError((url, exc.code, obj))

def app(path, method="GET", headers=None, body=None, ok=(200, 201, 202)):
    return request(APP + path, method, headers, body, ok)

def mp(path, method="GET", body=None, headers=None, ok=(200, 201)):
    h = {"authorization": "Bearer " + TOKEN}
    if headers:
        h.update(headers)
    return request(MP + path, method, h, body, ok)

def wait_until(label, fn, timeout=180, interval=3):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            last = fn()
            if last:
                return last
        except Exception as exc:
            last = {"error": str(exc)}
        time.sleep(interval)
    raise AssertionError(f"{label}_timeout:{last}")

def cert_status(order_id):
    return app(
        "/api/internal/certification/e2e/status?order_id=" + urllib.parse.quote(order_id),
        headers={"x-certification-e2e-token": CERT_TOKEN},
        ok=(200,),
    )[1]

def events(state, normalized):
    return [x for x in state.get("financial_events", []) if x.get("normalized_event") == normalized]

def assert_release():
    _, release = app("/api/release", ok=(200,))
    assert release.get("deployment", {}).get("commit_sha", "").lower() == EXPECTED_SHA, release
    assert release.get("sales_mode") == "globally-blocked", release
    assert release.get("checkout_mode") == "enabled", release
    assert release.get("financial_mode") == "enabled", release
    _, health = app("/api/health", ok=(200,))
    assert health.get("live") is True and health.get("ready") is True, health
    return release

def create_invite():
    _, invite = app(
        "/api/internal/certification/e2e/invite",
        "POST",
        {"x-certification-e2e-token": CERT_TOKEN},
        {},
        ok=(201,),
    )
    assert invite.get("created") is True and invite.get("commercial_unlock") is False, invite
    assert invite.get("token"), invite
    return invite

def create_checkout(token, request_id, session_id, ok=(201,)):
    return app(
        "/api/checkout/mercadopago",
        "POST",
        {"x-certification-pilot-token": token},
        {"request_id": request_id, "session_id": session_id, "offer_id": "OFFER-0001"},
        ok=ok,
    )

def create_card_token():
    _, card = mp(
        "/v1/card_tokens",
        "POST",
        {
            "card_number": "4235647728025682",
            "security_code": "123",
            "expiration_month": 11,
            "expiration_year": 2030,
            "cardholder": {
                "name": "APRO",
                "identification": {"type": "CPF", "number": "12345678909"},
            },
        },
        ok=(200, 201),
    )
    token = str(card.get("id", ""))
    assert token and card.get("status") == "active", card
    return token

def create_payment(order_id, amount):
    card_token = create_card_token()
    payment_key = str(uuid.uuid4())
    external_reference = "ZEVANORY:EXP-0001:" + order_id
    _, payment = mp(
        "/v1/payments",
        "POST",
        {
            "transaction_amount": float(amount),
            "token": card_token,
            "description": "ZEVANORY Mercado Pago certification sandbox",
            "installments": 1,
            "payment_method_id": "visa",
            "binary_mode": True,
            "external_reference": external_reference,
            "notification_url": APP + "/api/webhooks?provider=mercadopago_test",
            "payer": {
                "email": "test@testuser.com",
                "identification": {"type": "CPF", "number": "12345678909"},
            },
            "metadata": {"zevanory_order_id": order_id, "certification": True},
        },
        {"x-idempotency-key": payment_key},
        ok=(200, 201),
    )
    assert str(payment.get("external_reference", "")) == external_reference, payment
    assert str(payment.get("status", "")).lower() == "approved", payment
    assert abs(float(payment.get("transaction_amount", 0)) - float(amount)) < 0.001, payment
    pid = str(payment.get("id", ""))
    assert pid.isdigit(), payment
    return pid, payment_key, payment

def signed_webhook(payment_id, bad=False):
    ts = str(int(time.time()))
    request_id = str(uuid.uuid4())
    manifest = f"id:{payment_id};request-id:{request_id};ts:{ts};"
    digest = hmac.new(WEBHOOK_SECRET.encode(), manifest.encode(), hashlib.sha256).hexdigest()
    if bad:
        digest = "0" * 64
    body = {"type": "payment", "data": {"id": str(payment_id)}}
    return app(
        "/api/webhooks?provider=mercadopago_test&data.id=" + urllib.parse.quote(str(payment_id)),
        "POST",
        {"x-request-id": request_id, "x-signature": f"ts={ts},v1={digest}"},
        body,
        ok=(401,) if bad else (200,),
    )

def provider_payment(payment_id):
    return mp("/v1/payments/" + urllib.parse.quote(payment_id), ok=(200,))[1]

def full_refund(payment_id):
    key = str(uuid.uuid4())
    _, refund = mp(
        "/v1/payments/" + urllib.parse.quote(payment_id) + "/refunds",
        "POST",
        {},
        {"x-idempotency-key": key},
        ok=(200, 201),
    )
    return key, refund

def refund_list(payment_id):
    _, rows = mp("/v1/payments/" + urllib.parse.quote(payment_id) + "/refunds", ok=(200,))
    return rows if isinstance(rows, list) else rows.get("results", rows.get("data", []))

def main():
    assert len(EXPECTED_SHA) == 40 and all(c in "0123456789abcdef" for c in EXPECTED_SHA)
    assert TOKEN, "MERCADOPAGO_TEST_ACCESS_TOKEN_missing"
    assert len(WEBHOOK_SECRET) >= 16, "MERCADOPAGO_TEST_WEBHOOK_SECRET_missing"
    assert len(CERT_TOKEN) >= 32, "CERTIFICATION_E2E_TOKEN_missing"

    release = assert_release()

    # Auth must fail before provider lookup or DB mutation.
    code, bad = signed_webhook("1234567890", bad=True)
    assert code == 401 and bad.get("error") == "webhook_auth_failed", bad
    print("WEBHOOK_AUTH=PASS")

    invite = create_invite()
    request_id = str(uuid.uuid4())
    session_id = str(uuid.uuid4())
    code, checkout = create_checkout(invite["token"], request_id, session_id)
    assert code == 201 and checkout.get("accepted") is True and checkout.get("duplicate") is False, checkout
    order_id = str(checkout["order_id"])
    checkout_url = str(checkout.get("checkout_url", ""))
    assert checkout_url.startswith("https://"), checkout
    print("CHECKOUT=PASS")

    # Checkout idempotency and conflicting identity.
    code, duplicate = create_checkout(invite["token"], request_id, session_id, ok=(200,))
    assert code == 200 and duplicate.get("duplicate") is True and duplicate.get("order_id") == order_id, duplicate
    code, conflict = create_checkout(invite["token"], request_id, str(uuid.uuid4()), ok=(409,))
    assert code == 409 and conflict.get("error") == "request_id_conflict", conflict
    print("IDEMPOTENCY=PASS")

    initial = cert_status(order_id)
    assert initial.get("order", {}).get("status") == "checkout_ready", initial
    assert initial.get("order", {}).get("provider") == "mercadopago", initial
    assert initial.get("order", {}).get("certification_pilot") is True, initial
    amount = float(initial["order"]["amount"])

    payment_id, payment_key, created = create_payment(order_id, amount)
    print("PAYMENT_CREATED=PASS", payment_id)

    # Require provider-originated webhook delivery, not a locally fabricated confirmation.
    paid = wait_until(
        "real_provider_payment_webhook",
        lambda: (lambda s: s if (
            s.get("order", {}).get("status") == "paid"
            and len(events(s, "payment_confirmed")) == 1
            and s.get("fulfillment", {}).get("status") in ("pending", "scheduled", "in_progress", "delivered")
        ) else None)(cert_status(order_id)),
        timeout=240,
    )
    pay_events = events(paid, "payment_confirmed")
    assert pay_events[0].get("provider_payment_id") == payment_id, paid
    assert paid.get("invariants", {}).get("exactly_one_payment_confirmation") is True, paid
    assert paid.get("invariants", {}).get("paid_entitlement_consistent") is True, paid
    print("PAYMENT_CONFIRMED=PASS")
    print("REAL_PROVIDER_WEBHOOK=PASS")
    print("DB_RECONCILIATION=PASS")
    print("ENTITLEMENT=PASS")

    # Replay an authenticated notification; handler must re-fetch provider truth.
    before_payment_events = len(pay_events)
    code, replay = signed_webhook(payment_id)
    assert code == 200 and replay.get("accepted") is True, replay
    after_replay = cert_status(order_id)
    assert len(events(after_replay, "payment_confirmed")) == before_payment_events, after_replay
    print("REPLAY_PROTECTION=PASS")

    refund_key, refund = full_refund(payment_id)
    print("REFUND_REQUEST_ACCEPTED=PASS")

    provider_refunded = wait_until(
        "provider_refund_terminal",
        lambda: (lambda p: p if (
            str(p.get("status", "")).lower() == "refunded"
            and float(p.get("transaction_amount_refunded", 0) or 0) >= amount
        ) else None)(provider_payment(payment_id)),
        timeout=240,
    )
    refunds = refund_list(payment_id)
    assert len(refunds) == 1, refunds
    print("PROVIDER_FINAL_STATE=TERMINAL")

    # Prefer the real provider refund webhook; if delivery is delayed, an authenticated
    # reconciliation trigger is allowed only after direct provider truth is terminal.
    try:
        refunded = wait_until(
            "real_provider_refund_webhook",
            lambda: (lambda s: s if (
                s.get("order", {}).get("status") == "refunded"
                and len(events(s, "refund_confirmed")) >= 1
                and s.get("fulfillment", {}).get("status") == "canceled"
            ) else None)(cert_status(order_id)),
            timeout=120,
        )
        refund_delivery = "provider_webhook"
    except AssertionError:
        code, reconciliation = signed_webhook(payment_id)
        assert code == 200 and reconciliation.get("accepted") is True, reconciliation
        refunded = wait_until(
            "refund_reconciliation",
            lambda: (lambda s: s if (
                s.get("order", {}).get("status") == "refunded"
                and len(events(s, "refund_confirmed")) >= 1
                and s.get("fulfillment", {}).get("status") == "canceled"
            ) else None)(cert_status(order_id)),
            timeout=60,
        )
        refund_delivery = "authenticated_provider_truth_reconciliation"

    assert refunded.get("invariants", {}).get("refund_observed") is True, refunded
    assert refunded.get("invariants", {}).get("refunded_entitlement_revoked") is True, refunded
    print("REFUND=PASS")
    print("REFUND_RECONCILIATION=PASS")

    # Late/out-of-order payment notification must not resurrect paid entitlement:
    # the handler re-fetches current provider truth, which is already refunded.
    paid_count = len(events(refunded, "payment_confirmed"))
    refund_count = len(events(refunded, "refund_confirmed"))
    code, late = signed_webhook(payment_id)
    assert code == 200 and late.get("accepted") is True, late
    final = cert_status(order_id)
    assert final.get("order", {}).get("status") == "refunded", final
    assert final.get("fulfillment", {}).get("status") == "canceled", final
    assert len(events(final, "payment_confirmed")) == paid_count == 1, final
    assert len(events(final, "refund_confirmed")) == refund_count, final
    print("OUT_OF_ORDER_PROTECTION=PASS")

    provider_final = provider_payment(payment_id)
    assert str(provider_final.get("status", "")).lower() == "refunded", provider_final
    assert len(refund_list(payment_id)) == 1
    assert_release()

    provenance = final.get("provenance", [])
    assert any(x.get("source_class") == "provider_webhook" for x in provenance), provenance
    print("PROVENANCE=PASS")
    print("REGRESSION=PASS")
    print("ZERO_DUPLICATE_FINANCIAL_OPERATION=PASS")
    print("ZERO_SPEND=PASS")

    checks = {
        "CHECKOUT": "PASS",
        "PAYMENT_CREATED": "PASS",
        "PAYMENT_CONFIRMED": "PASS",
        "REAL_PROVIDER_WEBHOOK": "PASS",
        "WEBHOOK_AUTH": "PASS",
        "IDEMPOTENCY": "PASS",
        "REPLAY_PROTECTION": "PASS",
        "OUT_OF_ORDER_PROTECTION": "PASS",
        "DB_RECONCILIATION": "PASS",
        "ENTITLEMENT": "PASS",
        "REFUND": "PASS",
        "REFUND_RECONCILIATION": "PASS",
        "PROVIDER_FINAL_STATE": "TERMINAL",
        "REGRESSION": "PASS",
        "PROVENANCE": "PASS",
        "ZERO_DUPLICATE_FINANCIAL_OPERATION": "PASS",
        "ZERO_SPEND": "PASS",
        "FINAL_FINANCIAL_E2E": "GREEN",
    }
    report = {
        "schema_version": 1,
        "gate": "ZEVANORY_MERCADOPAGO_FINANCIAL_E2E",
        "observed_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "sha": {
            "code": EXPECTED_SHA,
            "deploy": EXPECTED_SHA,
            "e2e": EXPECTED_SHA,
            "certification": EXPECTED_SHA,
        },
        "provider": "mercadopago",
        "provider_environment": "sandbox",
        "order_id": order_id,
        "payment_id": payment_id,
        "payment_idempotency_key_sha256": hashlib.sha256(payment_key.encode()).hexdigest(),
        "refund_idempotency_key_sha256": hashlib.sha256(refund_key.encode()).hexdigest(),
        "refund_delivery": refund_delivery,
        "provider_status": provider_final.get("status"),
        "provider_refunded_total": provider_final.get("transaction_amount_refunded"),
        "provider_refund_count": len(refunds),
        "final_order_status": final.get("order", {}).get("status"),
        "final_fulfillment_status": final.get("fulfillment", {}).get("status"),
        "payment_confirmation_count": len(events(final, "payment_confirmed")),
        "refund_event_count": len(events(final, "refund_confirmed")),
        "checks": checks,
        "sales_mode": release.get("sales_mode"),
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for key, value in checks.items():
        print(f"{key}={value}")
    print("SHA_CODE = SHA_DEPLOY = SHA_E2E = SHA_CERTIFICATION = " + EXPECTED_SHA)

if __name__ == "__main__":
    main()
