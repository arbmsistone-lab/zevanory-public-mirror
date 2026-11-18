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

`POST /api/internal/backup/run?part=p&parts=N&plan_id=…&run_id=…`

- `run_id` (32 hex) identifica a execução do condutor, gerado a cada execução. Sem ele, a parte v2 é rejeitada.
- A parte **relê o inventário e recalcula o plano**. Se o `plan_id` for diferente, ela falha com `inventory_changed` **antes de qualquer escrita**. Parte fora do plano dá `part_out_of_range`.
- **Parte rejeitada não grava nada no KV, nem o próprio relatório.** A rejeição volta só na resposta HTTP. Um relatório válido de outra chamada fica intacto, byte a byte (contra-auditoria de 17/11, lacuna 1).
- **Exportação ligada ao esquema** (segunda rodada, ponto 2):
  - a exportação é **uma única instrução** que cita cada tabela da parte explicitamente (`exportStatement`);
  - o PostgreSQL trava essas tabelas (AccessShareLock) na análise da instrução, **antes** da fotografia da execução (READ COMMITTED), e mantém a trava até o fim. Nenhuma alteração de esquema delas é confirmada durante a leitura;
  - as colunas (nome, tipo e nulidade) são lidas do catálogo **na mesma instrução** e têm de ser iguais às do inventário validado. Se não forem, `export_schema_mismatch:<tabela>`.
  - **Reaproveitamento incremental** só de conteúdo exportado sob o mesmo esquema (nome, tipo e nulidade), guardado junto da impressão digital.
- **Esquema conferido depois da exportação** (lacuna 2). Entre a validação e a exportação há outra instrução, então a parte confere de novo **antes de gravar** o bundle ou o relatório:
  - **colunas do conteúdo:** cada linha exportada tem exatamente as colunas do inventário validado, na mesma ordem. Se não tiver, `export_columns_mismatch:<tabela>`. Isso pega coluna criada, removida ou renomeada, mesmo que a mudança seja desfeita logo depois;
  - **plano relido:** o plano é recalculado e tem de ser o mesmo. Se não for, `inventory_changed_during_export`. Isso pega também mudança de tipo ou de nulidade.
  - Qualquer divergência rejeita a parte sem gravar. O dia não fecha, porque falta o relatório desta execução.
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
- **Posse do dia no PostgreSQL** (segunda e terceira rodadas). O KV não tem operação atômica, então a disputa é feita numa tabela própria, `zevanory_backup_day` (uma linha por dia: `run_id`, `state` `running`/`complete`, `updated_at`):
  - a parte v2 **valida o plano primeiro** (inventário, `plan_id`, intervalo da parte) e **só então reivindica a posse**, numa única instrução (`insert … on conflict … do update … where … returning`), **antes de qualquer gravação no KV**. Uma chamada rejeitada não reserva o dia. A verificação e a posse são a mesma instrução, então não existe a ordem "B passa pela verificação, A conclui, B grava";
  - a consolidação **nunca reserva** o dia: só confirma a posse que uma parte válida desta execução já obteve. Sem ela, `day_not_claimed`;
  - **cerca de posse:** imediatamente antes de **cada** gravação no KV (bundle, ensaio, cópia do KV, relatório da parte), a execução confirma e renova a posse numa instrução atômica. Se a posse expirou e outra execução assumiu, nada mais é gravado (`ownership_lost`): a execução antiga não altera os arquivos da nova;
  - só a execução dona grava: bundles, relatórios das partes, cópia do KV e relatório principal;
  - enquanto A é dona (`running`), outra execução é recusada com `day_owned_by_other_run`. A posse só passa adiante se a dona ficar **30 minutos** sem reivindicar (execução morta); uma parte do Worker dura segundos;
  - a consolidação **aprovada** marca o dia `complete` e **guarda o relatório aprovado no PostgreSQL na mesma instrução**, na própria posse, e só então publica no KV. Se a posse tiver sido perdida, ela não publica;
  - **recuperação da publicação:** se a execução morrer entre o fechamento no PostgreSQL e a publicação no KV, o dia fica fechado com o relatório guardado. No reinício, a rota de plano responde 409 com o `plan_id` e as partes do relatório aprovado, e o condutor pede uma consolidação de verificação. Ela republica o relatório guardado (HMAC conferido); se o KV já o tiver, nada é gravado. Relatório guardado com HMAC inválido não é republicado e o condutor falha;
  - dia `complete` nunca é reivindicado de novo, nem pela própria execução: plano, partes e consolidação posteriores do mesmo dia são recusados com `day_already_complete`, sem gravar. A rota de plano responde 409 e o condutor encerra com aviso, sem erro;
  - `zevanory_backup_day` fica **fora do inventário do backup**, como `zevanory_kv_backup`: é o controle do próprio backup.
