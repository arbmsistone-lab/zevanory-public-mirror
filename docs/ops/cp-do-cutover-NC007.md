# NC-007/N3 | Conteúdo Pronto DO SQLite | Plano de corte NO-GO

**Situação:** implementação de ledger/outbox em PR Draft sobre #960. Não instalada em Cloudflare, banco real ou KV. Nenhum cliente migrou.

## Implementado nesta etapa
- `worker/cp-durable-ledger.mjs`: tabelas SQLite localizadas por DO, ledger `UNIQUE(event_key)`, outbox `UNIQUE(cycle)` + `UNIQUE(provider_idempotency_key)`, versão monotônica, bloqueio de eventos stale, reembolso sticky, recibos externos e estado `uncertain` para falha ambígua de envio.
- `scripts/cp-durable-ledger.test.mjs`: nove testes R11 com SQLite nativo do Node, sem rede, tokens ou registros reais.
- `cp-do-ledger-gate.yml`: testes do núcleo e guarda **intencionalmente bloqueante** enquanto `worker/content-service.mjs` continuar gravando estado canônico em KV. Não converter 9/9 em homologação do serviço.

## Antes de considerar N3 concluída, falta executar em branch separada
1. Criar contrato de binding DO SQLite no Wrangler canônico da arquitetura `zevanory` com `new_sqlite_classes` (ou `exports`, conforme config real) e sem criar namespace em Cloudflare sem autorização. Usar DO por chave interna determinística (hash do `subscription.subscriber.code` obtido após autenticar o Hottok), nunca pela entrada livre do cliente.
2. Refatorar `handleHotmartWebhook` em `worker/content-service.mjs`: antes de efeito colateral, processar evento via DO com `event_key` transacional e estado do assinante. Remover `kv.put` de chaves `zpc:cp:sub:` e dedupe `zpc:cp:txn:`. Não mandar e-mail antes de gravar outbox.
3. Refatorar `retryPendingPackages` (cron), funções `generateAndDeliver`, briefing/campanha, `handleContentOperator`, reembolso, reversão e confirmação de entrega para usar somente o DO; eliminar gravações canônicas KV e os índices globais concorrentes `zpc:cp:pending`, `welcome-outbox`, `refund-requests`, `credit-index` enquanto forem fonte de verdade. Se o estado DO estiver indisponível, responder 503/409 e RETER, sem tentar KV.
4. Resolver a integração entre DO transacional e envio Resend de forma não-duplicável: `provider_idempotency_key` e recibo persistidos. Envio incerto => `uncertain`, reconciliar no provedor antes de tentar de novo.
5. Instrumentar auditoria append-only diária do ledger de todos os DOs sem tornar `GET /internal/events` público. O integrador precisa autenticação interna, identidade não derivada de payload livre e autorização de operador.
6. Testar histórico sintético compatível com `#960`, resolver referências `zpc:cp:token:`/pacotes sem quebrar entrega existente. Após autorização do proprietário, preparar importação com hashes e contagens, dual-read somente, rollback documental e corte atômico. Não migrar dados reais agora.
7. Rodar 9 testes R11 contra **todos os escritores e rotas reais**, duas regiões/múltiplos POPs e mock de crash, e mutantes reais de gates com falha de asserção. Testes de core isolado **não substituem** integração ou concorrência real.
8. Revalidar cotas Free do DO e da conta, custo zero, rollback, FIRES_ON_MERGE e impacto #960 / #963 / #964. Confirmar com proprietário antes de provisionar.
9. Proibir a reabertura do Conteúdo Pronto antes de ticket de aprovação do proprietário e a ordem geral `LIBERAR VENDAS`.

## Regras preservadas
O ledger DO é servidor-servidor; nenhum `subscriber_id` escolhido pelo cliente é aceito no corpo. O código do núcleo não importa KV, não possui credenciais e não publica. A exposição do stub pelo Worker principal requer guardas de autenticação que ainda não estão implementadas.

**NC-007 N3:** núcleo em elaboração, integração PENDENTE, gate intencionalmente FAIL/NO-GO, sem deploy.
