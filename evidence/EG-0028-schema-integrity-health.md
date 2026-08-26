# EG-0028 — INTEGRIDADE DE SCHEMA NO HEALTH

Status: IMPLEMENTADO / PENDENTE DE PROMOCAO.
Escopo: estrutura e recuperacao; vendas fora de escopo.

## Evidencias independentes
1. O schema local define `schema_migrations`, `telemetry_events`, `financial_events` e `orders`.
2. O ledger canonico exige migrations 001 a 005.
3. `/api/health` agora valida conexao, tabelas e ledger de migrations antes de `ready=true`.

## Implementacao
- `src/schemaHealth.mjs` centraliza o contrato de integridade.
- `api/health.mjs` consulta somente metadados e migration IDs; nenhuma mutacao ocorre.
- `src/systemHealth.mjs` inclui `schema_ready` como requisito fail-closed.
- Testes cobrem schema completo, tabela ausente e migration ausente.

## Guardrails
- Nenhum kill-switch comercial alterado.
- Nenhum dado de cliente e lido para diagnostico.
- Nenhuma migration e aplicada automaticamente pelo health.
- Falta de tabela/migration resulta em HTTP 503.

## Criterio de fechamento
Testes completos PASS + auditoria 3X PASS + auditoria 30X PASS + `/api/health` em producao com `schema.ready=true` e nenhum erro de runtime.
