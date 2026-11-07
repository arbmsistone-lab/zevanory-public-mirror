# P12 Entrega digital idempotente: ensaio sintético de entrega

**Rótulo da evidência (roteiro v4.9.1, seção 6.4): SINTÉTICA.** Teste local e de CI, com fetch proibido, sem
produção, sem Hotmart real, sem segredo real e sem compra ou reembolso fabricado. Pela seção 6.4, esta evidência
dá no máximo homologação de engenharia. Ela **não** conta como ENSAIO EM PRODUÇÃO nem como OPERACIONAL, e não
atribui `HOMOLOGADO_075` sozinha (seção P1.4: faltam os critérios 7, 9 a 12).

- Data do ensaio: 07/11/2026. Base: `gh-pages@9a6f1a86`. O SHA do head está no PR.
- Reprodução: `node --test tests/p12-entrega-ensaio.test.mjs` (12 testes) e
  `python3 scripts/ci/mutants_p12_entrega.py` (18 mutantes). O gate só de PR é `.github/workflows/p12-entrega-ensaio.yml`.
- Decisão vigente: **DEC-06.** Depois da aprovação do pagamento, a Hotmart entrega o produto integral imediatamente
  na área de compras (Minhas compras). Não há retenção de 192 h (o modelo B foi revogado). A ZEVANORY não envia
  e-mail de produto. Ela **registra** a entrega e o estorno a partir do postback autenticado (`hottok`).

## 1. Contrato do motor (critério 1 da seção P1.4)

| Item | Definição |
|---|---|
| Escopo | Postback Hotmart dos 5 produtos v1.3.4 (IA na Prática, Vendas na Prática, Lucro & Caixa, Combo IA + Vendas e Negócio Completo): rota `/api/webhooks/hotmart` → `routeHotmartNc011` → `handleDigitalHotmartNc012` → `recordHotmartSale` (resumo de vendas no KV) + `emitActivity` (atividade `delivery_sent` ou `refund_requested`) |
| Entradas | `POST` JSON v2 da Hotmart com `x-hotmart-hottok`; eventos `PURCHASE_APPROVED`, `PURCHASE_COMPLETE`, `PURCHASE_REFUNDED`, `PURCHASE_CHARGEBACK`, `PURCHASE_PROTEST`, `PURCHASE_CANCELED` e os demais da lista permitida |
| Saídas | `200` com `duplicate` verdadeiro ou falso; `401` para `hottok` errado ou ausente; `422` para evento inválido; `503` para configuração ausente ou registro **não gravado** (a Hotmart reenvia) |
| Estados por transação e resultado | ausente → `pending` (marcador gravado antes do resumo) → resumo aplicado (a chave `ref:resultado` fica no resumo) → `1` (concluído). O resultado `approved` vale para APPROVED e COMPLETE; `reversed` vale para estorno, contestação e protesto |
| Invariante | Cada transação aprovada é contada **exatamente uma vez** no registro, e gera exatamente uma atividade de entrega. Cada reversão é contada no máximo uma vez. Nenhum e-mail, nome ou transação em claro fica no registro |
| Dependências | KV `ZEVANORY_PRIVATE_ARTIFACTS`. **Não** usa Neon, Resend nem rede |
| Limite conhecido | O resumo é um documento único no KV, com leitura, modificação e gravação **sem CAS**. Dois postbacks de transações diferentes ao mesmo tempo podem perder um incremento do resumo. Os marcadores por transação continuam corretos, e o resumo é recomputável a partir deles. Esse limite é anterior a este PR e não foi resolvido nele (ver a seção 7) |

## 2. Defeitos encontrados e corrigidos neste PR

| # | Defeito na base | Efeito | Correção | Prova |
|---|---|---|---|---|
| D1 | `recordHotmartSale` gravava o marcador da transação como concluído **antes** do resumo | Uma falha na gravação do resumo (cota de KV ou erro transitório) devolvia 503. A reentrega da Hotmart virava `duplicate` e a venda **sumia** do registro (entrega faltante no registro) | Marcador em duas fases (`pending` → `1`). O resumo guarda as últimas 2.000 chaves aplicadas, então uma queda entre o resumo e o marcador não conta duas vezes | E3, E4, mutantes M01–M03 e M17 |
| D2 | A leitura do resumo era envolvida em `try/catch`, que transformava o erro em `null` | Com o KV fora só na leitura, o resumo era **recriado vazio por cima** do existente: todas as vendas anteriores se perdiam | O erro de leitura propaga e o handler devolve 503. JSON corrompido continua tratado como vazio, como antes | E5, M04 |
| D3 | A atividade de entrega e de estorno era gravada com `.catch(() => null)`, e o postback respondia 200 | Com falha no KV, a Hotmart não reenviava e o registro de entrega ficava **faltante** | Atividade não confirmada (nem gravada, nem duplicata) devolve 503. A reentrega é idempotente | E6, M05–M07 |

Gate tocado: `worker/sales-ledger.mjs` e `worker/cp-nc012-digital-hotmart.mjs` casam com `worker/*.mjs`. O merge
dispara `central-production-deploy` (MERGE_CLASSE_B). Este PR não autoriza merge nem deploy.

