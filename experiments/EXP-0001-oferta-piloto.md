# EXP-0001 - ARBM SIST / OFFER-0001

Status: PRONTO TECNICAMENTE / PR?-LAN?AMENTO / VENDAS BLOQUEADAS AT? APROVA??O GLOBAL.
Produto: ARBM SIST 10.0.0 - produto digital proprio do portfolio ZEVANORY, sem estoque.
Preco comercial definido: R$ 1.197 para ARBM PRO; valor ainda nao validado por comportamento comercial real.

## Hip?tese
PMEs brasileiras com venda e atendimento digital podem demonstrar disposicao a pagar pelo ARBM SIST quando a operacao provar ganho real, entrega segura e resultado mensuravel.

## Canais prim?rios
ZEVANORY -> YouTube -> Instagram -> WhatsApp.

## Eventos obrigat?rios
page_view -> cta_whatsapp -> lead_qualified -> offer_sent -> checkout_started -> payment_confirmed -> refund_confirmed.

## Integridade
Clique nao conta como lead. Lead nao conta como venda. Checkout nao conta como pagamento. payment_confirmed so pode vir de provedor autenticado. Entrega digital somente apos pedido pago e pagamento reconciliado. Refund deve reduzir o resultado economico. Resultados sem tracking completo sao invalidos.

## Regra de release
Nenhuma venda p?blica pode iniciar enquanto PRE_SALE_GATES_APPROVED e SALE_GLOBALLY_ENABLED permanecerem false. O experimento n?o autoriza bypass de identidade, pagamento, reconcilia??o, fulfillment ou canal.
