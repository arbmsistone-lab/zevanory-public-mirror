# EXP-0001 - Validacao comercial da OFFER-0001

Status: PRONTO TECNICAMENTE / NAO INICIADO COMERCIALMENTE.
Evidence Gate: EG-0006.

Hipotese: pequenos negocios com processo comercial manual no WhatsApp demonstram disposicao real a pagar por uma implementacao guiada de IA aplicada a atendimento e follow-up.

## Eventos obrigatorios
page_view -> cta_whatsapp -> lead_qualified -> offer_sent -> checkout_started -> payment_confirmed -> refund_confirmed.

## Regras de integridade
- Clique nao conta como lead.
- Lead nao conta como venda.
- Checkout nao conta como pagamento.
- payment_confirmed so pode vir de provedor autenticado.
- Refund deve reduzir o resultado economico.
- Resultados sem tracking completo sao invalidos.

## Interpretacao
Um primeiro pagamento real comprova apenas existencia de disposicao a pagar em pelo menos um caso; nao comprova repetibilidade, escala ou efeito causal da IA.
G2 so fecha quando houver pagamento real reconciliado. Repetibilidade pertence aos gates posteriores.
