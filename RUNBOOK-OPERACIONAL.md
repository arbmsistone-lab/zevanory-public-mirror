# ZEVANORY - RUNBOOK OPERACIONAL

Status: obrigatorio para operacao estrutural.
Escopo: infraestrutura, saude, deploy, incidente, recuperacao e garantia operacional. Vendas permanecem fora de escopo.

## Fonte de verdade
- Raiz canonica: `C:\Sistemas\ZEVANORY`.
- Producao oficial: `https://zevanory.api.br`.
- Release estrutural corrente: `ZEVANORY-EG0039-FINAL` apos promocao auditada.
- Schema corrente: 17 tabelas e migrations 001-011.
- Deploy somente de snapshot auditado e commitado.
- Divergencia entre Git, release, schema e dominio bloqueia promocao.
- Os cinco kill-switches comerciais/financeiros permanecem `false`.

## Verificacoes de saude
1. `/api/live` deve responder HTTP 200.
2. `/api/health` deve responder HTTP 200 e `ready=true`.
3. Banco, URL oficial, schema 17x11 e commercial safety devem estar validos.
4. `/api/release` deve corresponder ao commit promovido.
5. `/api/status` deve expor apenas agregados sem PII.
6. `/api/assurance` deve expor SLO objectives, outbox, agent health e contratos.
7. Dead-letter > 0 ou outbox pendente mais antiga > 300 s exige investigacao.
8. Objetivos de SLO nunca sao declarados historicamente atingidos sem janela de medicao suficiente.

## Incidente
1. Nao habilitar vendas para testar recuperacao.
2. Capturar release, deployment, request-id, rota e erro antes de alterar codigo.
3. Classificar falha entre compute, banco/schema, integracao, outbox, IA ou dominio.
4. Se producao divergir do snapshot auditado, bloquear promocao.
5. Corrigir na raiz canonica e repetir testes, auditorias e prova operacional.

## Recuperacao e rollback
1. Preferir rollback para deployment previamente `READY` e auditado.
2. Apos rollback, validar `/`, `/api/live`, `/api/health`, `/api/release`, `/api/status` e `/api/assurance`.
3. Confirmar schema 17x11 e kill-switches bloqueados.
4. Para desastre de dados, usar Neon PITR/Branch Restore dentro da retencao contratada.
5. Validar o ponto de recuperacao em branch/time-travel isolado antes de restaurar producao.
6. `scripts/dr-rehearsal.mjs` reconstrui migrations 001-011 em schema isolado e exige `ROLLBACK`.
7. Medir duracao do rehearsal como evidencia de RTO tecnico; nao confundir rehearsal com RTO contratual de producao.
8. Registrar causa, recovery point, duracao, resultado e prova operacional.

## Observabilidade e SLO
- Politica canonica: `specs/SLO_POLICY.md`.
- Monitor recorrente: `.github/workflows/production-monitor.yml`.
- `npm run probe:production`: live, health, release e status.
- `npm run load:smoke`: carga read-only limitada e amostra de latencia/erro.
- `npm run contract:smoke`: contratos de fornecedores e limites do core.
- `npm run supplychain:scan`: segredos acidentalmente versionados.
- Logs estruturados usam `x-request-id` e nao devem incluir segredo ou PII.

## Transactional outbox
- Backlog = pending + retry.
- Estado saudavel exige dead-letter=0 e idade maxima pendente <= 300 s.
- Retry permanece exponencial e limitado.
- Reprocessamento de dead-letter exige operador autenticado e causa registrada; nunca executar silenciosamente.

## IA e degradacao
- Gemini continua opcional.
- Ausencia ou falha do provider deve degradar para fallback deterministico seguro.
- Acoes comerciais e financeiras continuam subordinadas aos gates existentes.
- Falhas, bloqueios e fallback devem ser observaveis; nenhuma metrica de IA prova ganho comercial sem baseline real.

## Ativacao comercial controlada
1. Executar `npm run activation:check` e revisar `/api/activation/readiness`.
2. Nao prosseguir enquanto `inputs_ready=false` ou houver blocker legal, fiscal, de fornecedor, pagamento ou afiliacao.
3. Preencher somente dados reais e verificaveis; nunca usar placeholder para obter PASS.
4. Quando `inputs_ready=true`, manter `SALE_GLOBALLY_ENABLED=false` durante toda a pre-validacao.
5. Liberar `PRE_SALE_GATES_APPROVED=true` e apenas os canais realmente necessarios ao tipo de oferta.
6. Confirmar novamente health, assurance, checkout fail-closed, autenticacao do worker e conciliacao do provedor.
7. `SALE_GLOBALLY_ENABLED=true` e o ultimo passo de cutover.
8. A primeira transacao real deve ser piloto, reconciliada pelo provedor e auditada antes de qualquer escala.

## Rollback comercial imediato
1. Definir `SALE_GLOBALLY_ENABLED=false` primeiro.
2. Definir `CHECKOUT_ENABLED=false`, `WHATSAPP_SALES_ENABLED=false` e `FINANCIAL_EVENTS_ENABLED=false`.
3. Definir `PRE_SALE_GATES_APPROVED=false`.
4. Validar `/api/config`, `/api/activation/readiness`, checkout 503 fail-closed e ausencia de execucao comercial do agente.
5. Preservar telemetria e evidencias para diagnostico; nao apagar eventos para esconder falha.