- **Rota do Worker novo só v2** (`backupRunParams`): sem `plan_id` e `run_id`, ou com eles malformados, a rota responde 400 antes de tocar no banco ou no KV.
  - **Índices conferidos no valor original, sem ajuste** (quinta rodada): `parts` tem de ser um inteiro de 1 a 6, e `part`, um inteiro de 0 a `parts - 1`; caso contrário a resposta é `parts_out_of_range` ou `part_out_of_range`. `part=4&parts=4` é recusada e nunca vira `part=3`. Uma consolidação com `part` é recusada (`part_with_finalize`).
  - Na parte, o `parts` da requisição tem de ser igual ao do plano (`parts_mismatch`).
  - Prova pela rota HTTP real (`tests/helpers/p20_route_probe.mjs`): 12 requisições inválidas recebem 400, sem nenhum acesso à rede do banco e sem ler nem gravar o backup no KV. Uma requisição de controle com índices válidos chega ao banco.
- **Erro antes da posse não grava nada** (quinta rodada): se o banco falhar ao validar o plano, antes de a parte obter a posse, a parte é rejeitada sem gravar nem o próprio relatório.
- **Consolidação reprovada nunca toca a chave canônica** (quinta rodada): `zpc:backup:v1:report` só recebe o relatório aprovado, ou a cópia dele guardada no banco. A consolidação v2 reprovada grava o diagnóstico em `zpc:backup:v1:report:ultima_falha`. Nenhuma ordem de eventos entre duas consolidações (mesmo `run_id`, gravação pendente) faz o KV voltar a `ok=false` depois do dia aprovado.
- **Tabela de controle ausente:** a consolidação responde `day_not_claimed` e não cria a tabela. O caminho v1 continua na biblioteca, para os testes e a prova de restauração de cópias legadas, mas não é alcançável pela rota.
- Exige o `run_id` desta execução em **todas** as partes. Um relatório de outra execução, que sobra no KV quando a parte desta foi rejeitada, dá `part_run_mismatch:<i>` e nunca supre a parte. O `run_id` de cada parte vai dentro de `parts_detail`, que é autenticado.
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
  - chave estrangeira quebrada entre partes (`inconsistencia_entre_tabelas`);
  - **reenvio com plano divergente depois de uma parte válida:** as duas chamadas tardias, com o plano antigo depois de uma mudança de esquema e com um `plan_id` forjado, são rejeitadas, e o KV fica **byte a byte** igual;
  - **tipo de coluna muda entre a validação e a exportação:** a parte é rejeitada (`inventory_changed_during_export`), não grava, o dia não fecha e o arquivador recusa;
  - **coluna criada depois da validação e removida depois da exportação** (o inventário relido volta ao do plano): rejeitada por `export_columns_mismatch`;
  - **tipo alterado depois da validação e desfeito depois da exportação** (nomes iguais, inventário relido igual): rejeitado por `export_schema_mismatch`;
  - **execução A conclui o dia e B falha no mesmo dia** (plano, partes e consolidação de B, e reenvio da própria A): tudo rejeitado, o KV fica byte a byte igual, e a cópia de A continua arquivável, `completo`, e restaura igual à origem;
  - **corrida, ordem da contra-auditoria:** B passa pela verificação e **pausa**; A conclui; B é retomada (parte e consolidação). Nenhuma chave de A muda, e A é arquivada, `completo`, e restaura igual à origem;
  - **corrida, ordem inversa:** B obtém a posse e pausa; A tenta o dia inteiro e não grava nada; B termina;
  - **queda entre o PostgreSQL e o KV:** a consolidação morre depois de fechar o dia e antes de publicar. No reinício, o relatório é republicado, e a cópia é arquivável, `completo`, e restaura igual à origem;
  - **chamada rejeitada não reserva:** chamadas autenticadas com plano forjado ou parte fora do plano chegam primeiro e não criam posse; a execução legítima conclui o dia;
  - **posse expirada:** A obtém a posse e pausa, a posse expira, B assume e conclui. A retomada é recusada (`ownership_lost`, depois `day_already_complete`) e não altera nenhum arquivo de B, que é arquivável e restaurável;
  - **consolidação reprovada pendente:** duas consolidações da mesma execução. A reprovada passa pela posse e fica com a gravação pendente; a válida fecha o dia e publica; a pendente termina. O relatório canônico continua o aprovado (igual ao do banco), a falha fica na chave separada, e a cópia é arquivável e restaurável;
  - **tabela de controle ausente:** a consolidação responde `day_not_claimed` e não cria a tabela.
  - **reaproveitamento com esquema diferente** (tipo mudou, JSON igual): no dia seguinte a tabela é exportada de novo, e as demais são reaproveitadas.
