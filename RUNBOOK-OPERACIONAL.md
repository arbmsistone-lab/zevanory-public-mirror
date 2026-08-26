# ZEVANORY — RUNBOOK OPERACIONAL

Status: obrigatório para operação estrutural.
Escopo: infraestrutura, saúde, deploy, incidente e recuperação. Vendas permanecem fora de escopo.

## Princípios
- Fonte canônica local: `C:\Sistemas\ZEVANORY`.
- Produção oficial: `https://zevanory.api.br`.
- Deploy somente de snapshot auditado da raiz canônica.
- Divergência entre fonte, release e produção bloqueia promoção.
- Todos os cinco kill-switches comerciais/financeiros permanecem `false`.

## Verificações de saúde
1. `GET /api/health` deve responder HTTP 200 e `ready=true`.
2. Banco, URL oficial e `schema_ready` devem ser `true`.
3. O schema deve mostrar 4 tabelas e 5 migrations, sem ausências.
4. `checks.commercial_safety_locked` deve ser `true`.
5. Cada valor de `commercial_switches` deve ser `false`.
6. `/api/release` deve corresponder ao fingerprint auditado.

## Incidente
1. Não habilitar vendas para testar recuperação.
2. Capturar release, deployment e erro antes de alterar código.
3. Se `/api/health` falhar, classificar banco, schema, URL e kill-switches.
4. Se produção divergir do snapshot auditado, bloquear promoção.
5. Corrigir na raiz canônica e repetir testes + auditorias antes de publicar.

## Recuperação e rollback
1. Preferir rollback para deployment previamente `READY` e auditado.
2. Após rollback, validar `/`, `/api/health`, `/api/config`, `/api/release` e `/api/status`.
3. Confirmar novamente schema íntegro e kill-switches bloqueados.
4. Para desastre de dados, usar Neon PITR/Branch Restore dentro da retenção configurada.
5. Antes de restaurar a branch principal, validar o ponto de recuperação em branch/time-travel quando aplicável.
6. O ensaio rotineiro usa `scripts/dr-rehearsal.mjs`: schema isolado + migrations 001–005 + `ROLLBACK`.
7. Nunca executar o ensaio sem `DR_REHEARSAL_ALLOWED=true`.
8. Registrar causa, ponto de recuperação, resultado e prova operacional.
