# P13 Pós-venda: ensaio sintético da política de 7 dias, da contestação 7.3 e das respostas prontas

**Rótulo da evidência (roteiro v4.9.1, seção 6.4): SINTÉTICA.** O ensaio rodou localmente e no CI, sem rede, sem
produção, sem Hotmart nem Mercado Pago reais, e sem nenhum reembolso real ou fabricado. Pela seção 6.4, essa
evidência chega no máximo à homologação de engenharia. Reembolso é um processo raro: para a certificação, ainda
são exigidos o ENSAIO EM PRODUÇÃO agendado e o censo das ocorrências reais. Para `HOMOLOGADO_075`, a seção P1.4
exige "reembolso e arrependimento exercidos em ensaio sem dinheiro real".

- Data: 07/11/2026. Base: `gh-pages@9a6f1a86`. O SHA do head está no PR.
- Reprodução: `node --test tests/p13-posvenda-ensaio.test.mjs` (14 testes) e
  `python3 scripts/ci/mutants_p13_posvenda.py` (21 mutantes). Gate só de PR: `.github/workflows/p13-posvenda-ensaio.yml`.
- **Este PR não altera `worker/*.mjs`.** O merge não dispara `central-production-deploy`.

## 1. Política de 7 dias "sem exceção não autorizada" (`scripts/p13/decisao-reembolso-7d.mjs`)

O núcleo é puro e serve a qualquer canal (Hotmart, suporte@, `/atendimento`, `/pedir-reembolso` legado). O prazo
vem da política única (`refundWindow`, `data/politica-unica.json`) e é **avaliado na data da solicitação**. Pela
DEC-06, na Hotmart o recebimento coincide com a aprovação.

| Caso | Entrada | Decisão esperada | Resultado |
|---|---|---|---|
| V1 | pedido no dia 3, na Hotmart | `aprovar_arrependimento`, integral, sem justificativa, resposta na Hotmart em 5 dias (H-6), motivos para P24 e P25 | PASS |
| V2 | último instante do 7º dia corrido; 1 ms depois; 7 × 24 h | aprova; `fora_do_prazo`; aprova | PASS |
| V3 | pedido no dia 6, tratado no dia 12 (indisponibilidade) | aprova (o prazo conta da solicitação) e alerta os prazos H-6 e de resposta conclusiva vencidos | PASS |
| V4 | já reembolsado, em andamento ou cancelado | `ja_reembolsado`, `em_andamento` ou `ja_cancelado`, nunca uma segunda reversão | PASS |
| V5 | pedido duplicado (por outro canal, dias depois) | devolve a decisão registrada, marcada `duplicado` | PASS |
| V6 | contestação aberta | `contestacao_em_andamento`, sem reembolso paralelo, com revisão humana | PASS |
| V7 | fora do prazo: sem motivo; vício; exceção sem autorização; exceção sem registro; exceção autorizada | `fora_do_prazo`; `fora_do_prazo_vicio` com revisão; `excecao_nao_autorizada` (duas vezes); `excecao_autorizada` com registro e revisão | PASS |
| V8 | assunto jurídico ou dado pessoal dentro do prazo | aprova **e** exige revisão humana | PASS |
| V9 | pedido antes da aprovação, protocolo ou canal inválido, estado desconhecido | `invalido`, com revisão humana | PASS |
| V10 | checkout próprio legado com entrega atrasada | conta do recebimento; sem prazo Hotmart | PASS |

## 2. Contestação, seção 7.3 (`scripts/p13/contestacao-7-3.mjs`, `docs/p13/procedimento-contestacao-7-3.md`)

| Caso | Esperado | Resultado |
|---|---|---|
| V11 | aviso → protocolo com prazo da plataforma → evidência mascarada → resposta revisada no prazo → resultado → P24/P25, com trilha completa e sem e-mail em claro | PASS |
| V12 | recusa e-mail em claro, evidência sem registro de acesso ou envio, falta de prazo da plataforma, resposta sem revisão do proprietário e suspensão sem base na política; resposta fora do prazo vira `prazo_perdido`; derrota por falha de entrega marca falha crítica de P12; aviso repetido não duplica | PASS |
| V14 | o procedimento escrito tem as 6 etapas, a regra de falha crítica e a marcação de revisão humana | PASS |

## 3. Respostas prontas (`docs/p13/respostas-prontas.md`, verificador `scripts/p13/respostas-check.mjs`)

