# Release 2 × PR #945 — sobreposição proposta, não aplicada

O candidato Release 2 não incorpora o PR #945 (`codex/refund-auto-dispatch@d403fb35383fd55f748757a39f87161bd322d460`). A ordem deve ser decidida pelo Sol.

## Sobreposição

Os dois trabalhos alteram `worker/refund-flow.mjs`:

- #942 acrescenta `REFUND_FORM_SCOPE` e `REFUND_OTHER_PLATFORM`, escopa o formulário e a mensagem de pedido não encontrado ao checkout próprio/Mercado Pago e orienta compras Hotmart para a plataforma correta.
- #945 acrescenta avaliação e despacho automáticos, validação de credencial, protocolo imediato, motivo manual, notificação ao proprietário e idempotência financeira.

## Resolução proposta para auditoria

Se o Sol decidir aplicar #945 depois deste candidato:

1. manter os imports `REFUND_FORM_SCOPE` e `REFUND_OTHER_PLATFORM` de #942 junto aos imports do auto-dispatch de #945;
2. manter integralmente o escopo visível do formulário e a mensagem genérica multicanal de #942;
3. aplicar a máquina de decisão, claim durável, chave `zevanory-refund-<order_id>`, protocolo e estados `outcome_unknown` de #945;
4. executar em conjunto `tests/politica-canais-reembolso.test.mjs`, `tests/refund-auto-dispatch*.test.mjs`, `tests/integration/refund-auto-dispatch-postgres.test.mjs` e os dois executores de mutantes;
5. regenerar `sales-public` e repetir o gate de cópia para impedir que a orientação geral ao Mercado Pago reapareça.

Não há proposta de mudar `REFUND_AUTO_DISPATCH`; ela continua desligada por padrão e qualquer ativação permanece fora deste candidato.
