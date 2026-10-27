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

Revisão 3 (reauditoria de `0afaf51a` e checagens C1–C3):
- registra o defeito pré-existente "resultado antigo sobrescreve um novo";
- especifica a guarda monotônica e os critérios de aceite C3;
- apresenta os deltas de custo como faixas;
- separa fato, inferência e hipótese no ramo horário;
- distingue os tipos de falha na margem;
- qualifica os limites de subrequisição;
- estima a concorrência entre produtores com vendas abertas.

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
   (`MIN_REFRESH_MS`). Como a prova nasce às `:15` das horas 00, 06, 12 e 18,
   às `:00` seguintes ela tem 45 minutos e o ramo pula; nas outras 20 horas do
   dia ela já venceu e o ramo **tenta auditar**. Detalhes na seção seguinte.
3. **GitHub Actions (produtor condicional).** O workflow
   `.github/workflows/order12a-financial-proof-renewal.yml` está configurado em
   `11,41 * * * *`. Seu script chama, por GET assinado, o endpoint
   `/api/internal/audit/financial-classification`; o Worker persiste o snapshot
   validado via `persistClassificationSnapshot`. Com vendas fechadas, porém,
   `scripts/financial_proof_renewal.py` encerra antes do GET assinado com
   `OWNER_SALES_SWITCH_NOT_OPEN`. Assim, esse caminho não renova P22 no estado
   atual e não pode explicar os pulsos em `:15`.

## O ramo horário: fato, inferência e hipótese

**Fato, pelo código** (`worker/cloudflare-worker.compat.mjs`, ramo final de
`scheduled`; `worker/commercial-metrics-projection.mjs`;
`worker/internal-financial-audit.mjs`; `runSalesPreflight` em
`worker/cloudflare-worker.recovered.mjs`):

- toda hora, sem gate de economia, `runSalesPreflight` faz um GET
  `/users/me` no Mercado Pago, um `select 1` no banco, um `kv.list` (prefixo dos
  arquivos de produto) e grava `zpc-sales-preflight:v1`: 24 `select 1`, 24
  `list` e 24 gravações por dia;
- em 20 das 24 horas o código manda tentar a auditoria da prova. Cada tentativa
  custa um GET `/users/me`, duas instruções SQL (`count` em `orders` e até 41
  linhas de `financial_events`) e um GET por pagamento (até 40; orçamento de 46
  GETs com retentativas);
- quando a auditoria não verifica e a prova anterior não é válida (o caso das
  20 horas), `refreshFinancialProofSnapshot` grava um snapshot não verificado:
  **até cerca de 20 gravações por dia** no KV, todas inúteis para P22;
- tudo isso corre em paralelo com outras oito tarefas da mesma invocação
  (suporte, entrega, nutrição, digest, reembolso, pós-venda e o `scheduled`
  legado). O Workers Free limita cada invocação a **50 subrequisições
  externas + 1.000 para serviços Cloudflare** (KV entra no segundo limite).
  O próprio ramo `15,45` foi criado porque a verificação MP usa até 46 das 50
  externas.

**Fato, por evidência observada:**

- nas 230 sondagens não houve nenhuma transição para `PROVEN` às `:00`; todas
  aconteceram depois das `:15` (00:20, 06:20 e 12:20 com idade 5; 19:00 com
  idade 45). Logo, o ramo horário **nunca produziu `PROVEN`** na janela
  observada;
- o batimento horário `zpc:cron:v1:hourly`, publicado como `serverCycle` nas
  anotações `COMMAND_CENTER` do workflow `command-center-snapshot`, registra a
  tarefa `nurture` como `fail:Error connecting to database: Error: Too many
  subrequests by single Worker invocation` em 10 dos 66 batimentos distintos
  observados entre 24 e 27/10. O campo `at` desse resumo é o `finishedAt` do
  batimento (`scripts/audit/command-center-snapshot.mjs`).

| `finishedAt` do batimento horário | Run do Command Center que o publicou |
|---|---|
| 2026-10-24T03:00:55.692Z | 40060163462 |
| 2026-10-24T08:00:56.334Z | 40078330078 |
| 2026-10-24T09:00:56.066Z | 40081999241 |
| 2026-10-24T10:00:57.201Z | 40087751026 |
| 2026-10-24T14:00:55.957Z | 40102746586 |
| 2026-10-24T16:00:58.391Z | 40112097617 |
| 2026-10-25T06:01:05.285Z | 40167806394 |
| 2026-10-25T18:00:58.271Z | 40220263458 |
| 2026-10-27T00:00:58.779Z | 40426930092 |
| 2026-10-27T06:01:05.875Z | 40459578765 |