## 3. Matriz de cenários (estados × transições × falhas) e resultado

| Caso | Transição ou falha | Esperado | Resultado |
|---|---|---|---|
| E1 | APPROVED → reentrega idêntica → COMPLETE | 1 venda, 1 atividade de entrega, nenhum fetch, sem dado pessoal | PASS |
| E2 | APPROVED → REFUNDED ×2 → CHARGEBACK; CANCELED sem aprovação | estorno contado uma vez, contestação posterior não reverte de novo, cancelamento sem entrega | PASS |
| E3 | falha na gravação do resumo → reentrega | 503, depois 200 aplicado; 1 venda (zero faltante) | PASS |
| E4 | falha entre o resumo e a conclusão do marcador → reentregas | 503, depois 200; 1 venda (zero duplicado) | PASS |
| E5 | falha na leitura do resumo (KV fora) | 503; vendas anteriores preservadas; a reentrega soma | PASS |
| E6 | falha na gravação da atividade de entrega e de estorno | 503; a reentrega grava exatamente uma | PASS |
| E7 | Neon fora (`DATABASE_URL` sintético inalcançável) | 200 sem nenhuma chamada de rede | PASS |
| E8 | `hottok` errado ou ausente; segredo não configurado | 401, 401, 503; nada gravado | PASS |
| E9 | indisponibilidade parcial (12-B.4), na seção 4 | nenhuma lacuna cenário × direito; caminhos informados nas 5 páginas de venda; contraprovas | PASS |
| E10 | entrega mensal (Conteúdo Pronto): webhook × cron, 2 ciclos, resultado ambíguo | uma saída por ciclo com a chave `<id>/delivery/<ciclo>`; ambíguo espera conciliação | PASS |
| E11 | onboarding com microvitória (seção 5) | flag exata, mesmo plano para APPROVED e COMPLETE, prazo ≤ 24 h, cancelamento por estorno ou descadastro, texto sem oferta, **remetente nunca chamado** | PASS |
| E12 | rota oficial com a flag de 192 h ligada no ambiente | vai ao registro digital (DEC-06), nunca ao razão de 192 h | PASS |

Contagens: ensaio **12/12** (zero pulados); mutantes **18/18 KILLED** (0 SURVIVED, 0 INCONCLUSIVE), com expectativas
escritas antes de rodar (`scripts/ci/mutants_p12_entrega_allow.json`); suíte do manifesto no PR.

## 4. Entrega e arrependimento durante indisponibilidade parcial (seção 12-B.4)

Fonte: `data/p12-degradacao-12b4.json`, avaliada por `scripts/ci/p12_degradacao.mjs` (E9). Um caminho só conta se o
**recebimento** do pedido não depende do componente que caiu. O pedido ganha carimbo de horário, e o prazo legal
conta da solicitação. "Tratamento diferido" quer dizer que o pedido foi recebido e carimbado, e que a ZEVANORY o
trata quando o componente voltar.

| Cenário | Acesso ao conteúdo | Avisar falha de entrega | Arrependimento 7 dias |
|---|---|---|---|
| site_fora | `hotmart_minhas_compras`, `suporte_email` | `suporte_email`, `atendimento_formulario` | `hotmart_reembolso`, `suporte_email`, `atendimento_formulario` |
| worker_fora | `hotmart_minhas_compras`, `suporte_email` (tratamento diferido) | `suporte_email` (tratamento diferido) | `hotmart_reembolso`, `suporte_email` (tratamento diferido) |
| neon_fora | `hotmart_minhas_compras`, `suporte_email` (tratamento diferido) | `suporte_email` (tratamento diferido) | `hotmart_reembolso`, `suporte_email` (tratamento diferido) |
| kv_fora | `hotmart_minhas_compras`, `suporte_email` | `suporte_email`, `atendimento_formulario` | `hotmart_reembolso`, `suporte_email`, `atendimento_formulario` |
| email_fora | `hotmart_minhas_compras` | `atendimento_formulario` (tratamento diferido) | `hotmart_reembolso`, `atendimento_formulario` (tratamento diferido) |
| plataforma_fora | `suporte_email` (envio manual do arquivo) | `suporte_email`, `atendimento_formulario` | `suporte_email`, `atendimento_formulario` |

Informação ao cliente: as 5 páginas de venda publicadas (`sales-public/<produto>.html`) citam "Minhas compras",
"refund.hotmart.com", "suporte@zevanory.api.br" e "/atendimento" (E9.8).

### Procedimento de recuperação por modo de falha

