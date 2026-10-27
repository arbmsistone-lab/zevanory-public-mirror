# Arrependimento com despacho automático

## Escopo e segurança

O fluxo cobre somente pedidos reais pagos pelo checkout próprio do Mercado Pago. Hotmart continua sob o fluxo da própria plataforma. O fechamento de vendas não bloqueia a devolução de um pagamento já confirmado e este código não cria cobranças.

`REFUND_AUTO_DISPATCH` nasce desligado. Somente o valor textual `true` ativa o despacho. Ausência, `false`, `0` ou qualquer outro valor mantêm o comportamento anterior: registro e decisão manual em `/admin/refunds`.

## Fluxo

1. O consumidor informa pedido e e-mail.
2. O Worker cruza o pedido local, o evento de pagamento confirmado, o destinatário da entrega e o pagamento consultado no Mercado Pago.
3. No modo ON, a resposta pública é sempre HTTP 200, com `received`, `protocol` e a mensagem uniforme "Se os dados conferirem, você receberá a confirmação no e-mail usado na compra". A identidade é classificada em quatro casos:
   - **confirmada**: todas as fontes registradas conhecidas (destinatário da entrega e pagador consultado no provedor) são iguais ao endereço informado. Segue o fluxo automático ou manual normal;
   - **conflito** (`manual_reason=identity_conflict`): o endereço informado é igual a uma fonte registrada, mas as fontes divergem entre si. Entra em análise manual, o proprietário é alertado e o protocolo vai **somente** ao endereço registrado que coincidiu (nunca à outra parte e nunca ao texto digitado). Nunca há despacho automático; o proprietário pode aprovar depois de verificar o comprador, ou recusar;
   - **não verificável** (`manual_reason=identity_unverifiable`): o pagador não pôde ser consultado (credencial incompatível, token ausente, falha do provedor ou evento de pagamento ausente) e nenhuma fonte registrada coincidiu. Entra em análise manual, o proprietário recebe o alerta de análise manual e, se for o caso, o alerta de credencial. Como não há endereço registrado comprovado, nenhum e-mail ao consumidor sai até a reavaliação confirmar a identidade; então o protocolo vai ao endereço registrado. O proprietário não pode aprovar sem essa confirmação, mas pode recusar ou reavaliar;
   - **divergente**: as fontes registradas são conhecidas e nenhuma coincide. Fica somente na lista de auditoria, sem botão de estorno, limitada a 10 endereços distintos por pedido (uma chave por endereço, com contador de tentativas, TTL de 7 dias).

   Etapas: recebimento (resposta uniforme com protocolo) → confirmação somente por canal seguro (endereço registrado comprovado) → identidade incerta nunca reembolsa → pendência rastreável em PostgreSQL → alerta ao proprietário em falha persistente (análise manual, credencial, confirmação não entregue em 24 h, reavaliação encerrada, estado indisponível) → decisão comunicada só pelo canal autorizado (e-mail de aprovação ou de recusa ao endereço registrado, com nova tentativa idempotente). Sem canal seguro, o registro recebe `confirmation_channel=none`, aparece marcado no painel e nos alertas e nunca desaparece. A confirmação nunca expõe dados do pagador: a resposta é idêntica em todos os casos e os e-mails não contêm endereço do pagador.

   Um registro de identidade não confirmada (`identity_verified=false`) nunca bloqueia o comprador: um pedido posterior com identidade confirmada o substitui e é avaliado normalmente, inclusive para despacho automático. A recusa pelo proprietário de um registro não confirmado também não torna `previously_rejected` o pedido posterior do comprador. Nenhum e-mail é enviado ao endereço digitado: o destino é sempre relido do registro de entrega ou do pagador verificado junto ao provedor. Para reavaliar sem guardar o endereço digitado, o registro guarda até 5 provas pseudônimas `SHA-256("zevanory-refund-identity:v1:<order_id>:<e-mail>")` (salgadas pelo pedido).