O orçamento externo da invocação horária, portanto, **se esgota de fato**, ao
menos nessas horas.

**Inferência (do código, não observada):** na janela das sondagens, o ramo
horário teria tentado auditar em cerca de 16 horas (19 tiques de 20:00 a 14:00,
menos 01, 07 e 13). As sondagens não distinguem "tentou e falhou" de "não
chegou a tentar".

**Hipótese (não verificada; sem logs do Worker e sem a tarefa da prova no
batimento horário):** a auditoria da prova falha por falta de subrequisições
externas. Os GETs de pagamento são sequenciais, então a auditoria é a tarefa
mais longa da invocação; quando o orçamento acaba, `fetch` lança, `mpGet`
devolve status 0 e o resultado vira 503 (`production_token_unverified`) ou
409 (pagamentos ambíguos). Antes de a auditoria começar, a invocação já fez ao
menos duas subrequisições externas (`/users/me` e `select 1` do preflight),
mais o despacho do suporte por service binding. A documentação da Cloudflare
diz apenas que uma chamada por service binding "counts toward your subrequest
limit", sem dizer qual dos dois limites; essa classificação fica ambígua.

**O que enfraquece a hipótese:** em 2026-10-26, das 20h às 23h UTC, o
`nurture` terminou `ok` (sem esgotamento registrado) e mesmo assim não houve
`PROVEN` às `:00`. O esgotamento observado não cobre todas as horas de falha.

**Hipóteses alternativas não excluídas:**
- o limite de 6 conexões de saída simultâneas por invocação, com oito tarefas
  em paralelo;
- o limite de CPU (10 ms no Free) ou de duração da invocação;
- um erro de banco não relacionado ao orçamento.

O ponto exato da falha da prova (etapa, exceção e contagens) **não está
provado**. Para prová-lo, basta registrar no batimento horário a categoria
devolvida por `refreshFinancialProofSnapshot` (proposta, não implementada).

**Risco latente do ramo horário:** hoje a prova nunca está entre 50 e 65 minutos
às `:00`, então o ramo horário nunca a encontra válida e envelhecida. Em
qualquer desenho que renove fora das `:15`, ou depois de um tique falho, isso
pode acontecer. Nesse caso, um 409 causado por GETs sem orçamento
**invalidaria uma prova válida**, porque `refreshFinancialProofSnapshot` grava
o snapshot não verificado sempre que o código é 409 (`mpGet` converte a
exceção em status 0, e status 0 é classificado como ambíguo). Por isso a
proposta tira a prova do ramo horário.

## Defeito pré-existente: resultado antigo sobrescreve um novo

**Confirmado pelo código; não observado em produção.** Nenhum dos dois
caminhos que gravam a prova compara o `measured_at` já gravado antes de gravar,
e o KV aplica "a última gravação vence":

- `worker/commercial-metrics-projection.mjs:85`: em
  `refreshFinancialProofSnapshot`, `now` é fixado no início da chamada;
- `worker/commercial-metrics-projection.mjs:91`: a prova anterior é lida uma
  única vez, antes da auditoria (linha 99);
- `worker/commercial-metrics-projection.mjs:111` e `:117`: o snapshot é gravado
  sem reler nem comparar o `measured_at` armazenado;
- `worker/commercial-metrics-projection.mjs:168`: `persistClassificationSnapshot`
  usa `now=Date.now()` no momento de **persistir**, não no da leitura dos
  provedores;
- `worker/commercial-metrics-projection.mjs:173`: grava sem comparar;
- `worker/cloudflare-worker.compat.mjs:168`: o caminho do GitHub chama
  `persistClassificationSnapshot` sem passar o instante da leitura.

Cenário de FRESH falso:
1. uma auditoria A, verificada, começa;
2. uma auditoria B, mais nova, encontra pagamento ambíguo e grava 409;
3. A termina depois e grava `PROVEN` por cima de B.

A prova "ressuscitada" é aceita por até 65 minutos, contra a leitura mais
recente. No caminho do GitHub o efeito é pior, porque o carimbo de gravação
faz a leitura antiga parecer mais nova do que é.

