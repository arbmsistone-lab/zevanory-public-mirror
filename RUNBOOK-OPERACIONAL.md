# ZEVANORY — RUNBOOK OPERACIONAL

Status: obrigatório para operação estrutural.
Escopo: infraestrutura, saúde, deploy, incidente e recuperação. Vendas permanecem fora de escopo.

## Princípios
- Fonte canônica local: `C:\Sistemas\ZEVANORY`.
- Produção oficial: `https://zevanory.api.br`.
- Deploy somente a partir de snapshot auditado da raiz canônica.
- Qualquer divergência entre fonte, release e produção bloqueia promoção.
- Todos os cinco kill-switches comerciais/financeiros permanecem `false` nesta fase.

## Verificações de saúde
1. `GET /api/health` deve responder HTTP 200 e `ready=true`.
2. `checks.storage_configured`, `checks.database_reachable` e `checks.public_base_url_valid` devem ser `true`.
3. `checks.commercial_safety_locked` deve ser `true`.
4. Cada valor de `commercial_switches` deve ser `false`.
5. `GET /api/release` deve corresponder ao fingerprint auditado.
6. `GET /api/status` é observabilidade operacional e não substitui `/api/health`.

## Incidente
1. Não habilitar vendas para testar recuperação.
2. Capturar release, deployment e erro antes de alterar código.
3. Se `/api/health` falhar, classificar banco, URL oficial e kill-switches.
4. Se produção divergir do snapshot auditado, bloquear nova promoção.
5. Corrigir na raiz canônica e repetir testes + auditorias antes de publicar.

## Recuperação e rollback
1. Preferir rollback para deployment previamente `READY` e auditado.
2. Após rollback, validar `/`, `/api/health`, `/api/config`, `/api/release` e `/api/status`.
3. Confirmar que todos os kill-switches comerciais continuam bloqueados.
4. Registrar causa, correção e prova operacional antes de encerrar o incidente.