4. Com o interruptor ligado, o Worker só reserva e envia o estorno quando todas as verificações passam: janela vigente, identidade, pedido pago, pagamento aprovado, valor integral, `offer_id`, referência do pedido, ausência de reembolso, disputa ou chargeback, pedido não pertencente à certificação e credencial do ambiente correto.
5. A reserva é uma inserção transacional única em `refund_provider_claims`. Somente quem obtém a reserva pode fazer o `POST`, sempre com `X-Idempotency-Key: zevanory-refund-<order_id>`.
6. Confirmação inequívoca marca o registro como `approved`, revoga downloads e notifica consumidor e proprietário. A mensagem do proprietário é uma notificação, não uma aprovação. Falhas no e-mail deixam um marcador de tentativa pendente para o watchdog refazer o envio, com `Idempotency-Key` estável na API do Resend (sem gravar endereço completo no KV).

## Estados e recuperação

- `pending`, `auto_eligible=true`: registrado e em despacho.
- `pending`, `manual_reason=<motivo>`: fila manual. O painel mostra o motivo e a idade do pedido.
- `approved`: o provedor confirmou o estorno; repetições não geram novo `POST`.
- `provider_outcome_unknown=true`: timeout, falha de rede, 5xx ou resposta não terminal. Nunca há repetição cega. O watchdog usa apenas `GET` para conciliar.
- `download_revocation_pending=true`: o estorno foi confirmado, mas a revogação local precisa ser reparada; não há novo `POST` financeiro.
- `customer_email_pending=true` / `approved_email_pending=true`: e-mail ao comprador ainda não confirmado; watchdog tenta novamente com chave idempotente, nunca com o e-mail informado no formulário.
- `manual_reason=payment_event_missing`: pedido marcado pago no banco sem evento financeiro confirmado. Fica em análise manual, sem botão de `approve` até comprovação; não há POST com identificador de pagamento ausente. A comprovação é a **reavaliação**: quando o webhook chega, um novo pedido do consumidor reavalia e pode despachar automaticamente; o watchdog horário reavalia só com `GET` (nunca `POST`) e marca `eligible_after_reevaluation`, que libera o botão "Aprovar"; o botão "Reavaliar agora" faz o mesmo sob demanda, e "Aprovar" num pedido retido reavalia antes de decidir. "Recusar" fica sempre disponível, então não há impasse.
- `manual_reason=provider_lookup_failed`: a consulta do pagamento no provedor falhou de forma **transitória** (timeout, rede, 408/429/5xx). É diferente de `payment_not_approved` (o pagamento não foi comprovado como não aprovado) e é reavaliado como o caso acima.
- Respostas **definitivas** do provedor viram `provider_payment_not_found` (404, pagamento desconhecido; retido, sem botão de aprovar) ou `provider_lookup_rejected` (400/401/403). Elas não são reconsultadas pelo watchdog; só o botão "Reavaliar agora" ou um novo pedido as reavaliam.
- Reavaliação controlada: o watchdog reavalia os casos transitórios só até 7 dias depois da manifestação. Depois disso marca `reevaluation_closed`, alerta o proprietário uma vez e a decisão fica com ele.
- Decisão humana: aprovar um pedido em análise manual e recusar qualquer pedido do modo ON exigem **justificativa** (mínimo de 10 caracteres). A justificativa, a evidência informada pelo proprietário e uma evidência do sistema (motivo, pagamento, identidade, reavaliação) ficam no evento de auditoria. Não existe caminho humano que dispense a comprovação do pagamento: pedidos retidos (`payment_event_missing`, `provider_payment_not_found`, identidade não verificável) não podem ser aprovados, só reavaliados ou recusados.
- Reavaliação: vale para `payment_event_missing`, `provider_lookup_failed`, `credential_environment_mismatch`, `identity_unverifiable` e `identity_conflict`. O prazo de arrependimento é medido no momento da manifestação original (`requested_at`), nunca no momento da reavaliação, e o protocolo (`request_nonce`) é mantido. Se a reavaliação provar que um registro não verificável não coincide com as fontes registradas, ele passa a `unverified_closed`: continua registrado e auditado (nunca é apagado), não tem ação financeira e não bloqueia o comprador.
- `manual_reason=previously_rejected`: pedido renovado após recusa do dono; histórico de recusa preservado, nunca despacho automático.

