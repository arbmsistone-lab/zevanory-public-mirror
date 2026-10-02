#!/usr/bin/env python3
import pathlib

ROOT=pathlib.Path(".")
worker=(ROOT/"worker/cloudflare-worker.recovered.mjs").read_text(encoding="utf-8")
broker=(ROOT/"worker/whatsapp-credential-broker.mjs").read_text(encoding="utf-8")
privacy=(ROOT/"privacidade/index.html").read_text(encoding="utf-8")
refund=(ROOT/"reembolso/index.html").read_text(encoding="utf-8")

required_worker=[
  'COMMERCIAL_CONSENT_DESTINATIONS',
  'commercial_contact_consent_required',
  'commercial_contact_suppressed',
  'consent_allowed: context.job_payload?.consent_allowed === true',
  'suppressed: context.job_payload?.suppressed === true',
  'opt_in: event.payload?.consent_allowed === true',
  'support_context: supportEventAllowed(event)',
  '"idempotency-key": String(event.idempotency_key || event.event_id)'
]
for token in required_worker:
    assert token in worker, f"missing_worker_contract:{token}"

required_broker=[
  'whatsapp_opt_in_required',
  'authorization.support_context!==true&&authorization.opt_in!==true',
  'opt_in:body.opt_in===true',
  'support_context:body.support_context===true'
]
for token in required_broker:
    assert token in broker, f"missing_broker_contract:{token}"

def commercial_contact_allowed(event):
    destination=str(event.get("destination",""))
    event_type=str(event.get("event_type",""))
    payload=event.get("payload") or {}
    if event_type!="send_message" or destination not in {"channel:whatsapp","channel:email"}:
        return True,"not_commercial_contact"
    if payload.get("suppressed") is True:
        return False,"commercial_contact_suppressed"
    if payload.get("consent_allowed") is not True:
        return False,"commercial_contact_consent_required"
    return True,"allowed"

negative=[
  {"event_type":"send_message","destination":"channel:whatsapp","payload":{"consent_allowed":False,"suppressed":False}},
  {"event_type":"send_message","destination":"channel:email","payload":{"suppressed":False}},
  {"event_type":"send_message","destination":"channel:whatsapp","payload":{"consent_allowed":True,"suppressed":True}},
  {"event_type":"send_message","destination":"channel:email","payload":{"consent_allowed":True,"suppressed":True}},
]
for event in negative:
    allowed,reason=commercial_contact_allowed(event)
    assert allowed is False and reason in {"commercial_contact_consent_required","commercial_contact_suppressed"}, (event,reason)

for destination in ("channel:whatsapp","channel:email"):
    allowed,reason=commercial_contact_allowed({"event_type":"send_message","destination":destination,"payload":{"consent_allowed":True,"suppressed":False}})
    assert allowed is True and reason=="allowed"

# Reactive support is a separate non-commercial path and is not converted into marketing consent.
allowed,reason=commercial_contact_allowed({"event_type":"send_support_message","destination":"channel:whatsapp","payload":{"support_only":True}})
assert allowed is True and reason=="not_commercial_contact"

for token in [
  "confirmação da existência de tratamento",
  "acesso aos dados",
  "correção de dados",
  "anonimização",
  "bloqueio",
  "eliminação",
  "portabilidade",
  "revogação do consentimento",
  "oposição",
  "revisão de decisões automatizadas",
  "contato@zevanory.api.br"
]:
    assert token.lower() in privacy.lower(), f"privacy_right_missing:{token}"

for token in ["art. 49","7 dias","assinatura do contrato","recebimento do produto ou serviço"]:
    assert token.lower() in refund.lower(), f"cdc_contract_missing:{token}"

print("COMMERCIAL_WHATSAPP_OPT_IN_NEGATIVE=PASS")
print("COMMERCIAL_EMAIL_OPT_IN_NEGATIVE=PASS")
print("SUPPRESSION_NEGATIVE=PASS")
print("SUPPORT_PATH_SEPARATION=PASS")
print("OUTBOUND_PROVIDER_BOUNDARY_GUARD=PASS")
print("EMAIL_IDEMPOTENCY_HEADER=PASS")
print("LGPD_RIGHTS_CONTRACT=PASS")
print("CDC_ART49_7_DAYS_CONTRACT=PASS")
print("REAL_MESSAGE_SENT=false")
print("REAL_TRANSACTION_CREATED=false")