Com vendas abertas, os produtores ficam próximos:
- hoje, GitHub `11,41` e Worker `15,45` têm 4 minutos de distância;
- no desenho proposto (`10,25,40,55`), a distância cairia para 1 minuto.

O caminho do GitHub só grava resultado verificado, então o par de risco é
"Worker grava 409, GitHub grava verificado antigo" ou dois refresh do Worker
sobrepostos.

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
horário, que não tem gate de economia, tenta renovar mas falha (causa não
provada; orçamento de subrequisições é a hipótese principal) e só gera custo. O
produtor do GitHub está sujeito ao agendador não determinístico e bloqueado por
desenho quando vendas estão fechadas.

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

- **atraso do tique e duração da auditoria (medidos pelo fim):** o batimento
  isolado registra `finishedAt`, não o início. Nos tiques pulados ele termina
  por volta de `:45:41`, então o início do tique atrasa até cerca de 41
  segundos. Nos tiques com auditoria ele termina entre `:15:48` e `:16:02`,
  então a auditoria real dura cerca de 10 a 20 segundos. O pior caso limitado
  pelo código (46 GETs com timeout de 7 s, mais as pausas de retentativa) passa
  de 5 minutos;
- **`measured_at` é o início:** a gravação vem depois da auditoria;
- **propagação do KV:** uma gravação pode levar até 60 segundos para ficar
  visível em outros locais (documentação do Workers KV).

**Tipos de falha:**
- tique ausente, atrasado ou que termina em 503 (provedor ou banco
  indisponível): a prova válida anterior é preservada e a margem abaixo vale;
- 409 (pagamento ambíguo, inclusive o `ambiguous_transient` de 429/5xx do
  Mercado Pago): a prova é **apagada na hora**, em qualquer cadência. Nenhuma
  margem protege contra isso, e é o comportamento fail-closed desejado.

Idade da prova no momento da renovação (valores nominais, antes dos atrasos;
"falho" significa ausente, atrasado ou 503):

| Desenho | Renovação normal | Com um tique falho | Com dois tiques falhos | Auditorias/dia | Tique com 409 |
|---|---|---|---|---|---|
| Revisão 1: tiques de 30 min (`15,45`), piso 50 | 60 (margem 5) | 90: vence | vence | 24 | apaga na hora |
| Tiques de 30 min (`15,45`), piso 25 (renova em todo tique) | 30 (margem 35) | 60 (margem 5, menos atrasos) | 90: vence | 48 | apaga na hora |
| Tiques de 15 min, piso 40 | 45 (margem 20) | 60 (margem 5, menos atrasos) | 75: vence | 32 | apaga na hora |
| **Tiques de 15 min, piso 25 (recomendado)** | **30 (margem 35)** | **45 (margem 20)** | 60 (margem 5, menos atrasos) | 48 | apaga na hora |

Só o último desenho mantém a prova dentro do TTL de 65 com um tique atrasado ou
falho (503) **e** com folga para os atrasos acima. A margem efetiva fica em
cerca de 33 minutos no caso normal e cerca de 18 com um tique falho. Os
desenhos com margem de 5 minutos depois de uma falha dependem de a auditoria e
a propagação terminarem em menos de cerca de 3 minutos, o que não está
garantido.

## Proposta (não implementada)

Recomenda-se manter a renovação em um **cron já existente do Worker da
Cloudflare**, independente do agendador do GitHub, e separar a política da
prova financeira das demais tarefas caras:

1. **Cadência de 15 minutos no ramo isolado.** Trocar a expressão
   `15,45 * * * *` por `10,25,40,55 * * * *`. Continua sendo um único Cron
   Trigger, então o limite de 5 Cron Triggers por conta do Workers Free não
   muda. Os minutos evitam `:00` (ramo horário) e `:05`/`:35` (ramo `5,35`).
   Isso exige alterar a comparação de `controller.cron` no Worker e a lista de
   crons em `scripts/deploy/prepare-central-candidate.py`, num PR próprio e
   autorizado.
2. **Piso de 25 minutos, sem `force: true`.** O ramo isolado chama a renovação
   com piso de 25 minutos (hoje `MIN_REFRESH_MS` é 50). Ela audita a cada 30
   minutos e pula no tique intermediário. A deduplicação entre tiques fica com
   esse piso sobre `measured_at`, que a função já aplica sem `force`, mais a
   guarda monotônica do item 3. **Sem reserva no KV:** o KV não tem
   compare-and-set; gravações concorrentes na mesma chave terminam com a última
   vencendo, então uma "reserva" não daria exclusão mútua.
