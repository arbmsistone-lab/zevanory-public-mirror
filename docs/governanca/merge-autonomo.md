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
| PR toca caminho protegido **fora** da allowlist `rotina_autonoma` | só `owner-approved:<12hex>` |
| PR toca caminho protegido, todos na allowlist `rotina_autonoma` e **nenhum** reservado | `owner-approved:<12hex>` **ou** `autonomo-auditado:<12hex>` + registro de contra-auditoria |
| PR não toca protegido nem reservado | nenhum rótulo (inalterado) |

Caminho reservado passou a ser "brando" mesmo fora da lista protegida: um PR que só altera, por exemplo,
`data/products.json` ou `termos/index.html` agora exige `owner-approved:`.

Violações duras (colisão de nome de check, emissor enfraquecido, sombra de módulo, YAML inválido, lista truncada,
lista de reservados ausente) continuam sem liberação por rótulo nenhum.

## Allowlist de rotina (correção NC-1 da contra-auditoria)

Abordagem escolhida por ser a mais simples e segura: `autonomo-auditado:` **nunca** libera um caminho protegido por
exclusão; só libera os que casam com a allowlist explícita `rotina_autonoma` de `ops/owner-reserved-paths.json`:

- `scripts/ci/mutants_*.py`, `scripts/ci/mutants_*.json`, `scripts/ci/mutants_*.mjs` (harnesses de mutantes de produto),
  `scripts/ci/test_mutants_conteudo_pronto_classifier.py`, `scripts/ci/*.test.mjs`;
- `tests/ci/**`.

As classes reservadas sempre vencem a rotina (ex.: mutantes de credencial, de checkout, jurídicos e os testes do
próprio guarda continuam reservados). Todo outro caminho da lista protegida antiga — inclusive script novo em
`scripts/ci/` — exige `owner-approved:`. A allowlist é inválida (rc 2) se estiver vazia ou cobrir `.github/`, o guarda ou a
lista. Caminhos fora da lista protegida e fora das classes reservadas (conteúdo, `docs/**`, `worker/*` comuns) seguem sem
rótulo, como antes.

## Classes reservadas ao proprietário

Lista versionada em `ops/owner-reserved-paths.json` (lida pelo guarda a partir da **base**; um PR não altera a lista que o
avalia, e alterar a lista é, ele próprio, reservado):

1. **Gasto**: gastar dinheiro, planos pagos, orçamento de anúncios (`zero-cost-guard`, `wrangler*.toml`, `plan-probe`).
2. **Fiscal ou jurídico**: NFS-e, tributos, contratos, textos de termos, privacidade e reembolso (`termos/**`,
   `privacidade/**`, `reembolso/**`, cópias em `sales-public/` e `pages-mirror/`, `contracts/**`, processo fiscal,
   política única `worker/politica-unica.mjs` + `data/politica-unica.json`, fluxo de reembolso `worker/refund-*.mjs`,
   `worker/asaas-pix-refund-auth.mjs`, `db/migrations/*refund*`). Os globs `**/*nfse*`, `**/*nfse*/**` e `**/*nfs-e*`
   ainda não casam com arquivo nenhum: são **intencionais**, para a futura emissão de NFS-e. O mesmo vale para
   `CODEOWNERS` e `docs/CODEOWNERS` (locais alternativos que o GitHub aceita).
3. **Credenciais**: criar/rotacionar tokens, segredos, OAuth e o interruptor `ops/token-cutover.json`. **`.github/**`
   inteiro** (todo workflow alcança `secrets.*`), scripts de build/deploy/segredos/gates em `scripts/ci/`
   (`cloudflare-build.sh`, `cloudflare-post-deploy-verify.sh`, `secret_scan.py`, `credential_separation_gate.py`,
   `operator_token_gate.py`, `production-secret-names.mjs` etc.), seus mutantes e testes, e scripts de rotação.
4. **Marcos irreversíveis**: abrir nível de venda / interruptor de vendas (`zevanory-open-sales`, `zevanory-close-sales`,
   `sales-switch-contract`, `worker/sales-control.mjs`, `scripts/sales_switch_workflow.py`, `worker/nc015-sales-scope.mjs`,
   `worker/sales-lock-content.mjs`, `worker/commercial-checkout-guard.mjs`, `worker/payment-link-expiry.mjs`,
   `db/migrations/*checkout*`, `worker/sales-ledger.mjs` — razão de vendas é contabilidade), preços
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
- Criar, editar ou apagar um comentário que contenha (ou continha) `CONTRA-AUDITORIA` dispara
  `.github/workflows/contra-auditoria-reavaliar.yml` (`issue_comment`), que re-executa a última execução do guarda no
  head do PR: um `FAIL` posterior ou a edição/remoção do `PASS` retira o verde.

