# EG-0075 — Nuvemshop OAuth + Webhook Hardening

Status: APPROVED para hardening tecnico. NAO constitui prova de autorizacao do lojista nem habilita vendas.
Data: 2026-09-12

## Escopo
Fechar a superficie tecnica Nuvemshop sem fabricar credenciais, sem contornar login/consentimento do lojista e sem alterar os kill-switches comerciais.

## Evidence Gate 3X
1. Nuvemshop DevHub — documentacao primaria: OAuth 2 Authorization Code, `user_id` como store ID e access token sem expiracao ate renovacao/desinstalacao. Fonte: https://dev.nuvemshop.com.br/docs/applications/authentication
2. IETF — RFC 6749, fonte primaria independente para Authorization Code e protecao do fluxo OAuth 2. Fonte: https://www.rfc-editor.org/rfc/rfc6749
3. Evidencia operacional ZEVANORY — em 2026-09-12 o dominio canonico retornou 302 de `/api/oauth/nuvemshop/start` para o app Nuvemshop 41672, o callback informou `authorization_enabled:true`, e consulta read-only ao banco canonico encontrou zero credenciais Nuvemshop persistidas. Essa evidencia prova configuracao do app, mas tambem prova que autorizacao do lojista ainda nao ocorreu.

## Evidencia complementar de seguranca/provedor
- Nuvemshop API documenta assinatura `x-linkedstore-hmac-sha256` calculada sobre o corpo bruto com o secret da app, eventos `app/suspended`, `app/uninstalled` e requisito de idempotencia. Fonte: https://nuvemshop.dev/api/resources/2025-03/webhook
- Diretrizes Nuvemshop exigem webhooks de ciclo de vida e LGPD para apps no Brasil. Fonte: https://dev.nuvemshop.com.br/docs/erp-guide/guidelines

## Implementacao aprovada
- receptor dedicado de webhook Nuvemshop usando HMAC-SHA256 sobre raw body e comparacao constant-time;
- revogacao fail-closed da credencial local em `app/suspended`, `app/uninstalled` e `app/store_redact`;
- provisionamento idempotente automatico dos webhooks operacionais depois do OAuth;
- User-Agent institucional identificavel;
- nenhum webhook, OAuth ou fallback habilita venda;
- nenhuma credencial e inventada ou armazenada em claro.

## Limite da prova
Este gate fecha o codigo e a seguranca da integracao. A frente so pode ser declarada `connected` quando existir credencial OAuth real persistida apos consentimento do lojista e a API Nuvemshop aceitar a prova read-only da loja/escopos/webhooks.
