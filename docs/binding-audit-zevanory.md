# Auditoria de bindings do Worker `zevanory`

Inventário obtido da API de settings do Worker e confrontado com `worker/**` e `wrangler*.toml|jsonc`. A cota contém 64 variáveis. Os quatro bindings de recurso (`AI`, `ASSETS`, `SELF`, `ZEVANORY_PRIVATE_ARTIFACTS`) não entram nessa contagem.

| Nome | Classificação |
|---|---|
| `ABSOLUTE_RELEASE_APPROVED` | em uso |
| `ACTIVE_OFFER_TYPE` | em uso |
| `AGENT_AI_ENABLED` | em uso |
| `AGENT_AI_MAX_RUNS_PER_HOUR` | em uso |
| `AGENT_AUTONOMY_MODE` | em uso |
| `AGENT_HUMAN_APPROVAL_REQUIRED` | em uso |
| `ARBM_SIST_PRIVATE_PILOT_DELIVERY_APPROVED` | duplicado: consolidado em `ZEVANORY_RUNTIME_CONFIG` |
| `ARBM_SIST_SECURE_ARTIFACT_READY` | duplicado: consolidado em `ZEVANORY_RUNTIME_CONFIG` |
| `ASAAS_API_KEY` | em uso |
| `ASAAS_ENV` | em uso |
| `ASAAS_WEBHOOK_TOKEN` | em uso |
| `CERTIFICATION_E2E_TOKEN` | em uso |
| `CERTIFICATION_PILOT_APPROVER` | em uso |
| `CERTIFICATION_PILOT_ENABLED` | em uso |
| `CERTIFICATION_PILOT_ENV` | em uso |
| `CHECKOUT_ENABLED` | em uso |
| `COMPLIANCE_RUNTIME_ALLOWED_ORIGINS` | em uso |
| `COMPLIANCE_RUNTIME_MODE` | em uso |
| `COMPLIANCE_RUNTIME_ORIGIN` | em uso |
| `COMPLIANCE_RUNTIME_ORIGIN_RELEASE_ID` | em uso |
| `COMPLIANCE_RUNTIME_ORIGIN_VERIFIED` | em uso |
| `DATABASE_URL` | em uso |
| `ELITE_INTERNAL_TOKEN` | em uso |
| `FINANCIAL_EVENTS_ENABLED` | em uso |
| `FULFILLMENT_OPERATOR_TOKEN` | em uso |
| `GEMINI_FREE_TIER_CONFIRMED` | duplicado: consolidado em `ZEVANORY_RUNTIME_CONFIG` |
| `MERCADOLIVRE_CLIENT_SECRET` | em uso |
| `MERCADOLIVRE_TOKEN_ENCRYPTION_KEY` | em uso |
| `MERCADOPAGO_ACCESS_TOKEN` | em uso |
| `MERCADOPAGO_ENV` | em uso |
| `MERCADOPAGO_TEST_ACCESS_TOKEN` | em uso |
| `MERCADOPAGO_TEST_WEBHOOK_SECRET` | em uso |
| `MERCADOPAGO_WEBHOOK_SECRET` | em uso |
| `META_APP_SECRET01` | em uso |
| `META_VERIFY_TOKEN` | em uso |
| `NUVEMSHOP_APP_ID` | em uso |
| `OFFER_SELECTION_APPROVED` | em uso |
| `OPERATOR_TOKEN` | em uso |
| `ORGANIC_PUBLISHING_ENABLED` | em uso |
| `OWNER_DASHBOARD_SECRET` | em uso |
| `PAYMENT_MERCHANT_IDENTITY_VERIFIED` | em uso |
| `PAYMENT_PROVIDER` | em uso |
| `PAYMENT_PUBLIC_BASE_URL` | em uso |
| `PAYMENT_RUNTIME_MODE` | em uso |
| `PRE_SALE_GATES_APPROVED` | em uso |
| `PUBLIC_BASE_URL` | em uso |
| `RESEND_API_KEY` | em uso |
| `RESEND_WEBHOOK_SECRET` | em uso |
| `SALE_GLOBALLY_ENABLED` | em uso |
| `SERVICE_DELIVERY_MODE` | em uso |
| `SUPPORT_CHANNEL` | duplicado de `ZEVANORY_WHATSAPP_DISPLAY` |
| `VOICE_TTS_FAILOVER_ENABLED` | duplicado: consolidado em `ZEVANORY_RUNTIME_CONFIG` |
| `VOICE_TTS_FREE_ONLY` | em uso |
| `VOICE_TTS_RELAY_URL` | em uso |
| `WHATSAPP_SALES_ENABLED` | em uso |
| `ZEVANORY_ADMIN_PASSWORD` | em uso |
| `ZEVANORY_ADMIN_USERNAME` | em uso |
| `ZEVANORY_DEPLOYMENT_ENV` | em uso |
| `ZEVANORY_PRODUCT_HANDOFF_V21_VERIFIED` | em uso |
| `ZEVANORY_RELEASE_REF` | em uso |
| `ZEVANORY_RELEASE_SHA` | em uso |
| `ZEVANORY_RUNTIME_CONFIG` | em uso |
| `ZEVANORY_SECURE_ARTIFACT_DELIVERY_READY` | em uso |
| `ZEVANORY_WHATSAPP_DISPLAY` | em uso |

## Consolidação planejada

Os cinco aliases `plain_text` classificados como duplicados deixam de ocupar slots próprios. Seus valores permanecem disponíveis via `ZEVANORY_RUNTIME_CONFIG`, exceto `SUPPORT_CHANNEL`, cujo consumidor já cai para `ZEVANORY_WHATSAPP_DISPLAY`. `CHANNEL_CREDENTIALS_JSON` adiciona um único secret. Resultado planejado: **60 variáveis**, com **4 slots de folga**. Deploys não removem secrets; somente variáveis `plain_text` ausentes do manifesto são reconciliadas.