3. **Guarda monotônica contra resultado antigo.** Todo snapshot carrega o
   instante de início da leitura dos provedores (`measured_at`). As regras:
   - **o caminho do GitHub carimba no início da leitura**, não ao persistir:
     `financialClassification` devolve o instante e
     `persistClassificationSnapshot` o recebe em vez de `Date.now()`;
   - antes de gravar, o produtor relê o snapshot armazenado e só grava se o seu
     `measured_at` for **estritamente mais novo**. Em empate, 409 vence;
   - todo 409 grava também um marcador de invalidação com o `measured_at` da
     auditoria que o produziu;
   - leitores só aceitam um snapshot verificado se ele tiver 65 minutos ou menos
     **e** for mais novo que o último marcador de invalidação.
4. **Isentar somente essa renovação de `dbEconomySkip`.** As outras consultas
   ao banco continuam em 00/06/12/18 UTC. O ramo isolado deixa de ler
   `sales:open:v1` (se a leitura for mantida, somam-se 96 leituras por dia).
5. **Tirar a prova do ramo horário.** O ramo `0 * * * *` mantém
   `recordLaunchEpoch` e o alerta de prova vencida com vendas abertas, mas para
   de chamar `refreshFinancialProofSnapshot`. Isso elimina até 20 auditorias
   falhas, até 40 instruções SQL e até 20 gravações não verificadas por dia, e
   remove o risco de um 409 sem orçamento invalidar uma prova válida.
6. **Gravar `zpc:financial-proof:last-isolated-run:v1` só depois de uma
   auditoria real.** Hoje ela é gravada em toda execução não pulada; com o piso,
   um tique que devolve `recent_snapshot` não deve gravá-la. Opcional, para
   decisão do proprietário: gravá-la só em falha ou mudança de desfecho, porque
   o `measured_at` da prova válida já mostra o último sucesso. Isso corta mais
   cerca de 46 gravações por dia, mas muda o significado do campo
   `financial_proof.last_isolated_run` em `/api/status`.
7. **Batimento estável.** O batimento `zpc:cron:v1:isolated` deve registrar a
   mesma categoria para `proven` e `recent_snapshot` (por exemplo `ok`). Como
   `putBeat` só regrava quando o desfecho muda ou o registro tem 50 minutos ou
   mais, alternar `ok`/`skipped` a cada tique custaria 96 gravações por dia; com
   categoria estável, são cerca de 24.
8. **Alerta com limite de frequência.** Com vendas fechadas, a prova vencida
   não bloqueia receita: basta o batimento. Com vendas abertas, manter o alerta
   existente, limitado a no máximo um por hora.
9. **GitHub só como reforço, fora da janela do Worker.** O workflow do GitHub
   fica apenas como reforço/diagnóstico quando o estado comercial autorizar,
   nunca como relógio primário. Ao ser reativado, deve sair de `11,41` para
   minutos a pelo menos 5 minutos dos tiques do Worker (por exemplo `17,47`,
   a 7 ou 8 minutos), para que a releitura da guarda não caia na janela de
   propagação do KV.

A proposta continua fail-closed: `verifyFinancialProofSnapshot` segue exigindo
SHA exato, idade de 65 minutos ou menos e `ambiguous=0`; 503 transitório não
apaga a prova válida, 409 a invalida, e nada sintetiza PASS.

## Garantia contra FRESH falso: limites do KV e risco residual

O KV não oferece compare-and-set. Gravações concorrentes na mesma chave
terminam com a última vencendo, e uma gravação leva até 60 segundos para ser
vista em outros locais. Por isso a releitura da guarda do item 3 pode estar
defasada.

**Risco residual com a guarda e o marcador:**
- **corrida na guarda:** dois produtores com desfechos opostos gravam a menos
  de cerca de 60 segundos um do outro, em locais diferentes. O resultado antigo
  pode passar pela guarda e ficar armazenado;
- **efeito limitado pelo marcador:** o marcador de invalidação, com o
  `measured_at` da auditoria 409, faz os leitores rejeitarem o snapshot antigo
  assim que o marcador se propaga. A partir daí o estado é
  `UNVERIFIED_FAIL_CLOSED` até uma auditoria verificada estritamente mais nova,
  o que é a recuperação correta;
