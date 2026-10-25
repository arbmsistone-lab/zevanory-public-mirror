# P20: inventário do estado crítico e ensaio mensal de restauração (PROPOSTA)

Roteiro Mestre v4.7, seção 9.1. Fonte única legível por máquina: `docs/p20/inventario-estado-critico.json`
(validado pelo ensaio e pelos testes). **Tudo aqui é PROPOSTA.** Os RPO e RTO são objetivos para o proprietário
aprovar. O certificado de P20 usa o valor **medido** no ensaio mensal: objetivo não medido = NÃO COMPROVADO.

## Inventário por classe

| Classe | Onde vive | Fonte da verdade | Backup independente da origem | RPO obj. | RTO obj. | Integridade |
|---|---|---|---|---|---|---|
| Pedidos e pagamentos | Neon | Neon; provedor para os fatos financeiros | Bundle diário no KV do Cloudflare, 8 dias | 24 h | 4 h | SHA-256 por tabela no manifesto + hash de conteúdo após restaurar |
| Entregas e downloads | Neon | Neon; direito reemitido do pagamento conciliado | Idem (tokens de download fora, por política) | 24 h | 4 h | Idem |
| Reembolsos e avaliações | Neon + provedor | Provedor (estorno); Neon (motivo, avaliação) | Idem | 24 h | 4 h | Idem |
| Leads e consentimentos (LGPD) | Neon | Neon (única fonte) | Idem; nada em claro em log ou evidência | 24 h | 4 h | Idem |
| Chamados de atendimento | Neon | Neon (a caixa de e-mail guarda só as mensagens) | Idem | 24 h | 8 h | Idem |
| Catálogo, páginas, conteúdo, base de conhecimento | Git + KV + `knowledge_documents` | Git | Git; `knowledge_documents` também no bundle | 0 | 1 h | SHA do commit |
| Funil, atribuição, telemetria | Neon / KV | Neon | Bundle diário | 24 h | 24 h | Idem |
| Operacional (agentes, integrações, esquema) | Neon | Neon; esquema pelas migrações | Bundle diário | 24 h | 24 h | Idem |
| Estado comercial P0 (trava, prova, `zpc:sales:`, `zpc:cp:`) | KV | KV; a prova é recalculada, nunca restaurada como válida | Tabela `zevanory_kv_backup` no Neon, 14 dias | 24 h | 1 h | Hash por chave |
| Credenciais e segredos | Neon, Cloudflare, GitHub | Proprietário (classe D) | Fora do backup por política | — | — | — |
| Código e configuração | Git + Cloudflare | Git | Git | 0 | 1 h | SHA + tag |

A tabela de cada classe do Neon está listada no JSON. O ensaio aponta qualquer tabela sem classe em
`unclassified_tables`, sem escondê-la.

## Ensaio mensal (`.github/workflows/p20-monthly-restore-drill.yml`)

- **Quando:** dia 2 de cada mês, às 07:23 UTC, ou por disparo manual do proprietário.
- **Onde:** Environment `producao-critica`, o mesmo que já lê a cópia do backup no KV
  (`backup-preserve-archive.yml`). **Toda execução espera a aprovação do proprietário**, inclusive a primeira.
- **O que lê:** só `GET` na API do KV do Cloudflare: `zpc:backup:v1:report`, `zpc:backup:v1:report:part:{0,1,2}`
  (manifesto: SHA-256 por tabela) e os 3 bundles `zpc:backup:v1:neon:<dia>:part:<n>` da cópia mais recente.
  Nada é gravado, apagado ou listado em produção.
- **O que prova:**
  1. a cópia está íntegra: relatório consolidado ok; as 3 partes são do mesmo dia; o SHA-256 de cada tabela confere
     com o manifesto; o resumo do manifesto confere;
  2. a restauração completa funciona: `restore_new_database.restore_full` monta o esquema das migrações e o DDL do
     Worker num Postgres efêmero do runner (banco `p20_drill`) e confere contagem e hash de conteúdo de cada tabela;
  3. o **RPO** medido é o instante da falha simulada (início do ensaio) menos o início mais antigo das partes. Acima
     de 26 h ele é sinalizado; acima de 48 h é falha crítica;
  4. o **RTO de dados** vai do início do ensaio até a restauração conferida. Ele não inclui DNS, a reconfiguração do
     Worker nem o tempo de aprovação.
- **Evidência:** `p20/restore-drills-v1.jsonl` no ramo `evidence/b0-baseline` (nunca `gh-pages`), gravada por um job
  sem segredos. O rótulo é `ENSAIO_EM_PRODUCAO` só quando a cópia real foi lida. Fixture é `SINTETICA`. Sem
  leitura, o veredito é `NOT_AVAILABLE` com rótulo nulo. O registro não leva dado de linha.
- **B0:** o coletor preenche `P20.monthly_full_restore_drill` com o ensaio `ENSAIO_EM_PRODUCAO` medido nos últimos
  31 dias. Ensaio `SINTETICA`, `NOT_AVAILABLE`, antigo ou com histórico malformado nunca completa o dia.

## O que o ensaio NÃO cobre (lacunas; P20 continua fora de B0_VALIDA)

- **Cópia KV -> Neon:** para restaurá-la por completo em CI seria preciso a credencial do Neon, que só o Worker
  usa. Só o ensaio diário por amostra do Worker a cobre.
- **Conciliação dos pedidos contra o provedor:** as vendas estão fechadas e o Environment do ensaio não tem
  credencial somente leitura do provedor.
- **Diário de eventos no D1:** não implementado.
- **Cópia cifrada:** a cópia no KV fica em texto claro. A cifra só existe no arquivo de preservação manual.
- **Retenção:** 8 dias no KV e 14 dias no Neon. Não há cópia rotineira num terceiro local.

## Passos do proprietário

1. Aprovar no GitHub a execução do Environment `producao-critica` para o ensaio, mensalmente ou no primeiro
   disparo manual depois do merge.
2. Revisar e aprovar (ou ajustar) os RPO e RTO por classe no JSON: trocar `status` para `APPROVED` e preencher
   `approved_by` e `approved_at` num PR revisado.
3. Para cobrir a cópia KV -> Neon no ensaio: decidir se cria uma credencial **somente leitura** do Neon para o
   Environment `producao-critica` (papel com `SELECT` apenas em `zevanory_kv_backup`). Sem essa decisão, a lacuna
   permanece registrada.
