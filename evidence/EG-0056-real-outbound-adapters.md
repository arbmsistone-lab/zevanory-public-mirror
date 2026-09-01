# EG-0056 — Real Outbound Adapters

Status: APROVADO COM RESTRICOES
Data: 2026-09-01

## Evidencias independentes
1. Meta official Postman — WhatsApp Cloud API usa POST /{phone-number-id}/messages, Bearer token, retorna wamid e rastreia status por webhooks.
2. Meta official Instagram Postman — publicacao profissional exige container /media, media publica, /media_publish e status do container; nao existe publicacao de imagem sem media acessivel.
3. Resend official API — envio usa API autenticada e suporta idempotency key; entrega possui eventos/webhooks observaveis.
4. Google YouTube Data API — upload usa videos.insert e requer OAuth 2.0 do proprietario do canal; API key isolada nao autoriza upload.

## Decisao
Adapters reais ficam fora do core agentico, recebem eventos da transactional outbox e repetem gates/credenciais fail-closed antes de qualquer efeito externo.
Resultado HTTP aceito pelo provedor significa somente request aceita; resultado comercial continua dependente de webhook/reconciliacao ou evidencia posterior.

## Restricoes
- Nenhum canal e ativado por esta implementacao.
- Nenhuma credencial e criada, inferida ou embutida no codigo.
- YouTube nao pode ser marcado publish-ready somente com YOUTUBE_API_KEY.
- Instagram exige media_url HTTPS publica; texto isolado nao sera tratado como post publicavel.
- WhatsApp exige gate especifico WHATSAPP_SALES_ENABLED alem dos gates globais.
- Vendas, checkout e eventos financeiros permanecem fail-closed.