- **janela de FRESH falso:** fica restrita aos leitores de locais onde o
  marcador ainda não chegou, por até cerca de 60 segundos. É a mesma
  defasagem que qualquer leitura do KV já tem para o próprio 409;
- **frequência:** com a separação do item 9, a corrida exige um atraso
  anormal de minutos em um dos produtores. Sem a separação, haveria até 48
  pares próximos por dia com vendas abertas.

**Desenho sem nenhum FRESH falso (opção, para decisão de Sol e do
proprietário):**
- a autoridade da prova passa para o Postgres: uma linha única com
  `measured_at`, desfecho e sequência;
- a linha é atualizada por `update … where measured_at < $novo` (atômico e
  monotônico) ou por `insert … on conflict do update … where`;
- o KV vira cache derivado da linha confirmada;
- a decisão de liberar venda (`commercial_release_allowed` com vendas abertas)
  consulta a linha do banco, e as superfícies de exibição podem continuar no KV
  com a defasagem de até 60 segundos declarada.

O custo é uma instrução SQL por gravação (até mais 48 por dia) e uma por
decisão de liberação com vendas abertas, a ser medido junto com o egress do
Neon.

## Custo por dia: atual × proposto

Valores derivados do código, com vendas fechadas e sem data de lançamento
gravada (sem ela, a contagem de checkouts não consulta o banco). `N` é o número
de pagamentos em `financial_events` (no máximo 40). Os valores atuais são
faixas: o mínimo supõe que as tentativas horárias não chegam ao SQL nem à
gravação; o máximo supõe que chegam. Por isso os deltas também são faixas. Não
substituem a medição exigida nos critérios de aceite.

| Recurso (P22 e preflight horário) | Atual | Proposto | Diferença | Limite do Free |
|---|---|---|---|---|
| Invocações de cron do Worker central | 120 (24 + 48 + 48) | 168 (24 + 96 + 48) | +48 | 100.000 requisições/dia; a conta usou 35.366 a 63.403 por dia entre 24 e 26/10 |
| Auditorias concluídas | 4 | 48 | +44 | — |
| Auditorias tentadas e falhas (ramo horário) | 0 a 20 | 0 | −20 a 0 | — |
| Instruções SQL no Neon (prova) | 8 a 48 (8 + 0 a 40) | 96 | +48 a +88 | egress: count de 1 linha + até 41 linhas curtas por auditoria (alguns KB); 5 GB/mês |
| `select 1` do preflight | 24 | 24 | 0 | — |
| Subrequisições externas por invocação da prova | até 48 (2 SQL + até 46 GETs MP, `/users/me` e retentativas incluídos) | igual | 0 | 50 externas + 1.000 para serviços Cloudflare |
| GETs MP concluídos por dia (prova) | 4 × (1 + N) + parte truncada no ramo horário | 48 × (1 + N) | — | sem limite diário do Workers; checar limite de taxa do Mercado Pago |
| Retentativas MP | até 6 por auditoria, dentro do orçamento de 46 | igual | — | — |
| Gravações tentadas no KV | 60 a 80 (batimento 28, prova 4, `last-isolated-run` 4, não verificadas 0 a 20, preflight 24) | 144 (prova 48, `last-isolated-run` 48, batimento 24, preflight 24); 98 com o item 6 opcional | +64 a +84 (ou +18 a +38) | 1.000/dia; a conta usou 568 a 694 por dia entre 20 e 26/10 |
| Gravações efetivas no KV | igual às tentadas abaixo de 70% da cota; acima disso, o batimento (`zpc:cron:v1`, descartável) é cortado | igual | — | — |
| Leituras no KV | cerca de 148 (ramo isolado 104, ramo horário 44) | cerca de 240 (prova 96, batimento 96, data de lançamento 48) | +92 | 100.000/dia; a conta usou 22 mil a 41 mil por dia |
| `list` no KV | 0 da prova (24 do preflight) | 0 da prova (24 do preflight) | 0 | 1.000/dia |
| `delete` no KV | 0 | 0 | 0 | 1.000/dia |

Leitura das gravações:
- a pior soma diária medida (694 em 24/10) mais 64 a 84 dá **758 a 778**,
  abaixo de 1.000, mas acima do `SHED_AT_PCT=70` (700), a partir do qual
  prefixos de observabilidade começam a ser descartados;
