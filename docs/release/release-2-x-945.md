# Release 2 × PR #945 — sobreposição proposta, não aplicada

O candidato Release 2 não incorpora o PR #945 (`codex/refund-auto-dispatch@0c3619829d17af9840c1484da04c753779bd365c`). A ordem deve ser decidida pelo Sol.

## Sobreposição

Os dois trabalhos alteram `worker/refund-flow.mjs`:

- #942 acrescenta `REFUND_FORM_SCOPE` e `REFUND_OTHER_PLATFORM`, escopa o formulário e a mensagem de pedido não encontrado ao checkout próprio/Mercado Pago e orienta compras Hotmart para a plataforma correta.
- #945 acrescenta avaliação e despacho automáticos, validação de credencial, protocolo imediato, motivo manual, notificação ao proprietário e idempotência financeira.

## Resolução proposta para auditoria

Se o Sol decidir aplicar #945 depois deste candidato:

1. manter os imports `REFUND_FORM_SCOPE` e `REFUND_OTHER_PLATFORM` de #942 junto aos imports do auto-dispatch de #945;
2. manter integralmente o escopo visível do formulário e a mensagem genérica multicanal de #942;
3. aplicar a máquina de decisão, claim durável, chave `zevanory-refund-<order_id>`, protocolo e estados `outcome_unknown` de #945;
4. executar em conjunto `.github/workflows/trava-vendas-integracao-postgres.yml`, o inventário `tests/node-suite.manifest`, `tests/politica-canais-reembolso.test.mjs`, `tests/refund-auto-dispatch*.test.mjs`, `tests/integration/refund-auto-dispatch-postgres.test.mjs` e os dois executores de mutantes;
5. regenerar `sales-public` e repetir o gate de cópia para impedir que a orientação geral ao Mercado Pago reapareça.

Não há proposta de mudar `REFUND_AUTO_DISPATCH`; ela continua desligada por padrão e qualquer ativação permanece fora deste candidato.

## Publicação futura e leituras pós-merge

O merge futuro em `gh-pages` dispara os publicadores automáticos aplicáveis, inclusive `central-production-deploy.yml` e `zevanory-sales-public-release.yml`; este PR não os dispara manualmente. Depois da publicação central, as cadeias de leitura/validação incluem `t1-publisher-guard` em `gh-pages-automacao`, `credential-scope` e `lead-privacy-source`, além das verificações encadeadas pelo próprio deploy central. Elas são observações pós-merge, não autorização para publicar.

O commit `98c36cbd` isolado não contém a regra CSS `.amp`; ela só existe no candidato consolidado após a resolução/regeneração. Portanto, esse commit não deve ser usado sozinho como prova visual do Release 2.