A central só faz o merge autônomo depois de: contra-auditoria independente PASS para o SHA exato, todo o CI verde no
mesmo SHA e guarda verde. Qualquer dúvida de classificação vai para o proprietário (fail-closed).

## Preço em fonte única (NC-1006-02, contra-auditoria GPT-6)

Reservar só os arquivos "de preço" não bastava: e-mails, motor de aquisição, atendimento, criativos, blog, Shorts,
páginas e dados também citam preço e condição. Por isso:

- **Fonte canônica única:** `data/products.json` (5 kits + Conteúdo Pronto). Combo IA + Vendas economiza 37 sobre 194;
  Negócio Completo economiza 94 sobre 341 — sempre derivados da tabela (`worker/product-prices.mjs`, reservado).
  `worker/lead-magnet.mjs`, `worker/acquisition-engine.mjs`, `worker/support-knowledge.mjs`, `worker/creative-autonomy.mjs`,
  `worker/multichannel-autonomy.mjs` e `scripts/channels/{youtube-daily-short,render-youtube-short,youtube-preflight}.mjs`
  importam o preço em vez de repetir literais (o Short diário e o de boas-vindas ainda tinham a tabela velha 197/247/297/397).
- **Gate reservado:** `tests/governanca/price-gate.mjs` + `tests/governanca/price-consistency-gate.test.mjs` varrem as fontes
  de produção (worker/**, scripts/** exceto scripts/ci, sales-public/**, páginas, pages-mirror, data/**, content/**,
  sales-overlay/**) atrás de "R$ N"/"N reais" perto de nome/slug/SKU, campos de preço em objeto com produto e mapas
  SKU→preço; qualquer valor fora da tabela (ou dos derivados documentados: soma/economia do pacote, comissão à taxa de `data/affiliates.json`)
  reprova. Exceções só em lista fechada dentro do gate, com quantidade exata.
- **Contra-auditoria do #1008 (NC-1008-01):** HTML lido só por nós de texto (tag no meio do valor não esconde nada) +
  JSON-LD (offers aninhados e textos do FAQ); página de produto exige que TODO valor da página seja do produto; valores
  sem R$, por extenso, "BRL N" e produto longe na mesma frase contam; em JS de produção não reservado é proibida
  aritmética sobre preço (priceBy*, PRICE_BY_SKU, *.price) e literal em campo de preço, mapa/par SKU→número e Map;
  cupom/desconto/"% off"/"por cento" junto de produto reprova fora de arquivo reservado. Um teste IMPORTA os módulos
  (e-mails, motor de aquisição, atendimento, Shorts/legendas, criativos, blog) e confere o preço renderizado.
- **Literal em variável/template (NC-1008-04):** em JS de produção não reservado também reprova variável com nome de
  preço = literal, variável = literal usada em `"R$ "+x`, `` `R$ ${x}` `` ou campo de preço, literal direto em
  `"R$ " + N` / `` `R$ ${N}` ``, e aritmética sobre qualquer variável que recebe priceBy*/PRICE_BY_SKU/bundle*. Os
  scripts do Short de boas-vindas exportam `welcomeCreative()` e o teste runtime confere o preço renderizado.
- **Comissão (NC-1008-03):** taxa só em `data/affiliates.json` (reservado): Hotmart 30%, último clique, cookie de 60 dias,
  aprovação manual (decisão do proprietário, F0 item 4); programa próprio 30% com atribuição de 30 dias (mantida). `worker/affiliate-program.mjs` lê a taxa e o prazo de
  atribuição dessa fonte; o gate só aceita a comissão derivada nas páginas de afiliado listadas nela, e a regra T6
  (`COMISSAO_PCT`) reprova, em qualquer arquivo de produção (inclusive meta/og/twitter), um percentual de afiliado ("N%",
  "até N%", "N% em comissão", número por extenso, "metade") que não seja uma dessas taxas, só em frase com contexto de afiliado
  (afiliad*, indicação, link de divulgação, venda indicada; "comiss" junto de hotmart/divulg/parceir fora de frase de meio de
  pagamento; em página de afiliado também "comiss" sozinho). Desconto, cartão e "comissão de 4% da maquininha" não contam;
  "30% afiliado / 70% produtor" é aceito.
- **Onde roda:** no check obrigatório `product-pages / static-audit` (`product-pages-premerge.yml:audit` e
  `required-status-compat.yml:product-status`), com contagem exata (`# tests 11`). Pendente fora do PR (NC-1008-02):
  `required-check-guard / protected-paths` precisa virar check obrigatório na proteção de branch de gh-pages. O guarda trata a ausência desse passo
  num emissor canônico como violação DURA (`GATE_DE_PRECO_AUSENTE`) e exige que a lista reserve a tabela, o módulo de
  derivação e o gate (`RESERVED_SELF`), que `rotina_autonoma` não pode cobrir.
- Resultado: um PR `autonomo-auditado` que mude só um preço em `worker/lead-magnet.mjs` passa no guarda mas fica com o
  check obrigatório vermelho; mudar o gate ou a tabela exige `owner-approved:<12 hex>`.
- Também reservados agora (condições comerciais além do preço): `worker/affiliate-program.mjs` (taxa de comissão e prazo
  de atribuição), páginas de afiliado (`afiliados/**`, `kit-afiliado/**`, `sales-public/{afiliados,kit-afiliado}.html`,
  `pages-mirror/*afiliad*`) e `sales-overlay/approved.json` (textos de arrependimento/garantia/termos). Checkout
  (`HOTMART_CHECKOUT`/`SERVICE_CHECKOUT` em `worker/sales-public-worker.mjs`), garantia (`data/products.json`) e
  prazos/reembolso (`data/politica-unica.json`) já eram reservados.

## Implementação e testes

- `scripts/ci/required_check_guard.py`: `carregar_reservados`, `carregar_rotina`, `reservado`, `rotineiro`,
  `contra_auditoria`, `avaliar`.
- `.github/workflows/required-check-guard.yml`: coleta `issues/<PR>/comments` e passa `--reserved` da base.
- `tests/ci/test_required_check_guard.py` T24–T42 e `tests/ci/mutants_required_check_guard.py` M21–M38
  (`required-check-guard / selftest`: 42 testes, 38 mutantes, todos MORTOS). T37–T39/M32–M34: gate de preço reservado,
  barreira no check obrigatório para preço em arquivo comum com rótulo autônomo, emissor sem o gate.
  T40–T42/M35–M38 (contra-auditoria do #1008): `scripts/ci/runtime_ddl_gate.py` (reservado) roda nos dois emissores de
  `product-pages / static-audit`, sem filtro de caminho e sem Postgres; reprova DDL interpolado em qualquer `worker/*.mjs`
  (escaneamento próprio + `runtime_ddl()`/`dynamic_ddl()` de `scripts/ops/restore_new_database.py`, que precisam
  concordar). O guarda exige o passo com as linhas exatas (`set -euo pipefail`, `--self-test`, execução), sem
  `shell:`/`env:`; ausência é violação dura `GATE_DDL_AUSENTE`. NC-1013-01/02: reprova também valor concatenado no
  corpo do DDL (delimitador JS de abertura dentro do corpo); compara com o restore a lista exata de comandos (não só os
  nomes) e o DDL dinâmico pelos 12 comandos esperados; as exceções de nome (`${BACKUP_TABLE}` com valor fixo e a
  concatenação do whatsapp-neon-store) valem para exatamente um comando cada. `scripts/ops/restore_new_database.py`
  passou a ser reservado. `tests/ci/mutants_runtime_ddl_gate.py`: 7 mutantes do gate, mortos pelo `--self-test`
  (10 casos). Follow-up do #1013: (OBS-1013-03) o DDL dinâmico precisa ser igual, por inteiro e com espaços
  normalizados, à fonte própria lida estaticamente do array `ddl` de `worker/whatsapp-neon-store.mjs` (coluna ou
  restrição trocada com os mesmos nomes reprova; forma não extraível reprova `FONTE_DINAMICA_NAO_EXTRAIVEL`); reprova
  `alter table` interpolado, concatenado ou não capturado inteiro pela regex do restore, `create index` não literal,
  `create table` fora do formato do restore (espaço duplo, sem IF NOT EXISTS) e DDL em `.js`/subdiretório de `worker/`.
  Exceções estreitas com cota exata: `create table ${DRILL}.%I` do ensaio em `data-backup.mjs`, os 2 `create index`
  concatenados do whatsapp e os ALTERs multi-coluna de `zevanory_kv_backup` e `zevanory_support_inbound`, aceitos só se
  redundantes com o CREATE TABLE literal da mesma tabela. 20 mutantes (G01–G20), mortos pelo `--self-test` (29 casos).
