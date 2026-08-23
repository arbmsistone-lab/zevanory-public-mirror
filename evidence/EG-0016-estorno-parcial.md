# EVIDENCE GATE

ID: EG-0016 / Estorno parcial e reconciliacao cumulativa
Decisao: suportar estornos parciais como snapshots cumulativos reconciliados pelo provedor.
Problema: multiplos estornos parciais nao podem virar duplicidade nem ser tratados como estorno total.

## Evidencia 1
Fonte: Asaas Refunds / Payment Events
Classe: A
Constatacao: Asaas expõe PAYMENT_PARTIALLY_REFUNDED e array refunds; somente refunds com status DONE contam, e pode haver multiplos estornos parciais.
Limite: contrato especifico Asaas; deve ser conferido via GET do pagamento.

## Evidencia 2
Fonte: Mercado Pago Refund API
Classe: A
Constatacao: reembolso parcial informa amount e exige X-Idempotency-Key; repeticao segura nao pode gerar devolucao duplicada.
Limite: provedor alternativo; contrato de webhook difere.

## Evidencia 3
Fonte: Adyen Refund API / REFUND webhook
Classe: A
Constatacao: permite multiplos reembolsos parciais ate o valor capturado e confirma resultado assincronamente por webhook referenciado ao pagamento original.
Limite: provedor alternativo; usado como evidencia de desenho, nao como contrato Asaas.

## Veredito
Veredito: APROVADO
Criterio: armazenar snapshot cumulativo de valor DONE; parcial quando 0 < total < pagamento; integral quando total = pagamento; nunca exceder pagamento.
Kill-switch: ausencia de refunds DONE, soma invalida, referencia divergente ou API indisponivel bloqueiam conciliacao.
