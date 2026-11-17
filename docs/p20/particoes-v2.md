# P20 v2: partes dinâmicas, plano autenticado e restauração integral comprovada

Esta é a implementação do desenho homologado pelo GPT-6:
- especificação r2;
- adendo r2.1;
- correções r2.2 e r2.3.

O desenho está na pasta de intercâmbio do Drive. Este documento registra **o que o código faz**, com a referência de cada regra.

## Problema que este PR corrige

- **Omissão de tabelas.** O backup diário tinha 3 partes fixas, de no máximo 30 tabelas cada. A distribuição numerava **todas** as tabelas, inclusive as de credencial. Com 93 elegíveis no esquema atual, tabelas ficavam de fora (`over_table_budget`), e com 89 ou 90 já havia estouro, conforme a posição das credenciais.
- **Restaurador que não decifrava.** `restore_new_database.py` chamava `describe_bundles(raw)` sem o dia nem a chave. **Nenhum arquivo de backup cifrado era restaurável** (`envelope_aad_mismatch part=0`), apesar do backup diário verde.
- **Arquivador preso a 3 partes.** `backup_preserve_archive.py` arquivava sempre `range(3)` e omitia em silêncio uma parte a mais.

## Contrato v2 (`worker/data-backup.mjs`)

### 1. Plano (rota `POST /api/internal/backup/plan`, só leitura)

- `elegíveis` = tabelas `BASE TABLE` do `public`, menos `zevanory_kv_backup` e menos as de credencial (`SENSITIVE`), em ordem de ponto de código.
- `fingerprint` = SHA-256 do JSON canônico `[(tabela, [(coluna, tipo, nulidade)…])…]` das elegíveis.
- `parts = ceil(E / 30)`, entre 1 e 6. Acima de 6: `capacity_exceeded` e nenhum plano.
- `plan_id = HMAC-SHA256(K_rel, JSON canônico do plano)`.
  - `K_rel = HKDF-SHA256(os 32 bytes de P20_BACKUP_KEY, info "zevanory-backup-report-v2")`. É uma chave separada da que cifra os dados e nunca é gravada.
- A rota devolve só `plan_id`, `parts`, contagens e o `kid`: **nunca nomes de tabela nem dados**.

### 2. Partes

`POST /api/internal/backup/run?part=p&parts=N&plan_id=…`

- A parte **relê o inventário e recalcula o plano**. Se o `plan_id` for diferente, ela falha com `inventory_changed` **antes de qualquer escrita**. Parte fora do plano dá `part_out_of_range`.
- A parte copia **exatamente** `elegíveis[j]` com `j % parts == p`.
- **Garantia:**
  - `p = ceil(E/30)` implica `E/p ≤ 30`, portanto `ceil(E/p) ≤ 30`;
  - a atribuição circular dá `floor(E/p)` ou `ceil(E/p)` tabelas por parte;
  - as credenciais saem **antes** da numeração.
  - Teste de enumeração completa: E de 1 a 180.
- **Linhas contadas no conteúdo copiado**, e não na estatística.
- O relatório da parte guarda o hash do **valor gravado** (envelope), as tabelas e linhas, e o `plan_id`.

### 3. Consolidação

`POST /api/internal/backup/run?finalize=1&parts=N&plan_id=…`

- Confere o HMAC do plano.
- Confere que cada parte tem o mesmo `plan_id` e exatamente as tabelas atribuídas a ela, que nenhuma tabela aparece em duas partes e que a cobertura das elegíveis é total.
- Qualquer divergência **reprova o dia inteiro**.
- O relatório v2 é **autenticado inteiro** por HMAC(K_rel) sobre `contract, day, plan_id, plan, parts, parts_detail, ok, failures, encryption`.
- Sem a chave, `auth.state` é `nao_autenticado` e nada é declarado completo.

### 4. Compatibilidade

- **Sem `plan_id`,** o Worker segue o caminho v1, idêntico ao de antes.
- **O condutor** (`scripts/ops/data-backup.mjs`) pede o plano primeiro.
  - Com um Worker antigo (rota de plano dá 404), roda o legado v1 e emite o alerta `DATA_BACKUP_LEGADO_V1`.

### 5. Consistência prometida

- É **por tabela**: cada tabela é o conteúdo de um único instante. **Não existe fotografia global.**
- Uma chave estrangeira quebrada por escrita entre partes é reportada na restauração como `inconsistencia_entre_tabelas <tabela>`. Ela nunca é "consertada" nem engolida.

## Arquivamento (`scripts/ops/backup_preserve_archive.py archive`)

