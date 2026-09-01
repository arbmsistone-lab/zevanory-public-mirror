# EG-0067 - Meta live provider binding

Date: 2026-09-01
Scope: Facebook Page + WhatsApp Cloud API identity binding for ZEVANORY.

## Evidence A - Meta Business provider UI
- Business portfolio: `Zevanory` (`1761411121675273`).
- System user: `ZEVANORY Automation` (`61593719413627`).
- Facebook Page assigned: `Zevanory`.
- Official WhatsApp Business Account: `1765777697944833`.
- Official number shown by Meta: `+55 88 9234-0423`.
- Provider status shown: `Conectado`; quality shown: `Alta`.
- Empty legacy WABA `1404625201569121` was removed from ZEVANORY Automation.

## Evidence B - Meta Graph API v26.0
A freshly generated 60-day System User token was used only in memory.
Provider responses matched:
- System user name: `ZEVANORY Automation`.
- Facebook Page ID: `1249902628211703`; name: `Zevanory`.
- WABA ID: `1765777697944833`.
- Phone Number ID: `1207377742466921`.
- Display number: `+55 88 9234-0423`.
- WhatsApp quality: `GREEN`.
- Provider verified name still returned `Giro Local`.
- Name status returned `AVAILABLE_WITHOUT_REVIEW`.
- Page response had no linked `instagram_business_account`.

## Evidence C - Vercel production runtime
Production Secrets/config now include:
- `META_ACCESS_TOKEN` (Secret).
- `WHATSAPP_ACCESS_TOKEN` (Secret).
- `META_PAGE_ID=1249902628211703` stored through Vercel env.
- `WHATSAPP_PHONE_NUMBER_ID=1207377742466921` stored through Vercel env.
- `META_VERIFY_TOKEN` already installed.
- Production redeployed and aliased to `https://zevanory.api.br`.

## Result
- Facebook provider identity: VERIFIED for Page ZEVANORY.
- WhatsApp provider identity: VERIFIED for the official number.
- WhatsApp outbound Cloud API credentials: CONFIGURED, commercial gates remain OFF.
- Instagram provider binding: NOT VERIFIED; Page has no linked Instagram Business Account.
- Meta inbound webhook: NOT fully certified until `META_APP_SECRET` is installed and provider webhook registration is verified.
- WhatsApp public display-name migration is NOT complete while Meta still returns `verified_name=Giro Local`.

No token, App Secret, password, OTP or other credential value is stored in this evidence.