As exceções manuais incluem prazo encerrado, pedido ou pagamento não aprovado, falha transitória do provedor, valor/referência/oferta divergente, reembolso anterior, disputa/chargeback, certificação, credencial incompatível, conflito de identidade e identidade não verificável. Endereço divergente das fontes registradas é somente tentativa de auditoria separada, nunca pedido manual elegível para o botão de reembolso. Para ser automático, a fotografia do provedor exige explicitamente `transaction_amount_refunded=0`, `refunds=[]`, `status=approved` e `status_detail=accredited`. Qualquer ausência/estado não autorizado é análise manual.

## Credenciais

O modo ON exige `MERCADOPAGO_ENV=production` e `verifyProductionToken`, com hash da conta (`MERCADOPAGO_PRODUCTION_ACCOUNT_HASH16`) e consulta autenticada a `/users/me`, antes da consulta do pagamento e novamente antes de `POST /refunds`. `MERCADOPAGO_ENV=sandbox` aceita somente credencial `TEST-` (sem distinção por caixa). Qualquer igualdade não comprovada falha fechado e entra em análise manual: o alerta de credencial é enviado também quando a identidade não pôde ser verificada por causa da credencial. O alerta de divergência é deduplicado por pedido/motivo por 24h e nunca é disparado para pedido de certificação. Nenhum teste exige credencial real nem consulta provedor vivo.

## Compatibilidade OFF, tempo e idempotência

- Somente o literal **exato** `true` ativa ON; `TRUE`, `True`, ` true`, `true ` e booleano `true` deixam OFF. O corpo da função legada `createRequest` mantém o mesmo SHA-256 de código `9996d28187f4585e16d89b91d4b9644912b24df1dd51b90f778be4f773e08ee9` da base `a098d880`. O teste X12 valida resposta, registro e e-mails com destinatários/assunto/texto exatos; o caminho financeiro OFF continua aceitando a semântica legada de resposta do provedor.
- Antes de `POST` financeiro, a reserva em PostgreSQL é obrigatória. Com `ctx.waitUntil`, o despacho ON prossegue depois da resposta genérica ao consumidor; sem esse contexto, a chamada fica síncrona. O orçamento teórico de verificações e provedores no caminho síncrono pode atingir **aproximadamente 50 segundos** (5s conta, 15s pagamento, 10s e-mail, 20s estorno), sem incluir latência do banco.
- Uma nova chamada após conciliação `reconciled_not_refunded` mantém **a mesma chave por pedido** (`zevanory-refund-<order_id>`). Ela privilegia não produzir estorno duplicado; uma eventual retenção do resultado anterior pelo provedor pode impedir nova tentativa efetiva. É decisão conservadora e exige comprovação pelo GET e revisão do operador, sem alternar automaticamente a chave.
- Ver a seção "Estado de decisão em PostgreSQL" abaixo: a hipótese de perder `approved` no KV deixou de existir, porque o KV não decide mais nada no modo ON.

## Estado de decisão em PostgreSQL

Os pedidos criados pelo modo ON vivem em PostgreSQL (`worker/refund-state.mjs`), que é a fonte da verdade. O KV guarda apenas uma cópia (cache) para leitores antigos. Os registros do fluxo legado (OFF) continuam no KV como antes e não tocam as tabelas novas.

