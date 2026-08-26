# EG-0029 — Disaster Recovery Rehearsal

Status: APROVADO para recuperação estrutural não destrutiva.
Escopo: reconstrução de schema e ledger de migrations; vendas continuam fora de escopo.

## Prova executada
- Driver: `@neondatabase/serverless` conectado ao Neon de produção com credencial temporária local.
- Guard obrigatório: `DR_REHEARSAL_ALLOWED=true`.
- Ensaio executado dentro de transação PostgreSQL.
- Criado schema isolado aleatório via `CREATE SCHEMA`.
- `SET LOCAL search_path` direcionou todas as migrations para o schema isolado.
- As migrations 001–005 foram reaplicadas em ordem.
- Resultado: 4/4 tabelas obrigatórias presentes.
- Resultado: 5/5 migrations registradas.
- `missing_tables=[]`.
- `missing_migrations=[]`.
- Finalização obrigatória por `ROLLBACK`.
- Resultado publicado pelo ensaio: `persistent_changes=false`.

## Segurança
- Nenhuma tabela de produção foi modificada.
- Nenhum dado de cliente foi exportado.
- O arquivo temporário `.env.dr` foi removido após o ensaio.
- Kill-switches comerciais/financeiros permanecem desligados.

## Rota de desastre
- Neon oferece Point-in-Time Restore/Branch Restore usando histórico WAL dentro da retenção configurada.
- Recuperação destrutiva da branch principal não deve ser usada como teste rotineiro; validar primeiro por branch/time-travel quando aplicável.
