# EG-0030 — Observabilidade operacional

Status alvo: APROVADO somente após testes, auditorias e prova em produção.
Escopo: liveness, readiness, correlação, logs estruturados e probe operacional.
Vendas permanecem fora de escopo e bloqueadas.

## Implementação
- `GET /api/live` independente de banco/provedores.
- `/api/health` continua como readiness fail-closed.
- `/api/status` permanece observabilidade agregada, sem PII.
- `x-request-id` é propagado quando seguro ou gerado automaticamente.
- logs operacionais usam JSON estruturado com rota, status e duração.
- `scripts/operational-probe.mjs` verifica live, health, release e status com timeout.
- falha em qualquer alvo encerra o probe com exit code 1.

## Critério de aprovação
- suíte completa sem falhas;
- auditoria 3X aprovada;
- auditoria DR 10X preservada;
- auditoria observabilidade 10X aprovada;
- auditoria 30X aprovada;
- probe contra produção aprovado;
- runtime sem erros críticos;
- cinco kill-switches comerciais/financeiros continuam desligados.

Nenhum item desta evidência autoriza vendas, checkout comercial, eventos financeiros ou autonomia.
