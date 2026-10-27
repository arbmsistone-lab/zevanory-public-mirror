# P22 — investigação da renovação da prova financeira

Status: **diagnóstico e proposta; nada ativado**. Base examinada:
`gh-pages@a098d8802a184df02b362d46f08fb6c81b7382f9`. Vendas permanecem
fechadas (`NO-GO`).

## Sintoma e contrato

O conjunto observado teve 177 sondagens: 31 `PROVEN` e 146
`UNVERIFIED_FAIL_CLOSED`. O coletor B0 aceita a prova por 65 minutos
(`P22_TTL_MIN` em `scripts/b0/b0-lib.mjs`), igual ao limite aplicado pelo
runtime (`MAX_AGE_MS` em `worker/commercial-metrics-projection.mjs`). O objeto
fica no KV por duas horas, mas depois de 65 minutos sua presença já não o torna
válido. Portanto, uma renovação a cada seis horas produz aproximadamente 65
minutos de `PROVEN` e 295 minutos de `UNVERIFIED_FAIL_CLOSED` em cada ciclo.

## Quem produz a prova

Há dois produtores do mesmo snapshot derivado
`zpc-production-financial-metrics:v1`:

1. **Worker central da Cloudflare (produtor efetivo com vendas fechadas).** O
   cron `15,45 * * * *` entra no ramo isolado de
   `worker/cloudflare-worker.compat.mjs`, executa
   `refreshFinancialProofSnapshot(..., force: true)` e grava o snapshot após
   leituras verificadas. Porém, antes disso, `dbEconomySkip` só deixa consultar
   o banco quando a hora UTC é múltipla de 6 e o minuto é menor que 30. Entre
   os dois tiques do cron, apenas `00:15`, `06:15`, `12:15` e `18:15` passam.
   O teste `tests/db-economy.test.mjs` codifica exatamente quatro horas por dia
   e dois crons consultores, confirmando que essa redução é intencional para
   conter egress do Neon Free.
2. **GitHub Actions (produtor condicional).** O workflow
   `.github/workflows/order12a-financial-proof-renewal.yml` está configurado em
   `11,41 * * * *`. Seu script chama, por GET assinado, o endpoint
   `/api/internal/audit/financial-classification`; o Worker persiste o snapshot
   validado via `persistClassificationSnapshot`. Com vendas fechadas, porém,
   `scripts/financial_proof_renewal.py` encerra antes do GET assinado com
   `OWNER_SALES_SWITCH_NOT_OPEN`. Assim, esse caminho não renova P22 no estado
   atual e não pode explicar os pulsos em `:15`.

## Cadência configurada × real

| Caminho | Configuração | Com vendas fechadas | Evidência real |
|---|---|---|---|
| Cloudflare Worker | `15,45 * * * *` (48 invocações/dia) | `dbEconomySkip` admite somente o tique `:15` em 00/06/12/18 UTC: 4 tentativas/dia | O reaparecimento observado em aproximadamente 18:15, 00:15 e 06:15 UTC coincide com o ramo permitido |
| GitHub Actions | `11,41 * * * *` (48 oportunidades/dia) | o job inicia, mas a renovação é recusada antes da auditoria enquanto o interruptor do proprietário está fechado | API de runs: de 2026-10-26 01:37:34Z a 2026-10-27 10:26:19Z houve 7 runs agendados em 32 h 49 min; seis intervalos entre 3 h 54 min e 7 h 14 min, média 5 h 28 min; os 7 falharam. O run 40488464254 terminou em `OWNER_SALES_SWITCH_NOT_OPEN` |

O agendamento do GitHub, portanto, não entrega sua cadência nominal. A própria
documentação do GitHub avisa que eventos `schedule` podem atrasar e até ser
descartados sob carga, e que agendamentos de repositório público podem ser
desativados após 60 dias sem atividade:

- <https://docs.github.com/en/actions/how-tos/troubleshoot-workflows#scheduled-workflows-running-at-unexpected-times>
- <https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule>

Essas limitações tornam o `schedule` inadequado como única fonte de renovação,
mas não são a causa direta do padrão `:15` a cada seis horas: esse padrão vem
da política `dbEconomySkip` do Worker.

## Causa

A prova expira para fins de P22 após 65 minutos, enquanto o único produtor que
funciona com vendas fechadas é deliberadamente limitado a uma execução a cada
seis horas. Os contratos de economia e de frescor são incompatíveis. O segundo
produtor está simultaneamente sujeito ao agendador não determinístico do GitHub
e bloqueado por desenho quando vendas estão fechadas.

Não há indício de corrupção da prova: o comportamento `UNVERIFIED_FAIL_CLOSED`
é o resultado seguro esperado quando a idade excede 65 minutos.

## Proposta (não implementada)

Recomenda-se manter a renovação no **cron já existente do Worker da
Cloudflare**, independente do agendador do GitHub, e separar a política da
prova financeira das demais tarefas caras:

1. no ramo `15,45`, avaliar uma reserva idempotente no KV e renovar apenas
   quando a última prova válida tiver pelo menos 50 minutos;
2. isentar **somente** essa renovação de `dbEconomySkip`; as outras consultas
   ao banco continuam em 00/06/12/18 UTC;
3. não usar `force: true`: com tiques a cada 30 minutos e piso de 50 minutos,
   a renovação efetiva ocorre aproximadamente uma vez por hora, com margem
   nominal de 15 minutos antes do TTL de 65;
4. registrar batimento mínimo (`at`, `ok`, motivo de categoria), alertar se a
   prova não for renovada antes do TTL e manter projeção fail-closed;
5. deixar o workflow do GitHub apenas como reforço/diagnóstico quando o estado
   comercial autorizar, nunca como relógio primário.

Impacto estimado a validar antes de qualquer ativação: com vendas fechadas, a
consulta específica da prova sobe de 4 para aproximadamente 24 por dia. Não se
declara compatibilidade com cota, egress ou limite de subrequests sem ensaio e
medição do proprietário. A reserva deve impedir duplicação entre os tiques e
execuções concorrentes.

## Prova necessária antes de ativar

Somente Sol e o proprietário podem decidir pela implementação. Um PR posterior
deve permanecer sem deploy até existir autorização e deve demonstrar:

- teste de 24 horas com vendas fechadas, sem dados pessoais, com ao menos 23 de
  24 renovações horárias e lacuna máxima menor ou igual a 65 minutos;
- P22 continuamente `PROVEN` após a primeira prova, salvo falha real de
  provedor/banco, que deve continuar `UNVERIFIED_FAIL_CLOSED`;
- concorrência em dois tiques sem dupla consulta; reinício e falha após reserva
  com recuperação no tique seguinte;
- contagem medida de subrequests, CPU, leituras/escritas KV e egress Neon;
- falha simulada do GitHub Actions durante toda a janela, provando que a
  renovação continua pelo Worker;
- restauração explícita do comportamento anterior após o ensaio, se os limites
  gratuitos ou o orçamento não forem comprovados.

Este documento não muda cron, workflow, chave, credencial, flag comercial ou
runtime; não faz deploy e não autoriza a proposta.
