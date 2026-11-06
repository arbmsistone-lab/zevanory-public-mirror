# R137 | DEC-22 P04-CANAIS | Proposta DRAFT

Não aprovado para merge/deploy. Contenção por código (DEC22_DRAFT_ONLY constante, sem chave de reativação em ambiente). Gera rascunhos privados para motor de aquisição Telegram/Bluesky, Pinterest legado, crosspost TikTok/Telegram-vídeo/Instagram/Facebook, e CLI YouTube. Não publica. Relatório de conteúdo muda ATIVA para BLOQUEADA e reclassifica approved_for_autopublish como rascunho para revisão no e-mail.

P04 Meta: o adaptador de eventos possui o bloqueio `p04_meta_closed` testado em `tests/sales-lock-publishers.test.mjs`, mas `scripts/channels/short-crosspost.mjs` possui outro caminho direto via Graph API. Este PR contém o orquestrador crosspost antes de qualquer chamada; não declara P04 globalmente homologado.

Cron `5,35 * * * *` chama `runAcquisitionEngine` no minuto :35 (12h35 Telegram, 19h35 Bluesky BRT). Recibos canônicos: `zpc:acquisition:daily:<dia>:telegram` e `zpc:multichannel:evidence:telegram:daily:<dia>`. Sem acesso direto ao KV/conta Telegram, quantidade, IDs e textos de publicações desde 01/11 NÃO COMPROVADOS. Não inventar zero.

Pausa sem deploy: `zpc:creative-autonomy:paused:v1=1`, via `setCreativeAutopublishPaused`, bloqueia aquisição Telegram/Bluesky e Pinterest legado, mas não prova cobertura de scripts GitHub Actions de vídeo. Não execute configuração sem autorização.

Protocolo `ZEV-20261106-DA2F6F3C54` no Neon segue owner/customer pending, attempts=1/1, last_error=resend_network, next_attempt_at 11:38:24Z, updated_at 11:36:24Z, lease_until null. Sem logs do Cloudflare não é possível provar execução do cron 14:00Z ou distinguir cron ausente de falha antes do dreno. Janela 23h desde 11:36:23Z, vence por volta de 10:36:23Z em 07/11 (07:36 BRT).

**NO-GO até contra-auditoria e CI:** testes legados esperam autopublicação; atualizar contrato sem apagá-los. Bloquear todos os adaptadores de envio direto e revisar todos os workflows externos antes de considerar a DEC-22 fechada. Nenhuma produção alterada pelo PR Draft.
