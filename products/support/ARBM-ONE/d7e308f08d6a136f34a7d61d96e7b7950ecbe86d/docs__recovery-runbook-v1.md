# ARBM ONE Recovery Runbook V1

## Estado certificado

- Código-fonte: reconstrução limpa comprovada pela onda 10 e revalidada continuamente.
- Edge Functions: fonte das 34 funções remotas ativas coberta no Git, incluindo as funções adicionadas após a onda 14.
- Banco/Storage: backup real criptografado automatizado ativo; restore hospedado de dados + Storage comprovado por roundtrip de hashes.
- Supabase: plano Free; não assumir PITR ou backup diário restaurável garantido.
- RPO operacional: backups reais automatizados e recorrentes estão ativos; o alvo de 24h permanece um objetivo operacional a ser confirmado longitudinalmente.
- RTO de dados + Storage: 49,874 s comprovados em restore hospedado isolado por quarentena no staging; RTO de failover completo da aplicação para terceiro projeto permanece não comprovado.

## Inventário obrigatório

Use `docs/recovery-inventory-v1.json` e `supabase/migration-history/manifest.json` como snapshots auditados.
Antes de qualquer restauração, reaudite o remoto; snapshots históricos não são verdade eterna.

## Gate 1 — código e schema

1. Checkout do commit certificado.
2. Executar `Source Recovery Build`.
3. Exigir `npm ci`, `test:all`, lint, build e audits verdes.
4. Conferir SHA-256 dos lockfiles, migrations e assets.
5. Não aplicar automaticamente migrations classificadas como `local_only_not_applied`.

## Gate 2 — histórico de migrations

O remoto possui 204 registros: 202 nomeados e 2 sem nome; o diretório ativo local possui 200 SQLs.
A reconciliação nominal atual encontra 197 nomes em comum, 5 somente remoto e 3 somente local; os avanços posteriores foram aplicados simetricamente no remoto e no Git.
Quatro migrations históricas tiveram SQL recuperado e foram arquivadas em `supabase/migration-history/`.
Três casos permanecem com fonte original perdida: uma com SHA-256 aprovado preservado e duas com nome histórico recuperado por auditorias antigas.
O diretório `migration-history` é evidência forense e nunca participa do fluxo normal de aplicação de migrations.
Não invente SQL para fechar contagem; restauração deve preservar o schema efetivo e registrar a lacuna de origem.

## Gate 3 — Edge Functions

Há 34 funções ativas remotas e 36 diretórios locais, com cobertura de fonte remota 34/34; os 2 diretórios locais adicionais são as funções Mercado Pago ainda não aplicadas.
As duas funções locais adicionais de Mercado Pago permanecem não implantadas e não devem ser ativadas por reconciliação automática.
Não redeploy funções apenas para igualar contagem: hashes, `verify_jwt`, versões e contratos precisam ser revisados.

## Gate 4 — configuração e secrets

Recrie somente nomes de configuração; valores secretos nunca entram no Git ou no runbook.
Secrets precisam vir de cofre/gestor autorizado. Falta de credencial crítica bloqueia a integração correspondente.
Inclua Supabase, WhatsApp/Meta, Mercado Pago, Gemini e credenciais S3.

## Gate 5 — dados

1. Exigir artifact criptografado do workflow `Data Recovery Backup`.
2. Verificar SHA-256 antes de descriptografar.
3. Restaurar roles, schema e data em projeto Supabase isolado, nunca sobre produção durante drill.
4. Restaurar Storage separadamente; dump do banco não recupera bytes deletados do Storage.
5. Validar contagens, integridade referencial, RPCs críticas e autenticação.
6. Manter medição longitudinal do RPO operacional e medir separadamente o RTO de failover completo da aplicação.

## Gate 6 — promoção

Após restore isolado aprovado: testes, segurança, build, deployment, domínio, synthetic monitor, recovery drill e auditoria final.
Produção original só pode ser substituída mediante decisão explícita e plano de rollback.

## Critério de nota 10 desta frente

Não é ter um arquivo de backup ou contagens iguais. É provar artifact íntegro, restore isolado reproduzível, configuração reconstruída, Storage restaurado, testes verdes e RTO/RPO medidos.
Estado atual: `data_storage_restore_proven_full_application_failover_unproven`.