- com o item 6 opcional, o saldo fica em +18 a +38 (712 a 732 no pior dia);
- a guarda do item 3 só acrescenta gravações quando há 409 (o marcador);
- a decisão entre as duas variantes é do proprietário e depende do resultado
  da investigação do alerta de KV (seção abaixo).

**Concorrência entre produtores com vendas abertas** (estimativa pelo código;
com data de lançamento gravada, cada auditoria soma 1 SQL de contagem de
checkouts, total de 3):

| Recurso por dia | Atual | Proposto (com item 9) |
|---|---|---|
| Auditorias do Worker | 48 (ramo `15,45` com `force` em todo tique; o horário pula enquanto a prova tem menos de 50 min) | 48 (piso de 25) |
| Auditorias do GitHub | até 48 nominais; cerca de 5 por dia no ritmo observado | igual |
| Instruções SQL | 3 × (48 + 5 a 48) = 159 a 288 | igual |
| Gravações da prova | 48 a 96 | 48 a 96, menos as recusadas pela guarda |
| Distância entre produtores | 4 min (`11,41` × `15,45`) | 7 a 8 min (`17,47` × `10,25,40,55`); sem o item 9, 1 min |

Limites conferidos na documentação da Cloudflare:

- KV no Workers Free: 100.000 leituras, 1.000 gravações, 1.000 exclusões e
  1.000 `list` por dia, zerados às 00:00 UTC; ao exceder qualquer um, as
  operações daquele tipo falham
  (<https://developers.cloudflare.com/workers/platform/pricing/#workers-kv>,
  <https://developers.cloudflare.com/kv/platform/limits/>);
- Workers Free: 100.000 requisições por dia, 50 subrequisições externas e 1.000
  subrequisições a serviços da Cloudflare por invocação, 6 conexões de saída
  simultâneas e 5 Cron Triggers por conta
  (<https://developers.cloudflare.com/workers/platform/limits/>);
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
2. A P22 atual contribui pouco: 36 a 56 gravações por dia (cerca de 9% do
   total no máximo), mais as 24 do preflight.
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
4. Na P22, não acrescentar nenhum `list` e preferir a variante com o item 6
   opcional se a folga de gravações for o gargalo.

## Critérios de aceite antes de ativar

Somente Sol e o proprietário podem decidir pela implementação. Um PR posterior
deve permanecer sem deploy até existir autorização. Em todos os cenários vale
o mesmo requisito: **nenhum FRESH falso, vencimento reconhecido em até 65
minutos e recuperação correta**.

| Cenário (C3) | Como provocar | Resultado exigido |
|---|---|---|
| Um tique ausente | derrubar um tique de propósito | prova continua `PROVEN` (idade 45 no tique seguinte) e é renovada |
| Dois tiques consecutivos ausentes | derrubar dois tiques seguidos | prova ainda válida no tique seguinte aos dois falhos (idade 60, margem nominal 5) ou vencida e reconhecida como `UNVERIFIED_FAIL_CLOSED` se os atrasos passarem de 5 min; renovação no tique seguinte |
| Execução atrasada | atrasar a auditoria em alguns minutos | `measured_at` continua marcando o início; nenhum snapshot com idade acima de 65 aceito |
| Dois produtores simultâneos | GitHub `11,41` e Worker `10,25,40,55` com vendas abertas (e repetir com `17,47`) | nenhum snapshot mais antigo substitui um mais novo; nenhum FRESH falso além da janela de propagação declarada |
| Resultado antigo depois de um novo | auditoria verificada lenta terminando depois de um 409 mais novo | a gravação antiga é recusada pela guarda ou rejeitada pelo marcador; estado `UNVERIFIED_FAIL_CLOSED` até auditoria verificada mais nova |
| Erro de banco seguido de recuperação | 503 do banco com prova válida armazenada e, depois, banco de volta | prova válida preservada enquanto tiver até 65 min, vencimento reconhecido se passar disso, renovação no primeiro tique com banco de volta |

Além dos cenários, o PR deve demonstrar:

- teste de 24 horas com vendas fechadas, sem dados pessoais, com ao menos 46 de
  48 renovações esperadas e lacuna máxima entre provas válidas menor ou igual a
  65 minutos;
- P22 continuamente `PROVEN` após a primeira prova, salvo falha real de
  provedor/banco, que deve continuar `UNVERIFIED_FAIL_CLOSED`;
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