São 13 textos: 6 para o Reclame Aqui, 4 para o consumidor.gov.br e 3 para a Hotmart. O ensaio V13 confere o pacote:

- nenhum dado pessoal: só o e-mail oficial, sem CPF, telefone ou preço;
- só os campos `{PROTOCOLO}`, `{DATA_SOLICITACAO}`, `{PRAZO}` e `{PRODUTO}`;
- protocolo em todos os textos;
- revisão humana **OBRIGATÓRIA** em toda resposta pública e em toda decisão sensível (exceção, jurídico, dado
  pessoal, contestação, vício);
- texto do prazo idêntico ao da política única;
- nenhuma chamada de compra nem frase proibida.

Contraprovas: o verificador recusa um e-mail não oficial, o campo `{NOME}`, uma resposta pública sem revisão, uma
contestação sem revisão, um prazo reescrito e um valor em reais.

## 4. Achados MÉDIOS do #945 (roteiro F-06, l.217): verificação independente

O #945 continua **aberto, em rascunho e não mesclado**. O head é `e9fe94c2fbb587ec3610316c0649fd3178ae75d6`, no
branch `codex/refund-auto-dispatch`. Os dois MÉDIOS da rodada 4 (M-1: toda manifestação fica persistida; M-2: a
visibilidade no OFF não depende de marcador no KV) estão corrigidos no próprio PR, nos commits `6c60f288` e
`e9fe94c2`. **Neste PR não houve correção nova, porque já existe correção no #945.** Reexecutei a verificação no
head do #945, num worktree só de leitura:

| Prova | Resultado |
|---|---|
| Testes focados (`refund-auto-dispatch*`), incluindo R41 (M-1) e R42 (M-2) | **99/99** |
| Mutantes `scripts/ci/mutants_refund_auto_dispatch.py` | **87/87 KILLED** |
| `refund-auto-dispatch-postgres` em PostgreSQL 16.15 real (descartável, porta local) | **6/6** em 3 execuções |
| `refund-window-postgres` | **2/2**, W1–W3 KILLED |

**Achado novo (bloqueia o #945, não é defeito do código):** o #945 **não tem base comum** com o `gh-pages` atual.
O histórico do espelho foi reescrito (`git merge-base` vazio; `git merge-tree` em conflito). Para mesclar, o #945
precisa ser portado (rebase ou reaplicação) para o `gh-pages` atual, com nova rodada de CI e nova auditoria
independente sobre o novo SHA. Os testes adversariais privados do auditor (T06, T07, T08, T19) não estão no
repositório e não foram reexecutados. A flag `REFUND_AUTO_DISPATCH` continua desligada.

## 5. Mutantes

**21/21 KILLED** (0 SURVIVED, 0 INCONCLUSIVE). As expectativas foram escritas por raciocínio antes de rodar. Na
primeira execução, o N08 (prazo H-6 de 7 dias) deu INCONCLUSIVE, porque eu tinha omitido um efeito secundário
real: o V3 também perde o alerta H-6. A expectativa secundária foi acrescentada com justificativa; a regra e o
teste não mudaram.

## 6. O que este ensaio NÃO prova e o que falta para chegar a 0,75

- **Reembolso e arrependimento exercidos sem dinheiro real** (prova adicional da P1.4): na Hotmart, isso exige uma
  compra de teste autorizada pelo proprietário e o reembolso pela plataforma, nunca transação fabricada. No
  checkout próprio, exige o sandbox (F2, classe C).
- **H-4 e H-6 na conta real** (proprietário): garantia de 7 dias configurada em cada produto e prazos de resposta,
  contestação e disputa registrados por escrito.
- **Adesão ao consumidor.gov.br e perfil no Reclame Aqui** (proprietário): a existência dos perfis e os prazos
  vigentes estão **[NÃO VERIFICADOS]**.
- **#945:** portar para o `gh-pages` atual e fazer nova auditoria (seção 4).
- **Critérios 10 a 12 da P1.4:** parecer independente sobre o SHA, readback da configuração e autorizações técnicas
  do proprietário.
- **Registro operacional:** o núcleo de decisão e a máquina de estados são puros. Falta ligá-los a um registro
  durável de protocolos. A candidata é a tabela de atendimento existente ou o diário P20, cujos ganchos estão nos PRs
  abertos #987 e #988, não tocados aqui.