- **Também:**
  - escrita concorrente entre a estatística e a exportação, contada no conteúdo copiado;
  - **legado v1 cifrado de 3 partes restaurado com a decifragem nova**, a prova da correção do defeito crítico, marcado `legado_nao_autenticado`.
- **Mutantes:** `scripts/ci/mutants_p20_v2.py`, um por regra, 42 de 42 KILLED.

## Riscos residuais (declarados)

- **Parte 0 rejeitada no meio:** se a parte 0 for rejeitada depois de começar (inventário mudou durante a exportação), a cópia KV → Neon do dia (`zevanory_kv_backup`, um upsert idempotente) já terá sido gravada no Neon. Nada é gravado no KV e o dia não fecha.
- **Novo backup no mesmo dia depois de um aprovado:** não acontece. Uma cópia mais recente no mesmo dia só vem no dia seguinte.
- **Dia reprovado no painel:** com a consolidação reprovada fora da chave canônica, o painel (que lê `zpc:backup:v1:report`) mostra o último relatório aprovado e acusa a idade, não o motivo da falha. O motivo fica em `zpc:backup:v1:report:ultima_falha`.
- **Execução que falhou no meio:** o dia fica com ela por até 30 minutos. Uma nova tentativa no mesmo dia, dentro desse prazo, é recusada (`day_owned_by_other_run`).
- **Execução viva parada por mais de 30 minutos** entre duas chamadas perde a posse. Se voltar, é recusada e não publica.
- **Cerca e gravação não são uma única operação:** entre confirmar a posse e gravar no KV há só a espera de uma gravação. Para a execução antiga gravar sobre a nova, ela teria de ficar parada mais de 30 minutos exatamente nesse ponto, dentro de uma única invocação do Worker.
- **Neon durante uma corrida:** a cópia KV → Neon do dia (upsert idempotente) e o esquema isolado do ensaio são gravados no Neon por quem tem a posse. Uma execução antiga que perca a posse no meio pode ter tocado neles, mas não nos arquivos do KV que o arquivador lê.

- **Não há fotografia transacional global.** A consistência é por tabela. Relações quebradas são detectadas na restauração, não evitadas.
- **Os arquivos históricos reais** (KV e Drive) não foram auditados: isso exige a chave de produção e a autorização do proprietário.
- **Tabelas reais sem semente no teste** são restauradas vazias e comparadas: contagem 0 e hash igual. As tabelas sintéticas e as reais semeadas cobrem os tipos e caracteres especiais.
- **O deploy do Worker exige autorização própria.** Até ele acontecer, a produção segue no v1.
  - Com as tabelas que a produção tem hoje (65, última medição), o v1 ainda cabe em 3 partes: o backup diário está verde e completo.
  - A omissão começa a partir de cerca de 89 elegíveis, conforme a posição das credenciais.
  - **O restaurador corrigido vale desde o merge** (é script do repositório): os arquivos de backup cifrados atuais passam a ser restauráveis pelo caminho legado, com a chave.
