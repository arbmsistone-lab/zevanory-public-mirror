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
| Catálogo, páginas, conteúdos versionados | Git + cópia publicada no Cloudflare | Git | Git (nenhuma tabela do Neon) | 0 por origem versionada | 1 h | SHA publicado = SHA do Git |
| Funil, atribuição, telemetria (inclui `knowledge_documents`) | Neon / KV | Neon | Bundle diário | 24 h | 24 h | Idem |
| Operacional (agentes, integrações, esquema) | Neon | Neon; esquema pelas migrações | Bundle diário | 24 h | 24 h | Idem |
| Estado comercial P0 (trava, prova, `zpc:sales:`, `zpc:cp:`) | KV | KV; a prova é recalculada, nunca restaurada como válida | Tabela `zevanory_kv_backup` no Neon, 14 dias (valor, TTL e metadados por chave) | 24 h | 1 h | SHA-256 por chave + manifesto da fonte (valor + TTL + metadados) |
| Credenciais e segredos | Neon, Cloudflare, GitHub | Proprietário (classe D) | Fora do backup por política | — | — | — |
| Código e configuração | Git + Cloudflare | Git | Git | 0 | 1 h | SHA + tag |

**RPO 0 só por origem versionada.** O catálogo e o código têm RPO 0 porque o SHA publicado é o SHA do Git; isso é
conferido pelo commit e pela tag, nunca pelo RPO medido do backup do Neon. Por isso essas classes não têm tabela do
Neon (`validateInventory` recusa classe de RPO 0 com tabela ou sem `rpo_base: "origem_versionada"`), e o ensaio
mensal nunca atribui a elas `rpo_medido_h`. `knowledge_documents` é gravada em runtime pelo autopiloto
(`persistAutopilotCycle`, na mesma instrução que `intelligence_snapshots` e `agent_runs`), não vem do Git e fica na
classe de 24 h do roteiro 9.1 (linha 934, "Eventos internos de funil e telemetria").

A tabela de cada classe do Neon está listada no JSON. O ensaio aponta qualquer tabela sem classe em
`unclassified_tables`, sem escondê-la.

## Ensaio mensal (`.github/workflows/p20-monthly-restore-drill.yml`)

- **Quando:** dia 2 de cada mês, às 07:23 UTC, ou por disparo manual do proprietário.
- **Onde:** Environment `producao-critica`, o mesmo que já lê a cópia do backup no KV
  (`backup-preserve-archive.yml`). **Toda execução espera a aprovação do proprietário**, inclusive a primeira.
- **O que lê:** só `GET` na API do KV do Cloudflare: `zpc:backup:v1:report`, `zpc:backup:v1:report:part:{0,1,2}`
  (manifesto: SHA-256 por tabela) e os 3 bundles `zpc:backup:v1:neon:<dia>:part:<n>` da cópia mais recente, mais
  a cópia KV -> Neon do dia `zpc:backup:v1:kv:<dia>` declarada pela parte 0. Nada é gravado, apagado ou listado em
  produção. O Neon de produção nunca é acessado pelo CI.
- **O que prova:**
  1. a cópia está íntegra: relatório consolidado ok; as 3 partes são do mesmo dia; o SHA-256 de cada tabela confere
     com o manifesto; o resumo do manifesto confere;
  2. a restauração completa funciona: `restore_new_database.restore_full` monta o esquema das migrações e o DDL do
     Worker num Postgres efêmero do runner (banco `p20_drill`) e confere contagem e hash de conteúdo de cada tabela;
  3. o **RPO** medido é o instante da falha simulada (início do ensaio) menos o início mais antigo das partes. Acima
     de 26 h ele é sinalizado; acima de 48 h é falha crítica;
  4. o **RTO de dados** vai do início do ensaio até a restauração conferida. Ele não inclui DNS, a reconfiguração do
     Worker nem o tempo de aprovação;
  5. a **cópia KV -> Neon** (estado comercial) restaura por completo: ver a seção abaixo.
- **Evidência:** `p20/restore-drills-v1.jsonl` no ramo `evidence/b0-baseline` (nunca `gh-pages`), gravada por um job
  sem segredos. O rótulo é `ENSAIO_EM_PRODUCAO` só quando a cópia real foi lida. Fixture é `SINTETICA`. Sem
  leitura, o veredito é `NOT_AVAILABLE` com rótulo nulo. O registro não leva dado de linha.
- **B0:** o coletor preenche `P20.monthly_full_restore_drill` com o ensaio `ENSAIO_EM_PRODUCAO` medido nos últimos
  31 dias. Ensaio `SINTETICA`, `NOT_AVAILABLE`, antigo ou com histórico malformado nunca completa o dia.

## Cópia KV -> Neon no ensaio mensal (sem credencial do Neon no CI)

A cópia do estado comercial vive no Neon (`zevanory_kv_backup`), e a credencial do Neon só existe no Worker. Em vez de
dar ao CI uma credencial do Neon, o próprio backup diário leva a prova até o ensaio:

