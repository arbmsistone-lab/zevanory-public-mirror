# Arrependimento com despacho automático

## Escopo e segurança

O fluxo cobre somente pedidos reais pagos pelo checkout próprio do Mercado Pago. Hotmart continua sob o fluxo da própria plataforma. O fechamento de vendas não bloqueia a devolução de um pagamento já confirmado e este código não cria cobranças.

`REFUND_AUTO_DISPATCH` nasce desligado. Somente o valor textual `true` ativa o despacho. Ausência, `false`, `0` ou qualquer outro valor mantêm o comportamento anterior: registro e decisão manual em `/admin/refunds`.

## Fluxo

1. O consumidor informa pedido e e-mail.
2. O Worker cruza o pedido local, o evento de pagamento confirmado, o destinatário da entrega e o pagamento consultado no Mercado Pago.
3. No modo ON, a resposta pública é sempre HTTP 200, com `received`, `protocol` e a mensagem uniforme "Se os dados conferirem, você receberá a confirmação no e-mail usado na compra". O servidor só registra um pedido efetivo quando o endereço corresponde a uma identidade confirmada. Tentativas não confirmadas ficam numa lista separada de auditoria, sem botão de estorno, e não bloqueiam o pedido do comprador. Nenhum e-mail é enviado ao endereço digitado: o destino é relido do registro de entrega ou do pagador verificado junto ao provedor; divergências entre fontes impedem envio e despacho automático.
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
- `manual_reason=payment_event_missing`: pedido marcado pago no banco sem evento financeiro confirmado. Fica em análise manual, sem botão de `approve` até comprovação; não há POST com identificador de pagamento ausente.
- `manual_reason=previously_rejected`: pedido renovado após recusa do dono; histórico de recusa preservado, nunca despacho automático.

As exceções manuais incluem prazo encerrado, pedido ou pagamento não aprovado, valor/referência/oferta divergente, reembolso anterior, disputa/chargeback, certificação e credencial incompatível. Identidade não confirmada é somente tentativa de auditoria separada, nunca pedido manual elegível para o botão de reembolso. Para ser automático, a fotografia do provedor exige explicitamente `transaction_amount_refunded=0`, `refunds=[]`, `status=approved` e `status_detail=accredited`. Qualquer ausência/estado não autorizado é análise manual.

## Credenciais

O modo ON exige `MERCADOPAGO_ENV=production` e `verifyProductionToken`, com hash da conta (`MERCADOPAGO_PRODUCTION_ACCOUNT_HASH16`) e consulta autenticada a `/users/me`, antes da consulta do pagamento e novamente antes de `POST /refunds`. `MERCADOPAGO_ENV=sandbox` aceita somente credencial `TEST-` (sem distinção por caixa). Qualquer igualdade não comprovada falha fechado e entra em análise manual. O alerta de divergência é deduplicado por pedido/motivo por 24h e nunca é disparado para pedido de certificação. Nenhum teste exige credencial real nem consulta provedor vivo.

## Compatibilidade OFF, tempo e idempotência

- Somente o literal **exato** `true` ativa ON; `TRUE`, `True`, ` true`, `true ` e booleano `true` deixam OFF. O corpo da função legada `createRequest` mantém o mesmo SHA-256 de código `9996d28187f4585e16d89b91d4b9644912b24df1dd51b90f778be4f773e08ee9` da base `a098d880`. O teste X12 valida resposta, registro e e-mails com destinatários/assunto/texto exatos; o caminho financeiro OFF continua aceitando a semântica legada de resposta do provedor.
- Antes de `POST` financeiro, a reserva em PostgreSQL é obrigatória. Com `ctx.waitUntil`, o despacho ON prossegue depois da resposta genérica ao consumidor; sem esse contexto, a chamada fica síncrona. O orçamento teórico de verificações e provedores no caminho síncrono pode atingir **aproximadamente 50 segundos** (5s conta, 15s pagamento, 10s e-mail, 20s estorno), sem incluir latência do banco.
- Uma nova chamada após conciliação `reconciled_not_refunded` mantém **a mesma chave por pedido** (`zevanory-refund-<order_id>`). Ela privilegia não produzir estorno duplicado; uma eventual retenção do resultado anterior pelo provedor pode impedir nova tentativa efetiva. É decisão conservadora e exige comprovação pelo GET e revisão do operador, sem alternar automaticamente a chave.
- A checagem de versão/estado do KV impede regressão quando a versão aprovada é observada. **Cloudflare KV não oferece CAS**: isso não comprova serialização sob leituras arbitrariamente desatualizadas. A reserva SQL permanece fonte durável de proteção contra segundo POST; eliminar a limitação do registro KV depende de armazenamento transacional/controle adicional e não está declarado como resolvido por completo.

## Desligamento de emergência

Defina `REFUND_AUTO_DISPATCH=false` (ou remova a variável) e publique a configuração pelo processo operacional autorizado. Isso restaura o fluxo manual. O desligamento não apaga protocolos, reservas, estados ambíguos ou pedidos pendentes; eles continuam visíveis e conciliáveis.

## Revisão jurídica pendente

Este desenho implementa a regra técnica informada para o CDC art. 49 e o Decreto 7.962/2013, art. 5º, §3º. Ainda dependem de revisão jurídica: a redação final dos e-mails, o tratamento operacional de pedidos fora da janela que aleguem vício/falha de entrega, os prazos internos de atendimento manual e a política de retenção dos registros. Este documento não substitui parecer jurídico.
