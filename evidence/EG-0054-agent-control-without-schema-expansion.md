# EG-0054 — Agent Control sem expansão de schema

Status: APROVADO COM RESTRICOES
Data: 2026-08-31

## Evidencias independentes
1. PostgreSQL oficial: `jsonb` suporta extração, contenção e atualização de campos com operadores e `jsonb_set`, permitindo estado estruturado dentro de colunas JSONB existentes.
2. Schema ZEVANORY migration 008 já possui `agent_memory.memory_value jsonb` com chave única `(scope_type,scope_ref,memory_key)` e `agent_jobs.payload jsonb` com estados `queued/running/completed/blocked/failed/canceled`.
3. Produção real em `zevanory.api.br/api/health` está íntegra com 15 tabelas / 10 migrations; evitar DDL adicional elimina a janela de incompatibilidade entre runtime e banco.

## Decisão
Persistir PAUSA SEGURA em `agent_memory` e aprovação humana em `agent_jobs.payload`, mantendo fail-closed e sem criar migration 011.

## Rastreabilidade
- `trace_id` e `span_id` permanecem no JSON `agent_runs.decision`.
- `run_id` e `trace_id` permanecem no JSON `integration_outbox.headers`.
- Resultado externo continua separado de decisão e de aprovação.

## Restrições
- Estados físicos de `agent_runs.outcome` permanecem somente `completed`, `blocked`, `failed`.
- Aguardando aprovação é `outcome=blocked` + `decision.state=awaiting_approval`.
- Rejeição humana cancela o job; aprovação o recoloca em `queued`.
- Nenhum gate comercial/financeiro será aberto.
- Suite completa e Robot Control 3X devem passar antes de deploy.
