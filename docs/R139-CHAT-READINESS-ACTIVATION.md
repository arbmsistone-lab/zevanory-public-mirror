# R139 | Consolidação do chat #973 e plano de ativação em duas fases

Base canônica gh-pages: 2c19921f76581d9716241336d5c17af2e9f02dac. Este PR permanece Draft, sem merge, deploy ou ativação.

## Homologação oficial existente
Protocolo ZEV-20261106-DA2F6F3C54 em zevanory-db-2: owner_status=sent, customer_status=sent, tentativas 1/1, updated_at=2026-11-06T16:00:58.308Z (13:00:58 BRT), lease_until null. O campo last_error=resend_network conserva o erro histórico, apesar da entrega. O proprietário confirmou no Gmail ambos os e-mails. Adendo R139 anotado no B3 via comentário de auditoria.

## Encadeamento canônico e prova
Com SITE_CHAT_OFFICIAL_PROTOCOLS=true, /api/chat/handoff exige privacy_ack e email e executa registerOfficialAtendimento (registerRequest de atendimento.mjs), gerando o mesmo ZEV e a outbox zevanory_atendimento_outbox. Nenhum ticket ZC nem mensagem paralela de chat. O R138 isolou a retentativa em /api/internal/atendimento/outbox/drain, autenticado e acionado via SELF antes dos cron jobs pesados. O teste PostgreSQL real tests/integration/r122-official-chat-postgres.test.mjs valida chat -> registro oficial -> outbox -> dois envios simulados, e tests/r122-official-chat-handoff.test.mjs protege o encadeamento com SELF. Sem teste E2E de um chat real ainda.

## Configurações e comprovação
Obrigatórias: SITE_CHAT_ENABLED (flag OFF em A); SITE_CHAT_OFFICIAL_PROTOCOLS (true só em B); SITE_CHAT_TURNSTILE_SECRET para siteverify e SITE_CHAT_TURNSTILE_SITEKEY para o widget; ZEVANORY_PRIVATE_ARTIFACTS com site-chat:kill:v1 e demais flags; DATABASE_URL; LEAD_PRIVACY_SECRET e SITE_CHAT_HASH_SECRET opcional para pseudonimização; RESEND_API_KEY e SUPPORT_FORWARD_TO (ou KV support-config:forward-to); rotas ligadas ao Worker zevanory e SELF. AI Workers binding e SITE_CHAT_GENERATIVE são opcionais: se ausentes, somente respostas determinísticas. SITE_CHAT_SANDBOX não deve estar ativo em produção. Verificar nomes e valores ao vivo por readback, não inferir segredos a partir do repositório. Neurônios: reservados até 6000/dia no chat e 160/chamada, com orçamento global do Workers AI controlado pela plataforma; ativação sem custo adicional requer comprovação de cota disponível.

## Etapas futuras, com autorização específica cada uma
A) Após CI verde e auditoria independente, autorizar merge e posteriormente deploy separado com SITE_CHAT_ENABLED ausente/false; SITE_CHAT_OFFICIAL_PROTOCOLS ausente/false. Verificar status disabled e ausência de widget na página institucional; outbox SELF e vendas fechadas preservadas.
B) Conferir Turnstile sitekey/secret/hostname, KV kill switch, binding AI e orçamento, Resend e DB; autorizar flags SITE_CHAT_OFFICIAL_PROTOCOLS=true e SITE_CHAT_ENABLED=true, manter SITE_CHAT_GENERATIVE=false no teste inicial. Uma conversa real autorizada, um escalonamento com privacidade, protocolo ZEV, dois e-mails Resend/Gmail, owner/customer sent no Neon, sem ZC paralelo, readback de flag e log SELF. Rollback por SITE_CHAT_ENABLED=false e/ou KV site-chat:kill:v1=off, readback imediato, sem apagar filas ou dados. Não tocar nas vendas.

**NO-GO até CI verde, bind readbacks e autorização separada.**
