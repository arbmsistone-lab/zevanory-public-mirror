#!/usr/bin/env python3
import hashlib
import hmac
import importlib.util
import json
import os
import pathlib
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[1]
BASE_PATH = ROOT / "scripts" / "financial_e2e_stripe.py"
spec = importlib.util.spec_from_file_location("stripe_base", BASE_PATH)
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)

WEBHOOK_SECRET = os.environ["STRIPE_WEBHOOK_SECRET"].strip()

def signed_webhook(event, *, valid=True, ok=(200,)):
    raw = json.dumps(event, separators=(",", ":")).encode("utf-8")
    ts = int(time.time())
    digest = hmac.new(WEBHOOK_SECRET.encode(), f"{ts}.".encode() + raw, hashlib.sha256).hexdigest()
    if not valid:
        digest = "0" * len(digest)
    req = urllib.request.Request(
        base.APP + "/api/webhooks?provider=stripe",
        method="POST",
        headers={
            "accept": "application/json",
            "content-type": "application/json",
            "stripe-signature": f"t={ts},v1={digest}",
            "user-agent": "ZEVANORY-Stripe-Adversarial/1.0",
        },
        data=raw,
    )
    try:
        with urllib.request.urlopen(req, timeout=40) as res:
            body = json.loads(res.read().decode("utf-8", "replace") or "{}")
            assert res.status in ok, (res.status, body)
            return res.status, body
    except urllib.error.HTTPError as exc:
        body = json.loads(exc.read().decode("utf-8", "replace") or "{}")
        assert exc.code in ok, (exc.code, body)
        return exc.code, body

def new_checkout(invite_token):
    rid, sid = str(uuid.uuid4()), str(uuid.uuid4())
    _, checkout = base.app(
        "/api/checkout/stripe",
        "POST",
        {"x-certification-pilot-token": invite_token},
        {"request_id": rid, "session_id": sid, "offer_id": "OFFER-0001"},
        ok=(201,),
    )
    return rid, sid, checkout

def find_event(payment_intent_id, event_type):
    def probe():
        _, listing = base.stripe(
            "/events?" + urllib.parse.urlencode({"type": event_type, "limit": 25}),
            ok=(200,),
        )
        for event in listing.get("data", []):
            obj = event.get("data", {}).get("object", {})
            if str(obj.get("id", "")) == payment_intent_id:
                return event
        return None
    return base.wait("stripe_event_lookup", probe, timeout=120)

