# P22 — investigação da renovação da prova financeira

Status: **diagnóstico e proposta; nada ativado**. Base examinada:
`gh-pages@a098d8802a184df02b362d46f08fb6c81b7382f9`; a base atual
`b7671272` (#947) não altera `worker/`, `scripts/b0/`,
`scripts/financial_proof_renewal.py`, o workflow de renovação nem
`scripts/deploy/`. Vendas permanecem fechadas (`NO-GO`).

Revisão 2 (auditoria independente v12c): acrescenta o terceiro produtor (ramo
horário), corrige a contagem de consultas ao banco, refaz a conta de margem,
retira a reserva no KV, quantifica o custo de cada desenho e registra a análise
do alerta de limite diário do KV.

## Sintoma e contrato

O conjunto observado teve 177 sondagens: 31 `PROVEN` e 146
`UNVERIFIED_FAIL_CLOSED`. Na amostra ampliada (230 sondagens, de 2026-10-26
19:00Z a 2026-10-27 14:10Z), 44 foram `PROVEN`. O coletor B0 aceita a prova
por 65 minutos (`P22_TTL_MIN` em `scripts/b0/b0-lib.mjs`), igual ao limite
aplicado pelo runtime (`MAX_AGE_MS` em `worker/commercial-metrics-projection.mjs`).
O objeto fica no KV por duas horas, mas depois de 65 minutos sua presença já não
o torna válido. Portanto, uma renovação a cada seis horas produz
aproximadamente 65 minutos de `PROVEN` e 295 minutos de
`UNVERIFIED_FAIL_CLOSED` em cada ciclo.

## Quem produz a prova

Há três caminhos que tentam produzir o mesmo snapshot derivado
`zpc-production-financial-metrics:v1`:

1. **Worker central, cron `15,45 * * * *` (único produtor efetivo com vendas
   fechadas).** O ramo isolado de `worker/cloudflare-worker.compat.mjs`
   executa `refreshFinancialProofSnapshot(..., force: true)` e grava o snapshot
   após leituras verificadas. Porém, antes disso, `dbEconomySkip` só deixa
   consultar o banco quando a hora UTC é múltipla de 6 e o minuto é menor que 30.
   Entre os dois tiques do cron, apenas `00:15`, `06:15`, `12:15` e `18:15`
   passam. O teste `tests/db-economy.test.mjs` codifica exatamente quatro horas
   por dia e dois crons consultores, confirmando que essa redução é intencional
   para conter egress do Neon Free.
2. **Worker central, cron horário `0 * * * *` (produtor que falha em
   silêncio).** No ramo horário, depois de `recordLaunchEpoch`, o Worker chama
   `refreshFinancialProofSnapshot(normalized, { sqlFactory })` **sem**
   `dbEconomySkip` e sem `force`. Sem `force`, a função só pula a auditoria
   quando a prova anterior é válida e tem menos de 50 minutos
   (`MIN_REFRESH_MS`). Como a prova nasce às `:15`, às `:00` seguintes ela tem
   45 minutos e o ramo pula; nas outras 20 horas do dia ela já venceu e o ramo
   **tenta auditar**. Detalhes na seção seguinte.
3. **GitHub Actions (produtor condicional).** O workflow
   `.github/workflows/order12a-financial-proof-renewal.yml` está configurado em
   `11,41 * * * *`. Seu script chama, por GET assinado, o endpoint
   `/api/internal/audit/financial-classification`; o Worker persiste o snapshot
   validado via `persistClassificationSnapshot`. Com vendas fechadas, porém,
   `scripts/financial_proof_renewal.py` encerra antes do GET assinado com
   `OWNER_SALES_SWITCH_NOT_OPEN`. Assim, esse caminho não renova P22 no estado
   atual e não pode explicar os pulsos em `:15`.

## O ramo horário: o que está confirmado e o que é hipótese

**Confirmado pelo código** (`worker/cloudflare-worker.compat.mjs`, ramo final
de `scheduled`; `worker/commercial-metrics-projection.mjs`;
`worker/internal-financial-audit.mjs`; `runSalesPreflight` em
`worker/cloudflare-worker.recovered.mjs`):

- toda hora, sem gate de economia, `runSalesPreflight` faz um GET
  `/users/me` no Mercado Pago, um `select 1` no banco, um `kv.list` (prefixo dos
  arquivos de produto) e grava `zpc-sales-preflight:v1`: 24 `select 1`, 24
  `list` e 24 gravações por dia;
- em 20 das 24 horas a auditoria da prova é tentada. Cada tentativa custa um
  GET `/users/me`, duas instruções SQL (`count` em `orders` e até 41 linhas de
  `financial_events`) e um GET por pagamento (até 40; orçamento de 46 GETs com
  retentativas);
- quando a auditoria não verifica e a prova anterior não é válida (o caso das
  20 horas), `refreshFinancialProofSnapshot` grava um snapshot não verificado:
  **até cerca de 20 gravações por dia** no KV, todas inúteis para P22;
- tudo isso corre em paralelo com outras oito tarefas da mesma invocação
  (suporte, entrega, nutrição, digest, reembolso, pós-venda e o `scheduled`
  legado), que dividem o limite de **50 subrequisições por invocação** do
  Workers Free. O próprio ramo `15,45` foi criado porque a verificação MP usa
  até 46 delas.

**Confirmado por evidência observada:**

- nas 230 sondagens não houve nenhuma transição para `PROVEN` às `:00`; todas
  aconteceram depois das `:15` (00:20, 06:20 e 12:20 com idade 5; 19:00 com
  idade 45). Logo, o ramo horário **nunca produziu `PROVEN`** na janela
  observada, embora tenha tentado em cerca de 16 horas dela;
- o batimento horário `zpc:cron:v1:hourly` publicado pelo snapshot do Command
  Center registra `nurture` como
  `fail:Error connecting to database: Error: Too many subrequests by single
  Worker invocation` em 2026-10-25 18:00Z, 2026-10-27 00:00Z e
  2026-10-27 06:00Z. O orçamento de subrequisições da invocação horária
  **se esgota de fato**, ao menos nessas horas.

**Hipótese (não verificada; sem logs do Worker e sem a tarefa da prova no
batimento horário):** a auditoria da prova falha por falta de subrequisições.
Os GETs de pagamento são sequenciais, então a auditoria é a tarefa mais longa
da invocação; quando o orçamento acaba, `fetch` lança, `mpGet` devolve
status 0 e o resultado vira 503 (`production_token_unverified`) ou 409
(pagamentos ambíguos). Antes de a auditoria começar, a invocação já gastou ao
menos três subrequisições (despacho do suporte, `/users/me` e `select 1` do
preflight). Hipóteses alternativas que não foram excluídas: limite de CPU
(10 ms no Free) ou de duração da invocação, e erro de banco não relacionado ao
orçamento. Para confirmar, basta registrar no batimento horário a categoria
devolvida por `refreshFinancialProofSnapshot` (proposta, não implementada).

**Risco latente do ramo horário:** hoje a prova nunca está entre 50 e 65 minutos
às `:00`, então o ramo horário nunca a encontra válida e envelhecida. Em
qualquer desenho que renove fora das `:15`, ou depois de um tique falho, isso
pode acontecer. Nesse caso, um 409 causado por GETs sem orçamento
**invalidaria uma prova válida**, porque `refreshFinancialProofSnapshot` grava
o snapshot não verificado sempre que o código é 409. Por isso a proposta tira a
prova do ramo horário.

## Cadência configurada × real

| Caminho | Configuração | Com vendas fechadas | Evidência real |
|---|---|---|---|
| Worker, ramo isolado | `15,45 * * * *` (48 invocações/dia) | `dbEconomySkip` admite somente o tique `:15` em 00/06/12/18 UTC: 4 auditorias/dia (8 instruções SQL) | O reaparecimento observado em aproximadamente 18:15, 00:15, 06:15 e 12:15 UTC coincide com o ramo permitido |
| Worker, ramo horário | `0 * * * *` (24 invocações/dia) | sem gate de economia: 24 `select 1` do preflight e até 20 auditorias tentadas (até 40 instruções SQL) | nenhuma transição para `PROVEN` às `:00`; esgotamento de subrequisições registrado no batimento horário |
| GitHub Actions | `11,41 * * * *` (48 oportunidades/dia) | o job inicia, mas a renovação é recusada antes da auditoria enquanto o interruptor do proprietário está fechado | API de runs: de 2026-10-26 01:37:34Z a 2026-10-27 10:26:19Z houve 7 runs agendados em 32 h 49 min; seis intervalos entre 3 h 54 min e 7 h 14 min, média 5 h 28 min; os 7 falharam. O run 40488464254 terminou em `OWNER_SALES_SWITCH_NOT_OPEN` |

Correção da revisão 1: a afirmação de que a economia limita o banco a 4
consultas por dia vale só para o ramo isolado. Somando o ramo horário, o
Worker toca o Neon até cerca de 72 vezes por dia por causa da prova e do
preflight (8 + até 40 + 24 instruções SQL), sem produzir nenhuma prova extra.

O agendamento do GitHub, por sua vez, não entrega sua cadência nominal. A
própria documentação do GitHub avisa que eventos `schedule` podem atrasar e até
ser descartados sob carga, e que agendamentos de repositório público podem ser
desativados após 60 dias sem atividade:

- <https://docs.github.com/en/actions/how-tos/troubleshoot-workflows#scheduled-workflows-running-at-unexpected-times>
- <https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule>

Essas limitações tornam o `schedule` inadequado como única fonte de renovação,
mas não são a causa direta do padrão `:15` a cada seis horas: esse padrão vem
da política `dbEconomySkip` do Worker.

## Causa

A prova expira para fins de P22 após 65 minutos, enquanto o único produtor que
funciona com vendas fechadas é deliberadamente limitado a uma execução a cada
seis horas. Os contratos de economia e de frescor são incompatíveis. O produtor
horário, que não tem gate de economia, tenta renovar mas falha (provavelmente
por orçamento de subrequisições) e só gera custo. O produtor do GitHub está
sujeito ao agendador não determinístico e bloqueado por desenho quando vendas
estão fechadas.

Não há indício de corrupção da prova: o comportamento `UNVERIFIED_FAIL_CLOSED`
é o resultado seguro esperado quando a idade excede 65 minutos.

## Margem: correção da revisão 1

A revisão 1 propunha tiques a cada 30 minutos com piso de 50 minutos e falava
em margem de 15 minutos. A conta estava errada. Com tiques a cada 30 minutos, o
tique em que a idade é 30 pula (30 < 50) e a renovação só acontece com idade
**60**: a margem nominal é de cerca de **5 minutos**. Um único tique atrasado
mais de 5 minutos, ou com 503 transitório, deixa a prova vencida até o tique
seguinte (idade 90), ou seja, cerca de 25 minutos de `UNVERIFIED_FAIL_CLOSED`.

Três atrasos comem a margem nominal:

- **início do tique:** o batimento do ramo isolado registra início entre cerca
  de 40 e 65 segundos depois do minuto agendado;
- **duração da auditoria:** `measured_at` marca o início e a gravação vem
  depois. Normalmente são segundos, mas o pior caso limitado pelo código
  (46 GETs com timeout de 7 s, mais as pausas de retentativa) passa de 5 minutos;
- **propagação do KV:** uma gravação pode levar até 60 segundos para ficar
  visível em outros locais (documentação do Workers KV).

Idade da prova no momento da renovação (valores nominais, antes desses atrasos):

| Desenho | Renovação normal | Com um tique falho | Com dois tiques falhos | Auditorias/dia |
|---|---|---|---|---|
| Revisão 1: tiques de 30 min (`15,45`), piso 50 | 60 (margem 5) | 90: vence | vence | 24 |
| Tiques de 30 min (`15,45`), piso 25 (renova em todo tique) | 30 (margem 35) | 60 (margem 5, menos atrasos) | 90: vence | 48 |
| Tiques de 15 min, piso 40 | 45 (margem 20) | 60 (margem 5, menos atrasos) | 75: vence | 32 |
| **Tiques de 15 min, piso 25 (recomendado)** | **30 (margem 35)** | **45 (margem 20)** | 60 (margem 5, menos atrasos) | 48 |

Só o último desenho mantém a prova dentro do TTL de 65 com um tique atrasado ou
falho **e** com folga para os atrasos acima. Os desenhos com margem de 5
minutos depois de uma falha dependem de a auditoria e a propagação terminarem
em menos de cerca de 3 minutos, o que não está garantido.

## Proposta (não implementada)

Recomenda-se manter a renovação em um **cron já existente do Worker da
Cloudflare**, independente do agendador do GitHub, e separar a política da
prova financeira das demais tarefas caras:

1. **Cadência de 15 minutos no ramo isolado.** Trocar a expressão
   `15,45 * * * *` por `10,25,40,55 * * * *`. Continua sendo um único Cron
   Trigger, então o limite de 5 por conta do Workers Free não muda. Os minutos
   evitam `:00` (ramo horário) e `:05`/`:35` (ramo `5,35`). Isso exige alterar
   a comparação de `controller.cron` no Worker e a lista de crons em
   `scripts/deploy/prepare-central-candidate.py`, num PR próprio e autorizado.
2. **Piso de 25 minutos, sem `force: true`.** O ramo isolado chama a renovação
   com piso de 25 minutos (hoje `MIN_REFRESH_MS` é 50). Ela audita a cada 30
   minutos e pula no tique intermediário. A deduplicação entre tiques fica
   exclusivamente com esse piso sobre `measured_at`, que a função já aplica sem
   `force`. **Sem reserva no KV:** o KV não tem compare-and-set; gravações
   concorrentes na mesma chave terminam com a última vencendo, então uma
   "reserva" não daria exclusão mútua. Duas execuções concorrentes, no pior
   caso, fazem uma auditoria a mais, ambas somente leitura.
3. **Isentar somente essa renovação de `dbEconomySkip`.** As outras consultas
   ao banco continuam em 00/06/12/18 UTC.
4. **Tirar a prova do ramo horário.** O ramo `0 * * * *` mantém
   `recordLaunchEpoch` e o alerta de prova vencida com vendas abertas, mas para
   de chamar `refreshFinancialProofSnapshot`. Isso elimina até 20 auditorias
   falhas, até 40 instruções SQL e até 20 gravações não verificadas por dia, e
   remove o risco de um 409 sem orçamento invalidar uma prova válida.
5. **Gravar `zpc:financial-proof:last-isolated-run:v1` só depois de uma
   auditoria real.** Hoje ela é gravada em toda execução não pulada; com o piso,
   um tique que devolve `recent_snapshot` não deve gravá-la. Opcional, para
   decisão do proprietário: gravá-la só em falha ou mudança de desfecho, porque
   o `measured_at` da prova válida já mostra o último sucesso. Isso corta mais
   cerca de 46 gravações por dia, mas muda o significado do campo
   `financial_proof.last_isolated_run` em `/api/status`.
6. **Batimento estável.** O batimento `zpc:cron:v1:isolated` deve registrar a
   mesma categoria para `proven` e `recent_snapshot` (por exemplo `ok`). Como
   `putBeat` só regrava quando o desfecho muda ou o registro tem 50 minutos ou
   mais, alternar `ok`/`skipped` a cada tique custaria 96 gravações por dia; com
   categoria estável, são cerca de 24.
7. **Alerta com limite de frequência.** Com vendas fechadas, a prova vencida
   não bloqueia receita: basta o batimento. Com vendas abertas, manter o alerta
   existente, limitado a no máximo um por hora.
8. **GitHub só como reforço.** O workflow do GitHub fica apenas como
   reforço/diagnóstico quando o estado comercial autorizar, nunca como relógio
   primário.

A proposta continua fail-closed: `verifyFinancialProofSnapshot` segue exigindo
SHA exato, idade de 65 minutos ou menos e `ambiguous=0`; 503 transitório não
apaga a prova válida, 409 a invalida, e nada sintetiza PASS.

## Custo por dia: atual × proposto

Valores derivados do código, com vendas fechadas e sem data de lançamento
gravada (sem ela, a contagem de checkouts não consulta o banco). `N` é o número
de pagamentos em `financial_events` (no máximo 40). Valores "até" assumem que
cada tentativa chega à etapa indicada. Não substituem a medição exigida
na seção seguinte.

| Recurso (só P22 e preflight horário) | Atual | Proposto | Diferença | Limite do Free |
|---|---|---|---|---|
| Invocações de cron do Worker central | 120 (24 + 48 + 48) | 168 (24 + 96 + 48) | +48 | 100.000 requisições/dia; a conta usou 35.366 a 63.403 por dia entre 24 e 26/10 |
| Auditorias da prova | 4 bem-sucedidas + até 20 falhas | 48 | +24 tentativas | — |
| Instruções SQL no Neon (prova) | 8 + até 40 | 96 | +48 no máximo | egress: count de 1 linha + até 41 linhas curtas por auditoria (alguns KB); 5 GB/mês |
| `select 1` do preflight | 24 | 24 | 0 | — |
| Subrequisições externas por invocação da prova | até 48 (2 SQL + até 46 GETs MP, `/users/me` e retentativas incluídos) | igual | 0 | 50 por invocação |
| Subrequisições externas por dia (prova) | 4 × (3 + N) + falhas truncadas no ramo horário | 48 × (3 + N) | — | sem limite diário; checar limite de taxa do Mercado Pago |
| Gravações no KV | cerca de 56 (batimento 28, prova 4, `last-isolated-run` 4, snapshot não verificado do ramo horário até 20) | cerca de 120 (prova 48, `last-isolated-run` 48, batimento 24); cerca de 74 com o item 5 opcional | +64 (ou +18) | 1.000/dia; a conta usou 568 a 694 por dia entre 20 e 26/10 |
| Leituras no KV | cerca de 148 (ramo isolado 104, ramo horário 44) | cerca de 240 (prova 96, batimento 96, data de lançamento 48) | +92 | 100.000/dia; a conta usou 22 mil a 41 mil por dia |
| `list` no KV | 0 da prova (24 do preflight) | 0 da prova (24 do preflight) | 0 | 1.000/dia |
| `delete` no KV | 0 | 0 | 0 | 1.000/dia |

Leitura das gravações: a pior soma diária medida (694 em 24/10) mais 64 dá
758, abaixo de 1.000, mas acima do `SHED_AT_PCT=70` (700) em que prefixos de
observabilidade começam a ser descartados. Com o item 5 opcional, o saldo fica
em +18 (712 no pior dia). A decisão entre as duas variantes é do proprietário
e depende do resultado da investigação do alerta de KV (seção abaixo).

Limites conferidos na documentação da Cloudflare:

- KV no Workers Free: 100.000 leituras, 1.000 gravações, 1.000 exclusões e
  1.000 `list` por dia, zerados às 00:00 UTC; ao exceder qualquer um, as
  operações daquele tipo falham
  (<https://developers.cloudflare.com/workers/platform/pricing/#workers-kv>,
  <https://developers.cloudflare.com/kv/platform/limits/>);
- Workers Free: 100.000 requisições por dia, 50 subrequisições externas e 1.000
  subrequisições a serviços da Cloudflare por invocação, 5 Cron Triggers por
  conta (<https://developers.cloudflare.com/workers/platform/limits/>);
- KV: gravações podem levar até 60 segundos para aparecer em outros locais, e
  em gravações concorrentes na mesma chave vale a última
  (<https://developers.cloudflare.com/kv/api/write-key-value-pairs/>).

## Alerta de limite diário do KV

O proprietário recebeu um e-mail de limite diário do KV. A análise abaixo usa
os dados que o próprio projeto mede e não substitui a conferência no painel.

**Dados medidos.** `scripts/audit/command-center-snapshot.mjs` consulta
`kvOperationsAdaptiveGroups` (GraphQL da Cloudflare, conta inteira) e publica
`kvQuota` nas anotações. Pico de cada dia UTC, extraído pela auditoria de cerca
de 150 runs:

| Dia UTC | Gravações (put + delete) | Leituras |
|---|---|---|
| 20/10 | 594 | 22.187 |
| 21/10 | 653 | 22.845 |
| 22/10 | 568 | 29.359 |
| 23/10 | 604 | 29.614 |
| 24/10 | 694 | 41.431 |
| 25/10 | 569 | 35.503 |
| 26/10 | 571 | 25.201 |
| 27/10 (parcial, 13:08Z) | 339 | 16.061 |

**Conclusões:**

1. Pela medição da própria conta, nem gravações (1.000/dia) nem leituras
   (100.000/dia) chegaram ao limite entre 20 e 27/10. O snapshot soma put e
   delete, que têm limites separados de 1.000; como a soma ficou abaixo de 700,
   nenhum dos dois estourou.
2. A P22 atual contribui pouco: cerca de 56 gravações por dia (cerca de 9% do
   total).
3. **Hipótese principal, não medida:** o alerta se refere a operações `list`
   (limite de 1.000/dia), que o snapshot não mede. Lists recorrentes
   identificadas no código: `syncSharedActivity` do edge (cerca de 96/dia),
   `kvList` do snapshot do Command Center (cerca de 8 por run, cerca de 200/dia),
   `runOwnerAlertDigest` (24), `runSalesPreflight` (24), `runRefundWatchdog`
   (24 ou mais, paginado), `operational-activity-sync` (4) e `data-backup`
   (paginado, diário), além de rotas sob demanda que fazem list. O piso dos
   crons fica em cerca de 370 a 400 por dia; um backup paginado grande ou
   chamadas repetidas a rotas com list bastariam para passar de 1.000.
4. Explicações alternativas não excluídas: o e-mail se refere a outra conta da
   Cloudflare, é aviso de limiar e não de esgotamento, ou trata de um dia fora
   da janela medida (o projeto registra um esgotamento real em 12/10).

**Recomendações (somente propostas; nada foi alterado):**

1. O proprietário confere no painel da Cloudflare (KV → Metrics ou
   Account → Usage) as operações por tipo, **incluindo `list`**, em 25 e 26/10,
   além do texto exato, da data e da conta do e-mail.
2. Incluir `list` no `kvQuota` do snapshot, separar `delete` de `write` e
   comparar cada tipo com o próprio limite.
3. Cortar lists recorrentes: `syncSharedActivity` só com marcador de pendência
   ou de hora em hora; índice diário em chave única no lugar dos lists do
   snapshot; `runSalesPreflight` verificando os arquivos de produto por `get` de
   chaves conhecidas em vez de `list`.
4. Na P22, não acrescentar nenhum `list` e preferir a variante com o item 5
   opcional se a folga de gravações for o gargalo.

## Prova necessária antes de ativar

Somente Sol e o proprietário podem decidir pela implementação. Um PR posterior
deve permanecer sem deploy até existir autorização e deve demonstrar:

- teste de 24 horas com vendas fechadas, sem dados pessoais, com ao menos 46 de
  48 renovações esperadas e lacuna máxima entre provas válidas menor ou igual a
  65 minutos, inclusive com um tique derrubado de propósito;
- P22 continuamente `PROVEN` após a primeira prova, salvo falha real de
  provedor/banco, que deve continuar `UNVERIFIED_FAIL_CLOSED`;
- dois tiques concorrentes sem prova inválida e sem gravação além do previsto;
  reinício no meio da auditoria com recuperação no tique seguinte;
- o ramo horário sem chamada à renovação, com o batimento horário registrando
  a ausência;
- contagem medida de subrequisições por invocação, CPU, leituras, gravações e
  `list` no KV (painel da Cloudflare) e egress do Neon, comparada com a tabela
  de custo acima;
- falha simulada do GitHub Actions durante toda a janela, provando que a
  renovação continua pelo Worker;
- restauração explícita do comportamento anterior após o ensaio, se os limites
  gratuitos ou o orçamento não forem comprovados.

Este documento não muda cron, workflow, chave, credencial, flag comercial ou
runtime; não faz deploy e não autoriza a proposta.