1. **Worker, parte 0** (`worker/data-backup.mjs`): lista as chaves de `KV_PREFIXES` (`zpc:sales:`, `zpc:cp:`,
   `sales:open:v1`). O `kv.list` já devolve a expiração absoluta e os metadados de cada chave, sem custo extra. O Worker
   calcula, **a partir do KV**, o manifesto da fonte `kv.entries_manifest`: SHA-256 das linhas
   `chave=sha256(valor)|expiração|sha256(metadados)`. Grava valor, hash, expiração e metadados em `zevanory_kv_backup`
   (colunas novas `expiration bigint` e `metadata text`, criadas com `add column if not exists`).
2. **Worker relê do Neon** as linhas do dia e confere cada uma contra a fonte (valor, TTL e metadados). Grava
   **essas linhas relidas** (a cópia, nunca a fonte) em `zpc:backup:v1:kv:<dia>`: envelope AES-256-GCM com a mesma
   chave do backup e AAD própria (`part=0`, chave da cópia), 8 dias, **uma** escrita a mais no KV por dia. A parte 0
   declara `kv.copy = { format, bundleKey, rows, sha }`.
3. **Ensaio mensal** (`scripts/p20/restore-drill*.mjs`): lê a cópia só com GET, confere o envelope (sem rebaixamento
   para claro), o SHA-256 declarado, a forma, o dia, os prefixos (chave de lead `zpc:interest:` é recusada), o hash de
   cada valor e o manifesto da fonte. Qualquer falha reprova **antes** de restaurar.
4. **Restauração:** a ponte (`scripts/p20/restore_bridge.py`) carrega as linhas em `zevanory_kv_backup` do mesmo
   Postgres efêmero (DDL do próprio Worker), confere contagem e hash de conteúdo e **relê do Postgres**.
5. **KV reconstruído:** das linhas relidas, o plano de restauração (`planKvRestore`, o mesmo de uma recuperação real,
   em `scripts/p20/kv-memory-replay.mjs`) gera uma entrada por chave com valor, expiração absoluta e metadados numa
   estrutura em memória do ensaio (`memKvReplay`: `set`/`get`/`list` sobre um `Map`, sem binding, API nem credencial;
   não é um escritor de KV, e os prefixos críticos chegam por parâmetro da lista oficial) com a semântica do Cloudflare
   (expiração ≥ agora + 60 s; metadados ≤ 1024 B). Chave já expirada no instante da restauração não é recriada e é
   contada (`expired_at_restore`). O ensaio relê o KV reconstruído (`list` + `get`) e confere **chave a chave** valor,
   TTL e metadados, e o manifesto inteiro contra `kv.entries_manifest`.
6. **Registro:** `kv_copy` só com contagens e booleanos (nenhum valor nem hash completo). A lacuna
   `copia_kv_para_neon` só sai de `not_covered` com a prova completa num ensaio `APROVADO`, do mesmo dia da cópia, e
   cifrada quando a cópia do dia é cifrada (`validateRecord` recusa qualquer outra combinação). Worker anterior, sem
   a cópia: a lacuna continua, sem reprovar.

Limites honestos: o ensaio prova a cópia do Neon **como estava no dia do backup** (o mesmo vale para as tabelas). A
prova financeira (`zpc-sales-preflight:v1`) está fora de `KV_PREFIXES` e por isso nunca é restaurada como válida: ela é
recalculada. A trava `sales:open:v1` restaurada volta com o último valor copiado; numa recuperação real o proprietário
a confirma.

## O que o ensaio NÃO cobre (lacunas; P20 continua fora de B0_VALIDA)

- **Cópia KV -> Neon:** coberta em código pelo desenho acima. A lacuna só sai do registro no primeiro ensaio mensal
  `ENSAIO_EM_PRODUCAO` aprovado depois do deploy do Worker com esta mudança; até lá ela continua registrada.
- **Conciliação dos pedidos contra o provedor:** as vendas estão fechadas e o Environment do ensaio não tem
  credencial somente leitura do provedor.
- **Diário de eventos no D1:** em sombra. O ensaio lê o diário com o token de leitura dedicado, valida a cadeia,
  reconstrói os eventos posteriores à cópia em `p20_diario_reconstruido` e confere restaurado + reconstruído = diário.
  A lacuna `diario_d1` só sai do registro com essa prova completa num ensaio aprovado (`docs/p20/diario-d1.md`).
- **Cópia cifrada:** em transição. Com o segredo `P20_BACKUP_KEY` no Worker, cada bundle vai para o KV como envelope
  AES-256-GCM; sem ele, continua em texto claro, marcado `nao_cifrado`. O ensaio registra `copia_cifrada` por parte e
  só retira a lacuna quando as 3 partes do dia estão cifradas. Desenho, fases e passos: `docs/p20/cifragem-backup.md`.
- **Retenção:** 8 dias no KV e 14 dias no Neon. Não há cópia rotineira num terceiro local.

## Passos do proprietário

1. Aprovar no GitHub a execução do Environment `producao-critica` para o ensaio, mensalmente ou no primeiro
   disparo manual depois do merge.
2. Revisar e aprovar (ou ajustar) os RPO e RTO por classe no JSON: trocar `status` para `APPROVED` e preencher
   `approved_by` e `approved_at` num PR revisado.
3. Cópia KV -> Neon: **nenhuma credencial nova**. Basta o deploy normal do Worker com esta mudança e a aprovação do
   próximo ensaio mensal (passo 1).