- `refund_requests (order_id pk, version, status, record jsonb, updated_at)`: o estado autoritativo.
- `refund_request_events (order_id, version, from_status, to_status, manual_reason, actor, justification, evidence jsonb, transition_key unique, at)`: trilha de auditoria append-only, com `unique (order_id, version)`.
- Cada transição é **um único comando SQL**: compare-and-swap pela versão esperada mais a linha de evento no mesmo comando (CTEs modificadoras). Ou as duas coisas acontecem, ou nenhuma. A chave de idempotência da transição (`transition_key`, por exemplo `owner:approve:<pedido>:<versão>`) e a versão impedem que a mesma decisão seja aplicada duas vezes.
- O SQL nunca deixa uma cópia não terminal substituir uma linha `approved`/`refunded`. Quando uma gravação terminal perde a corrida para um escritor pendente, ela relê a linha e repete o CAS mesclando os marcadores de e-mail já entregue. Assim o terminal sempre vence e nunca regride (provado com PostgreSQL 16 real e conexões concorrentes em `tests/integration/refund-auto-dispatch-postgres.test.mjs`).
- Toda leitura de decisão do modo ON (novo pedido, reavaliação, aprovação, recusa, conciliação, painel e watchdog) vem do PostgreSQL. Uma cópia KV desatualizada, vazia, que falhou ao gravar ou foi alterada à mão é ignorada. Sem o PostgreSQL nenhum registro ON é gravado: o consumidor recebe a mensagem de nova tentativa (HTTP 503), o painel mostra o aviso e o watchdog fica vermelho e alerta o proprietário.
- A reserva `refund_provider_claims` continua garantindo um único `POST` por pedido.
- **Recuperação entre decisão e persistência.** A decisão humana é gravada (com justificativa e evidência) antes da reserva. Se o processo cair depois do `POST` e antes de gravar `approved`, a reserva fica registrada e o watchdog concilia por `GET` até `approved`, sem segundo `POST`. Se cair entre a decisão automática e a reserva, um novo pedido do consumidor retoma o despacho, ainda com um único `POST`.
- Provas de falha de KV (testes R28 a R30 e RAPG4): leituras desatualizadas ou vazias, gravações com erro, KV apagado e cópia forjada não produzem segundo `POST`, regressão de estado, protocolo duplicado nem perda de recusa.

## Oráculos de resposta e limitações residuais

- Status, corpo e cabeçalhos da resposta ON são idênticos em todos os casos. Com `ctx.waitUntil` (produção), os e-mails, os alertas e o despacho rodam depois da resposta, então o tempo de resposta não depende de o e-mail estar certo.
- **Resíduo de tempo declarado:** um pedido inexistente responde sem consultar o provedor, e um pedido existente faz a consulta antes de responder. Distinguir os dois exige conhecer o UUIDv4 aleatório do pedido (que só aparece no e-mail de entrega), está limitado a 6 tentativas por hora por IP e revela apenas a existência do pedido, nunca a identidade, o estado ou o e-mail. Igualar esse tempo exigiria chamadas falsas ao provedor e não foi feito.
- **Protocolo:** o `protocol` exibido é o código do pedido, que o consumidor já conhece. Cada manifestação também recebe um `request_nonce`, enviado no e-mail como "Identificador da manifestação" e mantido nas reavaliações.
- **Data de contratação:** o início do prazo usa `received_at` do evento de pagamento confirmado (momento em que o webhook chegou), que é igual ou posterior ao pagamento e por isso favorável ao consumidor.
- A mesma `X-Idempotency-Key` por pedido continua valendo na nova tentativa após conciliação (decisão conservadora descrita acima).

## Painel com o interruptor desligado

Com `REFUND_AUTO_DISPATCH` desligado e sem nenhum registro criado pelo modo ON, `/admin/refunds` devolve exatamente o HTML anterior ao PR. A versão estendida (idade do pedido, motivo manual, Reavaliar, tentativas não confirmadas) só aparece com o modo ON ou quando há registros criados por ele, para que um desligamento de emergência não esconda pedidos em andamento. A ação `reevaluate` só existe para registros criados pelo modo ON; para os demais, a resposta continua `400 action_invalid`.

## Desligamento de emergência

Defina `REFUND_AUTO_DISPATCH=false` (ou remova a variável) e publique a configuração pelo processo operacional autorizado. Isso restaura o fluxo manual. O desligamento não apaga protocolos, reservas, estados ambíguos ou pedidos pendentes; eles continuam visíveis e conciliáveis.

## Revisão jurídica pendente

Este desenho implementa a regra técnica informada para o CDC art. 49 e o Decreto 7.962/2013, art. 5º, §§3º e 4º. A confirmação imediata do §4º é a resposta na tela com protocolo para toda manifestação; o e-mail de confirmação vai ao endereço registrado do comprador sempre que ele é comprovado (identidade confirmada, conflito com uma fonte registrada coincidente, ou não verificável depois da reavaliação), e nunca a um endereço apenas digitado. Ainda dependem de revisão jurídica: a redação final dos e-mails, o tratamento operacional de pedidos fora da janela que aleguem vício/falha de entrega, os prazos internos de atendimento manual e a política de retenção dos registros. Este documento não substitui parecer jurídico.
