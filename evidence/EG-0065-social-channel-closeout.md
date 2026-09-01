# EG-0065 — Fechamento de canais comerciais sociais

Data: 2026-09-01
Estado: APROVADO para implementação técnica; credenciais externas continuam fail-closed.

## Evidências independentes
1. TikTok for Developers — Content Posting API / Direct Post: requer token do usuário, escopo `video.publish`, consulta prévia de creator info, consentimento e inicialização via `/v2/post/publish/video/init/`. Clientes não auditados ficam restritos a conteúdo privado.
2. LinkedIn / Microsoft Learn — Posts API: criação de post orgânico via `POST https://api.linkedin.com/rest/posts`, `Authorization: Bearer`, `Linkedin-Version`, `X-Restli-Protocol-Version: 2.0.0`, resposta 201 e ID no header `x-restli-id`.
3. IETF RFC 6750 — Bearer Token Usage: tokens OAuth bearer devem ser tratados como credenciais e transportados em canal TLS, sem exposição em logs ou URLs.

## Decisão
- TikTok usa somente URL HTTPS, fonte previamente verificada e consentimento explícito por publicação.
- Enquanto o cliente TikTok não estiver auditado, o adapter força `SELF_ONLY`; não simula publicação pública.
- LinkedIn exige access token, author URN e versão explícita da API; sucesso só existe com HTTP 201 + `x-restli-id`.
- Afiliados usam adapter webhook HTTPS genérico, autenticado e idempotente, sem acoplar o núcleo a uma rede específica.
- Todos os canais permanecem subordinados a `SALE_GLOBALLY_ENABLED` e `PRE_SALE_GATES_APPROVED`.