def main():
    assert base.KEY.startswith("sk_test_")
    assert WEBHOOK_SECRET.startswith("whsec_")
    _, release = base.app("/api/release", ok=(200,))
    assert release.get("deployment", {}).get("commit_sha", "").lower() == base.EXPECTED_SHA
    assert release.get("sales_mode") == "globally-blocked"

    # Explicit signature rejection before any order mutation.
    bad_event = {
        "id": "evt_zevanory_bad_" + uuid.uuid4().hex,
        "type": "payment_intent.succeeded",
        "data": {"object": {"id": "pi_invalid"}},
    }
    code, bad = signed_webhook(bad_event, valid=False, ok=(401,))
    assert code == 401 and bad.get("error") == "webhook_auth_failed", bad
    print("STRIPE_SIGNATURE_INVALID_REJECTED=PASS")

    _, invite = base.app(
        "/api/internal/certification/e2e/invite",
        "POST",
        {"x-certification-e2e-token": base.CERT},
        {},
        ok=(201,),
    )
    token = invite["token"]

    # Declined payment: provider refusal must not become financial truth.
    _, _, declined_checkout = new_checkout(token)
    declined_oid = str(declined_checkout["order_id"])
    declined_pi = str(declined_checkout["payment_intent_id"])
    code, declined = base.call(
        base.STRIPE + "/payment_intents/" + urllib.parse.quote(declined_pi) + "/confirm",
        "POST",
        {"authorization": "Bearer " + base.KEY},
        {"payment_method": "pm_card_visa_chargeDeclined"},
        True,
        ok=(402,),
    )
    assert code == 402, declined
    time.sleep(4)
    declined_state = base.status(declined_oid)
    assert declined_state.get("order", {}).get("status") != "paid", declined_state
    assert len(base.events(declined_state, "payment_confirmed")) == 0, declined_state
    print("STRIPE_DECLINED_PAYMENT=PASS")

    # Approved payment and checkout request-id idempotency.
    rid, sid, checkout = new_checkout(token)
    oid, pi = str(checkout["order_id"]), str(checkout["payment_intent_id"])
    _, duplicate = base.app(
        "/api/checkout/stripe",
        "POST",
        {"x-certification-pilot-token": token},
        {"request_id": rid, "session_id": sid, "offer_id": "OFFER-0001"},
        ok=(200,),
    )
    assert duplicate.get("duplicate") is True and duplicate.get("order_id") == oid, duplicate
    print("STRIPE_CHECKOUT_IDEMPOTENCY=PASS")

    _, confirmed = base.stripe(
        "/payment_intents/" + urllib.parse.quote(pi) + "/confirm",
        "POST",
        {"payment_method": "pm_card_visa"},
        idem="zevanory-adversarial-confirm-" + oid,
    )
    assert confirmed.get("status") == "succeeded", confirmed
    paid = base.wait(
        "stripe_payment_webhook",
        lambda: (lambda s: s if s.get("order", {}).get("status") == "paid"
                 and len(base.events(s, "payment_confirmed")) == 1 else None)(base.status(oid)),
        timeout=240,
    )
    print("STRIPE_APPROVED_PAYMENT=PASS")

    # Replay the actual provider event ID twice with a valid signature.
    real_event = find_event(pi, "payment_intent.succeeded")
    event_id = str(real_event["id"])
    replay_event = {
        "id": event_id,
        "type": "payment_intent.succeeded",
        "data": {"object": {"id": pi}},
    }
    for _ in range(2):
        code, replay = signed_webhook(replay_event, valid=True, ok=(200,))
        assert code == 200 and replay.get("accepted") is True and replay.get("duplicate") is True, replay
    after_replay = base.status(oid)
    assert len(base.events(after_replay, "payment_confirmed")) == 1, after_replay
    print("STRIPE_EVENT_IDEMPOTENCY=PASS")
    print("STRIPE_DUPLICATE_REPLAY=PASS")

    # Refund, then submit a validly signed but late payment event under a new event ID.
    _, refund = base.stripe(
        "/refunds",
        "POST",
        {"payment_intent": pi},
        idem="zevanory-adversarial-refund-" + oid,
    )
    assert str(refund.get("id", "")).startswith("re_"), refund
    refunded = base.wait(
        "stripe_refund_webhook",
        lambda: (lambda s: s if s.get("order", {}).get("status") == "refunded"
                 and s.get("fulfillment", {}).get("status") == "canceled"
                 and len(base.events(s, "refund_confirmed")) >= 1 else None)(base.status(oid)),
        timeout=240,
    )
    print("STRIPE_REFUND=PASS")

    late_event = {
        "id": "evt_zevanory_outoforder_" + uuid.uuid4().hex,
        "type": "payment_intent.succeeded",
        "data": {"object": {"id": pi}},
    }
    code, late = signed_webhook(late_event, valid=True, ok=(409,))
    assert code == 409 and late.get("error") == "order_state_invalid", late
    final = base.status(oid)
    assert final.get("order", {}).get("status") == "refunded", final
    assert final.get("fulfillment", {}).get("status") == "canceled", final
    assert len(base.events(final, "payment_confirmed")) == 1, final
    print("STRIPE_OUT_OF_ORDER=PASS")
    print("STRIPE_SIGNATURE_VERIFICATION=PASS")
    print("STRIPE_ADVERSARIAL_MATRIX=GREEN")

if __name__ == "__main__":
    main()
