# Merge autônomo com contra-auditoria (G4)

## Decisão do proprietário (registro literal)

> "APROVO MERGE AUTÔNOMO e tudo mande para contra auditoria"
>
> Airton Renan, 08/11/2026 18:12

## O que muda

Até esta decisão, todo PR que tocasse caminho protegido do guarda `required-check-guard / protected-paths`
(`.github/**`, `scripts/ci/**`, `tests/ci/**`, scripts e políticas dos checks obrigatórios, CODEOWNERS) só passava com o
rótulo `owner-approved:<12 primeiros hex do head SHA>` aplicado por login em `OWNERS`.

Agora existem dois caminhos de liberação, ambos presos ao SHA exato do head (novo push invalida tudo):

| Caso | Liberação aceita |
|---|---|
| PR toca **algum** caminho reservado ao proprietário (`ops/owner-reserved-paths.json`) | só `owner-approved:<12hex>` (comportamento anterior) |
| PR toca caminho protegido, **nenhum** reservado | `owner-approved:<12hex>` **ou** `autonomo-auditado:<12hex>` + registro de contra-auditoria |
| PR não toca protegido nem reservado | nenhum rótulo (inalterado) |

Caminho reservado passou a ser "brando" mesmo fora da lista protegida: um PR que só altera, por exemplo,
`data/products.json` ou `termos/index.html` agora exige `owner-approved:`.

Violações duras (colisão de nome de check, emissor enfraquecido, sombra de módulo, YAML inválido, lista truncada,
lista de reservados ausente) continuam sem liberação por rótulo nenhum.

## Classes reservadas ao proprietário

Lista versionada em `ops/owner-reserved-paths.json` (lida pelo guarda a partir da **base**; um PR não altera a lista que o
avalia, e alterar a lista é, ele próprio, reservado):

1. **Gasto**: gastar dinheiro, planos pagos, orçamento de anúncios (`zero-cost-guard`, `wrangler*.toml`, `plan-probe`).
2. **Fiscal ou jurídico**: NFS-e, tributos, contratos, textos de termos, privacidade e reembolso (`termos/**`,
   `privacidade/**`, `reembolso/**`, cópias em `sales-public/` e `pages-mirror/`, `contracts/**`, processo fiscal).
3. **Credenciais**: criar/rotacionar tokens, segredos, OAuth e o interruptor `ops/token-cutover.json`
   (workflows `*secret*`, `*token*`, `*oauth*`, `*credential*`, `*-key-*` e scripts de rotação).
4. **Marcos irreversíveis**: abrir nível de venda / interruptor de vendas (`zevanory-open-sales`, `zevanory-close-sales`,
   `sales-switch-contract`, `worker/sales-control.mjs`, `scripts/sales_switch_workflow.py`), preços
   (`data/products.json`, `PRICES` em `worker/sales-public-worker.mjs`, `data/p18-commercial-allowlist.json`) e lançamento
   de produto novo (P-3, que passa por `data/products.json`).
5. **Os próprios guardas de governança**: guarda G4, avaliador de impacto de merge, `t1-publisher-guard` (session-guard),
   emissores dos checks obrigatórios, CODEOWNERS, suítes/mutantes da governança, esta página e a própria lista.

Atos fora do repositório (contratar plano pago, emitir NFS-e, criar token no painel) continuam reservados ao proprietário
mesmo quando não há arquivo a detectar.

## Registro da contra-auditoria

O registro é um **comentário no PR**, escrito por login em `OWNERS`, com uma linha exatamente assim:

```
CONTRA-AUDITORIA: PASS <SHA completo de 40 hex do head>
```

- SHA abreviado, maiúsculo, de outro commit ou linha com prefixo não contam.
- Um comentário de `OWNERS` com `CONTRA-AUDITORIA: FAIL <mesmo SHA>` derruba a liberação, mesmo que exista PASS.
- Ordem operacional: publicar o comentário **antes** de aplicar `autonomo-auditado:<12hex>`; o evento `labeled`
  re-dispara o guarda, que relê os comentários.

A central só faz o merge autônomo depois de: contra-auditoria independente PASS para o SHA exato, todo o CI verde no
mesmo SHA e guarda verde. Qualquer dúvida de classificação vai para o proprietário (fail-closed).

## Implementação e testes

- `scripts/ci/required_check_guard.py`: `carregar_reservados`, `reservado`, `contra_auditoria`, `avaliar`.
- `.github/workflows/required-check-guard.yml`: coleta `issues/<PR>/comments` e passa `--reserved` da base.
- `tests/ci/test_required_check_guard.py` T24–T31 e `tests/ci/mutants_required_check_guard.py` M21–M28
  (`required-check-guard / selftest`: 31 testes, 28 mutantes, todos MORTOS).