- **Com relatório v2 do dia:**
  - arquiva **exatamente** as partes declaradas;
  - parte ausente dá `missing_part`;
  - parte extra dá `extra_part`;
  - hash diferente do declarado dá `part_hash_mismatch`;
  - HMAC do relatório ou do plano inválido dá `report_hmac_invalid` ou `plan_hmac_invalid`;
  - tabelas diferentes do relatório dão `table_report_mismatch`;
  - o relatório autenticado vai **dentro** do arquivo.
- **Sem a chave:** `auth_state = nao_autenticado`, `complete = false`.
- **Legado v1** (3 partes, sem plano): é arquivado, mas marcado `legado_nao_autenticado` e **nunca** `complete`.
- **KV em arquivo:** `--kv-fixture` lê um KV em arquivo, só no CI. Ele é recusado em `kv-extend`, a única escrita na produção.

## Restauração (`scripts/ops/restore_new_database.py`)

- Decifra as partes **só em memória**, com `P20_BACKUP_KEYS` e a AAD do dia e da parte. Agora o segredo também chega ao workflow `restore-new-database.yml`.
- **Sem a chave:** `restore_requires_backup_key`. Nunca restaura conteúdo não verificado.
- Com relatório v2: confere de novo o HMAC e que as tabelas são exatamente as declaradas.
- Por tabela: contagem e hash de conteúdo, como antes. Chave estrangeira violada dá `inconsistencia_entre_tabelas`.
- O resultado `estado` só vale `completo` com contrato v2 autenticado. Os outros estados são `nao_autenticado` e `legado_nao_autenticado`.

## Ensaio mensal (`scripts/p20/restore-drill*.mjs`)

O número de partes vem do relatório consolidado: de 1 a 6, em vez de 3 fixas.

## Critério de aceite: teste oficial no CI (`tests/test_p20_restauracao_integral.py`)

O teste roda no job `p20-restore-drill / tests`, com PostgreSQL 16 efêmero do serviço do job, nunca produção.

- **Origem:** o esquema real (`db/migrations`, `runtime_ddl()`, `dynamic_ddl()`), linhas com acento, aspas, `$`, JSON e nulos, uma tabela de credencial sintética e tabelas sintéticas para chegar a E.
- **Cadeia real:**
  1. Worker (chave sintética gerada na execução);
  2. arquivamento real;
  3. restauração real num banco novo, pelo papel `p20_app`, que não é superusuário.
- **Positivos:** E = **88, 94, 121 e 180** (3, 4, 5 e 6 partes).
- **Comparação origem × destino, por tabela elegível:**
  - contagem;
  - hash de linhas;
  - colunas (nome, tipo, nulidade e padrão);
  - `has_table_privilege(p20_app, SELECT/INSERT/UPDATE)`;
  - a credencial chega vazia ao destino;
  - o restaurador declara `completo`.
- **Contraprovas** (todas reprovam, sem nada completo):
  - esquema alterado entre o plano e a parte;
  - parte ausente;
  - parte extra;
  - HMAC adulterado;
  - bundle movido de parte;
  - bundle corrompido;
  - arquivamento sem chave (`nao_autenticado`, restauração recusada);
  - chave estrangeira quebrada entre partes (`inconsistencia_entre_tabelas`).
- **Também:**
  - escrita concorrente entre a estatística e a exportação, contada no conteúdo copiado;
  - **legado v1 cifrado de 3 partes restaurado com a decifragem nova**, a prova da correção do defeito crítico, marcado `legado_nao_autenticado`.
- **Mutantes:** `scripts/ci/mutants_p20_v2.py`, um por regra, 21 de 21 KILLED.

## Riscos residuais (declarados)

- **Não há fotografia transacional global.** A consistência é por tabela. Relações quebradas são detectadas na restauração, não evitadas.
- **Os arquivos históricos reais** (KV e Drive) não foram auditados: isso exige a chave de produção e a autorização do proprietário.
- **Tabelas reais sem semente no teste** são restauradas vazias e comparadas: contagem 0 e hash igual. As tabelas sintéticas e as reais semeadas cobrem os tipos e caracteres especiais.
- **O deploy do Worker exige autorização própria.** Até ele acontecer, a produção segue no v1.
  - Com as tabelas que a produção tem hoje (65, última medição), o v1 ainda cabe em 3 partes: o backup diário está verde e completo.
  - A omissão começa a partir de cerca de 89 elegíveis, conforme a posição das credenciais.
  - **O restaurador corrigido vale desde o merge** (é script do repositório): os arquivos de backup cifrados atuais passam a ser restauráveis pelo caminho legado, com a chave.
