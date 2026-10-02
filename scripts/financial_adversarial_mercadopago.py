#!/usr/bin/env python3
import importlib.util
import json
import pathlib
import re
import time
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[1]
BASE_PATH = ROOT / "scripts" / "financial_e2e_mercadopago.py"

spec = importlib.util.spec_from_file_location("mp_base", BASE_PATH)
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)

def sandbox_fixture_from_existing_test():
    src = BASE_PATH.read_text(encoding="utf-8")
    def one(pattern):
        m = re.search(pattern, src)
        assert m, pattern
        return m.group(1)
    return {
        "card_number": one(r'"card_number":\s*"([^"]+)"'),
        "security_code": one(r'"security_code":\s*"([^"]+)"'),
        "expiration_month": int(one(r'"expiration_month":\s*(\d+)')),
        "expiration_year": int(one(r'"expiration_year":\s*(\d+)')),
        "cpf": one(r'"number":\s*"([^"]+)"'),
    }

def declined_card_token():
    fixture = sandbox_fixture_from_existing_test()
    _, card = base.mp(
        "/v1/card_tokens",
        "POST",
        {
            "card_number": fixture["card_number"],
            "security_code": fixture["security_code"],
            "expiration_month": fixture["expiration_month"],
            "expiration_year": fixture["expiration_year"],
            "cardholder": {
                "name": "OTHE",
                "identification": {"type": "CPF", "number": fixture["cpf"]},
            },
        },
        ok=(200, 201),
    )
    token = str(card.get("id", ""))
    assert token and card.get("status") == "active", card
    return token, fixture

def declined_payment(order_id, amount):
    token, fixture = declined_card_token()
    _, payment = base.mp(
        "/v1/payments",
        "POST",
        {
            "transaction_amount": float(amount),
            "token": token,
            "description": "ZEVANORY declined certification sandbox",
            "installments": 1,
            "payment_method_id": "visa",
            "binary_mode": True,
            "external_reference": "ZEVANORY:EXP-0001:" + order_id,
            "notification_url": base.APP + "/api/webhooks?provider=mercadopago_test",
            "payer": {
                "email": "test@testuser.com",
                "identification": {"type": "CPF", "number": fixture["cpf"]},
            },
            "metadata": {"zevanory_order_id": order_id, "certification": True},
        },
        {"x-idempotency-key": str(uuid.uuid4())},
        ok=(200, 201),
    )
    assert str(payment.get("status", "")).lower() in ("rejected", "cancelled"), payment
    return str(payment.get("id", ""))

def main():
    # Existing test proves: invalid signature, approved, event replay/idempotency,
    # refund, provider truth, DB reconciliation and late/out-of-order protection.
    base.main()

    invite = base.create_invite()
    _, checkout = base.create_checkout(
        invite["token"], str(uuid.uuid4()), str(uuid.uuid4()), ok=(201,)
    )
    order_id = str(checkout["order_id"])
    before = base.cert_status(order_id)
    amount = float(before["order"]["amount"])
    payment_id = declined_payment(order_id, amount)
    time.sleep(5)
    after = base.cert_status(order_id)
    assert after.get("order", {}).get("status") != "paid", after
    assert len(base.events(after, "payment_confirmed")) == 0, after
    print("MERCADOPAGO_DECLINED_PAYMENT=PASS")
    print("MERCADOPAGO_SIGNATURE_VERIFICATION=PASS")
    print("MERCADOPAGO_EVENT_IDEMPOTENCY=PASS")
    print("MERCADOPAGO_REFUND=PASS")
    print("MERCADOPAGO_DUPLICATE=PASS")
    print("MERCADOPAGO_OUT_OF_ORDER=PASS")
    print("MERCADOPAGO_ADVERSARIAL_MATRIX=GREEN")

if __name__ == "__main__":
    main()