| Modo de falha | O que acontece | Recuperação |
|---|---|---|
| KV fora (gravação ou leitura) | O postback devolve 503. A entrega na Hotmart não depende da ZEVANORY | A Hotmart reenvia o postback, e o registro conclui sem duplicar (E3 a E6). Se a queda passar do reenvio da Hotmart **[NÃO VERIFICADO: calendário de reenvio]**, o proprietário reconcilia pelo painel da Hotmart (seção 7.1, H-3) |
| Neon fora | O registro Hotmart segue normal (E7). O suporte@ recebe no Resend e encaminha depois | Depois da queda, conferir no Resend Receiving os e-mails do período e tratar cada pedido com o prazo contado do recebimento |
| Worker fora | Nenhum postback é registrado e o suporte@ não encaminha. A entrega e o reembolso na Hotmart seguem | Reenvio da Hotmart e do Resend. Na volta, reconciliar as vendas pelo painel da Hotmart e conferir o Resend Receiving |
| E-mail (Resend) fora | A Hotmart segue, e o `/atendimento` grava o protocolo no PostgreSQL antes de qualquer envio | O dreno horário envia as confirmações pendentes (worker/atendimento.mjs) |
| Hotmart fora | Sem acesso à área de compras | O suporte responde ao comprador e envia o arquivo da versão vendida (v1.3.4, conferido pelo `SHA256SUMS`) ao e-mail informado na compra. O arrependimento pedido por e-mail ou formulário vale da data do pedido e é executado na Hotmart quando ela voltar |
| Site fora | As páginas não abrem | Os canais seguem informados no e-mail de confirmação da Hotmart **[NÃO VERIFICADO: conteúdo desse e-mail na conta real]** |

## 5. "Entrega mensal sem chave de idempotência" (situação de 24/10, seção 5.1-H)

A lacuna era da entrega mensal da assinatura Conteúdo Pronto. No código atual, a única rota da assinatura é o
Durable Object (`worker/cp-durable-ledger.mjs`). A saída de entrega é única por ciclo (`cycle UNIQUE`) e carrega
a chave do provedor `cp-do:<id>/delivery/<ciclo>`, derivada do ciclo e não do evento. Webhook e cron do mesmo
ciclo produzem uma única entrega (E10, mutante M13). Resultado ambíguo fica `uncertain` e nunca reenvia sozinho.
**A lacuna está fechada no código candidato.** A assinatura continua não ligada à venda: a outbox do Resend está
bloqueada, e a página de pacote responde 503. Pela DEC-06, ela fica fora do escopo dos 5 produtos da Hotmart.
Portanto, a lacuna não bloqueia o GO do VC-H. Ligar a assinatura exige um ensaio próprio.

## 6. Onboarding com microvitória em até 24 h (seções 5 e 12-B.2)

`worker/onboarding-microvitoria.mjs` é um módulo **puro e inativo**. Nenhuma rota o importa, ele não faz fetch e não
grava nada.

- **Flag:** `ONBOARDING_MICROVITORIA_ENABLED` liga só com `"true"` exato. Mesmo ligada, a constante de código
  `ONBOARDING_SEND_ENABLED = false` impede o envio, e o remetente injetado nunca é chamado (E11.25 e E11.26, M09).
- **Janela:** a mensagem fica elegível 2 h depois da entrega (aprovação na Hotmart) e vence em 24 h. Depois disso,
  vira falta registrada com alerta, nunca envio atrasado. Estorno, contestação, cancelamento ou descadastro
  cancelam. A chave de idempotência é por pedido e etapa (`onb-mv/v1/<hash>/mv1`), e APPROVED e COMPLETE geram
  o mesmo plano.
- **Base legal registrada (12-B.5):** legítimo interesse (LGPD art. 7º, IX), **a mesma** que a política de
  privacidade publicada declara para "Acompanhamento pós-compra", com descadastro em um clique. O teste E11.28
  confere essa correspondência contra `sales-public/privacidade.html` (M18).
- **Conteúdo:** uma ação concreta por produto, usando só arquivos que a página de venda promete. O texto não tem
  chamada de compra, preço, próximo produto nem promessa de ganho (E11.22, verificado por `hasCheckoutCta` e
  `bannedPolicyHits`).
- **Privacidade:** o plano carrega só o hash da transação. O identificador bruto é recusado (E11.14).

**O que falta para ligar** (fora deste PR): (1) ligação `product.id` da Hotmart → produto, configurada pelo
proprietário; (2) agendador e marcador por pedido; (3) conferência do texto de cada microvitória contra o material
v1.3.4 (P24); (4) decisão do proprietário e nova auditoria para trocar a constante de envio.

## 7. O que este ensaio NÃO prova

- Não prova o caminho real da Hotmart (critério 7 da seção P1.4): entrega na área de compras, reenvio de postback e
  revogação de acesso no estorno. Isso exige uma compra de teste **autorizada pelo proprietário** (nunca uma compra
  fabricada).
- Não é ENSAIO EM PRODUÇÃO nem OPERACIONAL (seção 6.4). A recuperação está escrita e simulada, mas não foi
  exercitada em produção com tempos medidos (critério 9).
- A concorrência entre transações diferentes sobre o resumo único no KV continua sem CAS. É um resíduo conhecido e
  anterior a este PR. A solução candidata é o diário P20, cujos ganchos estão em PRs abertos e não foram tocados aqui.
- Falta o parecer independente sobre o SHA (critério 10), o readback da configuração efetiva (critério 11) e o
  registro das autorizações técnicas (critério 12).
