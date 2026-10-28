# Release 2 — registro da integração

Base imutável: `gh-pages@a098d8802a184df02b362d46f08fb6c81b7382f9`.

## Origem e merge commits

| Ordem | PR | Head de origem | Merge commit no candidato |
|---|---:|---|---|
| 1 | #941 | `c4bfd4bf2d6f0362fd5b605b02cfdda655ad8f51` | `5761786` |
| 2 | #942 | `4c661bcc024d88937ecf27588b616c551ee76ebf` | `ccec36a` |
| 3 | #939 | `067d2f8e392058d18cbd3a9860b2d75347fc8ce0` | `57ae59e` |
| 4 | #940 | `1aa61af73f082c41169448ed80b8f5475f92ccaf` | `98c36cb` |
| 5 | #943 | `cefb58766c735e61f05db4bbba5de7b9f9b24b68` | `21b902c` |

## Conflitos resolvidos

Cada item abaixo identifica o arquivo ou a lista exata de arquivos, o lado usado e o motivo.

### #939 sobre #941 + #942

- `.github/workflows/portfolio-p03-exact.yml`, `.github/workflows/product-pages-premerge.yml`: lado #939; contém os hashes e o gate de cópia correspondentes à nova superfície.
- `data/politica-unica.json`: lado já integrado de #942; preserva a separação factual Mercado Pago × Hotmart. Depois recebeu apenas as correções editoriais de #939 (`contados` e `prazo`, sem mudar o procedimento).
- `data/site-chat-policy.json`: lado #939; o fingerprint precisa acompanhar o catálogo novo.
- `scripts/ci/sales_promise_consistency.py`: lado #939; conserva o mutante regex que cobre todas as ocorrências de "Em breve".
- `combo-ia-vendas/index.html`, `negocio-completo/index.html`, `vendas-na-pratica/index.html`, `zevanory-sales/index.html`: lado #939. `reembolso/index.html` e `termos/index.html`: regra multicanal de #942 com as correções editoriais de #939. `conteudo-pronto/index.html`: contrato v2 mais recente da base, porque o lado #939 reintroduzia WhatsApp e removia a idempotência multicanal; `solucoes/index.html` e `kit-afiliado/index.html` preservam o layout/cópia de #939, mas mantêm os trechos contratuais v2 da base para o Conteúdo Pronto.
- `evidence/zees16/coverage/combo-ia-vendas.json`, `evidence/zees16/coverage/negocio-completo.json`, `evidence/zees16/coverage/vendas-na-pratica.json`: lado #939; evidência correspondente à cópia nova.
- `sales-public/combo-ia-vendas.html`, `sales-public/conteudo-pronto.html`, `sales-public/index.html`, `sales-public/kit-afiliado.html`, `sales-public/negocio-completo.html`, `sales-public/reembolso.html`, `sales-public/solucoes.html`, `sales-public/termos.html`, `sales-public/vendas-na-pratica.html`, `sales-public/zevanory-sales.html`: nenhum lado foi mantido como artefato final; todos foram regenerados por `scripts/build_sales_public.py` a partir das fontes integradas.

### #940 sobre o resultado anterior

- `ia-por-ramo/index.html`: estrutura/layout de #940 com a correção editorial de #939 (`Açaiteria`).
- `sales-public/assets/product.7c0e9a61b6.css`, `sales-public/assets/product.8bf871a289.css`, `sales-public/assets/product.de0025e05a.css`: conflito rename/rename descartado como artefato derivado; o gerador publicou somente o hash atual.
- Os seguintes conflitos em artefatos derivados receberam a estrutura de #940 durante o merge e foram depois integralmente regenerados: `sales-public/404.html`, `sales-public/arbm-contador-saloes.html`, `sales-public/calculadora-cmv.html`, `sales-public/calculadora-fluxo-de-caixa.html`, `sales-public/calculadora-margem-de-lucro.html`, `sales-public/calculadora-ponto-de-equilibrio.html`, `sales-public/calculadora-preco-de-venda.html`, `sales-public/calculadora-preco-hora-servico.html`, `sales-public/calculadora-taxa-maquininha.html`, `sales-public/checklist-15-minutos.html`, `sales-public/combo-ia-vendas.html`, `sales-public/como-cobrar-cliente-pelo-whatsapp.html`, `sales-public/como-mandar-orcamento-pelo-whatsapp.html`, `sales-public/conteudo-pronto.html`, `sales-public/ferramentas.html`, `sales-public/ia-na-pratica.html`, `sales-public/ia-para-academia.html`, `sales-public/ia-para-acaiteria.html`, `sales-public/ia-para-advocacia.html`, `sales-public/ia-para-agencia-de-viagens.html`, `sales-public/ia-para-arquitetura-e-design-de-interiores.html`, `sales-public/ia-para-assistencia-tecnica-de-celular.html`, `sales-public/ia-para-autoescola.html`, `sales-public/ia-para-barbearia.html`, `sales-public/ia-para-clinica-e-consultorio.html`, `sales-public/ia-para-clinica-odontologica.html`, `sales-public/ia-para-confeitaria.html`, `sales-public/ia-para-contabilidade.html`, `sales-public/ia-para-deposito-de-bebidas.html`, `sales-public/ia-para-distribuidora-de-gas-e-agua.html`, `sales-public/ia-para-eletricista-e-encanador.html`, `sales-public/ia-para-escola-de-idiomas.html`, `sales-public/ia-para-estetica.html`, `sales-public/ia-para-farmacia.html`, `sales-public/ia-para-fisioterapia.html`, `sales-public/ia-para-floricultura.html`, `sales-public/ia-para-fotografo.html`, `sales-public/ia-para-hamburgueria.html`, `sales-public/ia-para-imobiliaria.html`, `sales-public/ia-para-lava-jato.html`, `sales-public/ia-para-loja-de-roupas.html`, `sales-public/ia-para-manicure.html`, `sales-public/ia-para-marmitaria.html`, `sales-public/ia-para-materiais-de-construcao.html`, `sales-public/ia-para-mercadinho.html`, `sales-public/ia-para-nutricionista.html`, `sales-public/ia-para-oficina-mecanica.html`, `sales-public/ia-para-otica.html`, `sales-public/ia-para-padaria.html`, `sales-public/ia-para-papelaria.html`, `sales-public/ia-para-pet-shop.html`, `sales-public/ia-para-pizzaria.html`, `sales-public/ia-para-pousada.html`, `sales-public/ia-para-psicologo.html`, `sales-public/ia-para-restaurante-e-lanchonete.html`, `sales-public/ia-para-salao-de-beleza.html`, `sales-public/ia-por-ramo.html`, `sales-public/index.html`, `sales-public/kit-afiliado.html`, `sales-public/lucro-e-caixa.html`, `sales-public/material-gratuito.html`, `sales-public/mensagem-para-cliente-que-sumiu.html`, `sales-public/negocio-completo.html`, `sales-public/quem-criou.html`, `sales-public/solucoes.html`, `sales-public/vendas-na-pratica.html`, `sales-public/zevanory-cfo.html`, `sales-public/zevanory-sales.html`.

### #943 sobre o resultado anterior

- `.github/workflows/trava-vendas-integracao-postgres.yml`: combina os dois lados; mantém o caminho fiscal P23 já presente e acrescenta todas as entradas da lista de espera, sua integração PostgreSQL e mutantes.

## Condições e limites

## Auditoria das alterações posteriores à integração

- `4bb9c14e`: mantido. A normalização LF antes do fingerprint elimina diferenças Windows/Linux tanto no nome quanto nos bytes do ativo; a regeneração precisa continuar produzindo zero byte de diferença no mesmo checkout.
- `4fd065dd` — P24 `offer_receives`: mantido e justificado pela consolidação do layout, que removeu o bloco duplicado `offer-side`. As cinco regiões que restaram continuam obrigatórias e o mapa cobre as promessas visíveis. O ajuste do mutante M25 apenas acompanha literalmente “venda e acompanhamento”.
- `4fd065dd` — P23 L1.4: mantido porque a antiga expectativa de “CEP a confirmar” deixou de ser verdadeira; o gate agora relata a lacuna verificável das páginas-fonte fora de `sales-public`.
- `ea90522d`: reversões não declaradas encontradas e corrigidas: escopo do `/pedir-reembolso` no aviso do chat; seção e âncora `#assinatura-hotmart`; regras correspondentes em Termos; canal Hotmart no FAQ; remoção de “que são a base para vender mais”; endereço legado do 404; regex partido de `pedir-reembolso`. A varredura dos arquivos alterados pelos cinco PRs não encontrou outra perda contratual após a regeneração e os gates de cópia.

O gate jurídico agora exige `data/politica-unica.json.legal_review` com `status=APPROVED`, responsável e data. O candidato permanece deliberadamente em `PENDING`; nenhuma aprovação foi inventada pelo executor.

- A272-01: a matriz local usa o aceite literal do proprietário e reprova overflow horizontal, clipping, painel rolável e fundo inalcançável.
- A272-02: lista de espera comercial e material gratuito têm tabelas, consentimentos e rotinas separados. Abrir vendas não libera ofertas para contatos do material gratuito; os passos comerciais antigos são aposentados. Relação comercial futura exige consentimento separado, auditável e cancelável e não foi implementada.
- A272-03: procedimento por provedor está separado, mas permanece **REVISÃO JURÍDICA PENDENTE**.
- #941: aposentadoria e 308 são cobertos pelos testes; o endereço público é `suporte@zevanory.api.br`; o recebimento do endereço antigo é preservado fora da superfície publicada.
- #943: a integração PostgreSQL simula queda depois do envio pelo provedor falso e antes da exclusão; apó novo Worker, a mesma chave de idempotência não produz segunda entrega.
- O candidato não incorpora #945; a sobreposição está em `docs/release/release-2-x-945.md`.

## Efeito de um merge futuro

Nenhum deploy foi executado por este trabalho. Se o proprietário autorizar e efetuar merge em `gh-pages`, os caminhos alterados acionam os fluxos automáticos existentes:

1. `.github/workflows/central-production-deploy.yml` — publica o Worker central; usa o Environment `producao-critica`.
2. `.github/workflows/zevanory-sales-public-release.yml` — publica o Worker/site de vendas; usa o Environment `producao-critica`.

Essa consequência exige a autorização própria de merge e as proteções do Environment; este candidato não concede nem antecipa essa autorização.

## Reauditoria rodada 2 (Claude, sobre `486c339f`) e ORDEM 294

Base atualizada: merge de `gh-pages` `b7671272` (#947) na branch, sem conflito. Nada foi publicado; vendas fechadas.

- **N-H1 (chat, K030).** O `6ada78f9` voltou a nomear a Hotmart em `customer_wording.subscription_refund`, o que o validador do chat (`worker/site-chat.mjs`, `CHECKOUT_RE`) reprova. A resposta voltou ao texto de #942 sem nomear o processador e ganhou só o que a lei pede ("de imediato e monetariamente atualizados"; "a ZEVANORY comunica imediatamente essa plataforma ou a administradora do cartão"). O §3 do Decreto 7.962 com o nome da Hotmart fica nas páginas jurídicas. O aviso `optional` do chat voltou ao texto literal de #942. Contrato separado: `guardReply` decide só o texto; a intenção de atendimento já classificada (reembolso, cancelamento, arrependimento, entrega, pagamento…) continua em `category`/`intent` e no escalonamento, mesmo quando o texto é bloqueado (`tests/cta-contract-closed.test.mjs` C1–C2).
- **N-M2.** `hasCheckoutCta` voltou a reconhecer a palavra "Hotmart" (inclusive "Assine agora na Hotmart") e o mutante M-S3 voltou ao original. Nenhuma guarda tropeçou em texto legítimo depois disso. Prova de que nenhum CTA comercial volta com `SALE_GLOBALLY_ENABLED=false`: C3–C5 (detector, guardas de e-mail/legenda/chat/P09 ligadas a ele, checkout fechado com interruptor fechado/ilegível, páginas e `/hotmart/` sem link de compra com CORE fechado ou em falha).
- **N-M1 e L-a/L-b.** Termos §3 voltou a ter a frase de #942 sobre as páginas `/hotmart/`, com a asserção original restaurada. Termos §2 e o Resumo voltaram a citar o Conteúdo Pronto (#939); "checkout" voltou a "página de pagamento" em Produtos de terceiros (Termos e Reembolso) e nos passos do `/conteudo-pronto`; texto LGPD de #939 restaurado; "de imediato" no art. 49 (texto único, Termos, Reembolso, assinatura e Estorno Hotmart).
- **N-H2 (matriz no check obrigatório).** Causa reproduzida localmente em ambiente CI-like (Playwright 1.55, axe 4.10.3, só DejaVu/Liberation): o gate media logo após `load`. (a) Em `/ia-por-ramo`, que não tem script, `load` chegava antes das fontes web (`document.fonts.status=loading`; a troca de fonte acontecia durante o axe). (b) Nas páginas de produto a 320/360 px, o `scrollTo` disparava a barra de compra (transição de 0,2 s) e o axe pegava `target-size` "partially obscured"; resultado diferente entre os temas claro/escuro com a mesma geometria. Correções: o gate espera fontes e o fim das animações antes de medir; o axe roda no fim e no topo da página, e um alvo acusado por target-size é medido de novo centralizado (o CI de `864133b0` mostrou a causa exata em `/ia-por-ramo` 1440 px: os links "Ver guia" da última linha ficavam sob o cabeçalho fixo no fim da rolagem, com 11,8 px visíveis, porque a altura da página no runner difere da local; reproduzido localmente com viewport de 850 e 874 px); mede sobreposição de CTA (novo critério, reprova); registra navegador/versões/fontes/viewport e salva capturas das reprovações; o CI publica o artefato. A medição estável revelou um defeito real, corrigido na página: a 320 px a barra de compra tem 157 px e cobria o botão rolado até ela (folga de rolagem de 128 px); `product.css` passa a 184 px em telas ≤ 420 px e `buy-bar.js` iguala a folga à altura real da barra.
- **M5 (lista de espera).** Aviso congelado em `zevanory_waitlist_notices` com estados explícitos: `attempting` (em curso), `unconfirmed` (resultado desconhecido), `confirmed` (entregue/409), `expired` (fora da janela de 23 h; nunca reenviado), e exclusão `requested` → `confirmed`. Nova tentativa só é a mesma mensagem com a mesma chave dentro da janela do provedor; produto confirmado depois vira aviso próprio; falha na exclusão nunca gera segundo envio; saída da pessoa impede qualquer nova tentativa. Provas: PostgreSQL real P10–P12 (e a ferramenta `m5-test.mjs` do auditor), modelo em memória `tests/waitlist-m5.test.mjs` na suíte, mutantes MW16/MW17.
- **KV.** Lista de espera: o marcador "há dados" é gravado antes do registro (KV em falha = 503, nada guardado) e, com a lista desligada, KV ilegível faz a retenção rodar (só apaga). Webhook Hotmart do Conteúdo Pronto: o marcador de evento processado passou a ser gravado por último e o reprocessamento é idempotente por transação (ciclo e e-mail de briefing não se repetem). Interruptor de vendas e chat: KV em falha = fechado/desligado (C4–C5, M7).
- **M1 (revisão jurídica na publicação).** `scripts/p23/legal_review.py`: impressão digital do texto jurídico (páginas `/termos` e `/reembolso` das duas superfícies e textos de consumo de `data/politica-unica.json`, incluindo `legal_document_version`). A aprovação exige revisor cadastrado pelo proprietário em `data/p23/legal-reviewers.json` (vazio hoje), nome igual, data, `reviewed_sha256` igual ao texto atual, `reviewed_commit`, `document_version` e o registro auditável `docs/legal/reviews/<sha256>.json`. O P23 usa a mesma regra; `zevanory-sales-public-release.yml` e `central-production-deploy.yml` rodam `--publish-gate` no job de deploy antes de qualquer chamada à Cloudflare. Texto idêntico ao publicado em `b7671272` (`data/p23/legal-published-baseline.json`) passa sem revisão; texto novo sem aprovação válida bloqueia o deploy (fail-closed).

### Efeito do portão M1 depois do merge

Este candidato muda o texto jurídico; portanto, enquanto `legal_review` estiver `PENDING`, os dois jobs de deploy param no passo "Legal review gate" com `LEGAL_PUBLISH_GATE=BLOCKED`, antes de tocar a produção. Nada que está no ar é retirado: produção segue com os Workers e o texto de `b7671272`. Qualquer outro deploy desses dois fluxos também fica parado até a aprovação, porque o texto no repositório já não é o publicado. Para publicar: o proprietário cadastra o revisor, o revisor aprova a impressão digital atual com o registro em `docs/legal/reviews/`, e depois da publicação a linha de base é atualizada para o mesmo valor.


## Reauditoria rodada 3 (sobre `8c00ba09`)

Base atualizada: merge de `gh-pages` `d01dd5ea` (#949). O único conflito foi a linha de contagem no manifesto da suíte, resolvido somando os dois lados.

- **M-A (identidade jurídica forjável no mesmo PR).** As âncoras de confiança passaram a vir do gh-pages já mesclado e a ser conferidas no histórico do git: o commit de autorização tem de ter introduzido a entrada do revisor, o hash é recalculado no `reviewed_commit` e a linha de base só vale se for a de `b7671272` ou a de um registro de aprovação válido. Também há um check protegido `legal-trust-anchors-protected` (`pull_request_target`, código da base) que reprova PR que altere uma âncora. O procedimento completo está em `docs/legal/legal-review-procedure.md`. As duas forjas do auditor (`m1/forge-baseline` e `m1/forge-reviewer`) agora falham nos quatro modos: no check protegido, no portão com o PR não mesclado, no portão depois de um merge com bypass e sem âncoras. Os testes `tests/legal-publish-gate.test.mjs` G3, G4 e G6 cobrem esses casos.
- **M-B (exceção implícita ao estado de vendas).** `canonicalSalesState`/`canonicalSalesOpen` (`worker/sales-control.mjs`) é o mesmo `open` de `/api/sales/status`. A rota `/lista-de-espera` e o job agendado agora usam esse estado. Com o interruptor ligado e as travas desligadas, nenhum aviso sai, a lista não é apagada e a página mostra o formulário (`tests/waitlist-canonical-sales.test.mjs`).
- **L-1.** As boas-vindas da Hotmart usam uma `Idempotency-Key` por transação, e o link do formulário é derivado do segredo, da assinatura e da transação. Com isso, a mensagem é idêntica e postbacks simultâneos resultam em uma entrega (`tests/hotmart-idempotency.test.mjs`).
- **L-2 (escolhas conscientes da lista de espera).**
  - Um 409 só conta como entregue quando o provedor confirma a chave (`invalid_idempotent_request`).
  - `concurrent_idempotent_requests` deixa o aviso "em curso".
  - Qualquer outro 409 é tratado como resultado desconhecido, e a nova tentativa usa a mesma chave.
  - Provedor fora por mais de 23 h: o aviso expira (`expired`), nunca é entregue, e os dados são apagados. Escolhemos no máximo um aviso, nunca dois.
  - Um 2º produto confirmado depois do 1º aviso gera um 2º e-mail, só sobre esse produto.
  - Se `LEAD_PRIVACY_SECRET` for trocado, os avisos anteriores deixam de ser encontrados pela referência. A troca deve ser feita com a lista inerte ou fora de uma abertura de vendas.
- **L-3.** É decisão do proprietário, documentada: enquanto PENDING, os dois fluxos de deploy ficam parados.
- **L-4.** `approved_at` sem hora vale no máximo até hoje (UTC); com hora, tolera até 5 minutos. A afirmação sobre o GitHub Pages foi corrigida: ele publica só os stubs de `pages-mirror/`.
- **L-5.** O manifesto aponta para a base atual (`SOURCE_BASE`, padrão `d01dd5ea`). No CI, o manifesto é regenerado com `RELEASE_SHA=GITHUB_SHA`, `SOURCE_BASE` = base do PR e `ci_run` (run id), e vai no artefato `release-2-matrix-<sha>` junto com a matriz.

## Reauditoria rodada 3, continuação, e Sol ORDEM 301 (R4)

- **R4 (o contrato da oferta não pode encolher).** O chat do site e a seção "O que você recebe" fazem parte do contrato da oferta.
  - O commit `4fd065dd` deste PR tinha tirado do gate P24 a região obrigatória `offer_receives`, e `45365f8c` (#940) tinha tirado da página a lista "O que você recebe" do bloco da oferta. As duas mudanças foram revertidas:
    - `scripts/build_sales_public.py` volta a gerar `<h3>O que você recebe</h3>` com os itens no `div.offer-side`, antes do CTA;
    - `scripts/p24/product_quality_check.py` e `data/p24/promise-map.json` ficam iguais aos do gh-pages, com seis regiões obrigatórias.
  - O teste novo `tests/p24-offer-contract-regions.test.mjs` prova quatro coisas:
    - o P24 exige as seis regiões e tudo o que a base exige;
    - cada página de produto tem itens em todas elas;
    - o P24 reprova quando o bloco "O que você recebe" some (mutante);
    - o chat continua anexável às mesmas páginas da base, com o widget publicado e o catálogo dos cinco produtos sem conflito.
  - Esse teste falha em `8c00ba09` e passa neste head.
- **M-A, reforço.**
  - O registro de aprovação tem de entrar no gh-pages depois do `authorization_commit` (teste G4 e).
  - O check protegido também reprova o PR que tire dos workflows de deploy o passo do portão ancorado (G6.4).
  - Os limites que continuam (o check não é obrigatório, o merge por rebase é permitido e há uma única conta) estão em `docs/legal/legal-review-procedure.md`.
- **Linhas citadas por #949.** `docs/ops/p22-proof-renewal-investigation.md` e o teste correspondente citam `worker/cloudflare-worker.compat.mjs` e `worker/sales-control.mjs` por número de linha. Os números foram atualizados para a posição atual das mesmas linhas. O conteúdo citado não mudou.

## Reauditoria rodada 4 (sobre `bbd58d95`)

M-B, L-1 e R4 foram confirmados. M-A estava parcial; as correções estão abaixo. O procedimento completo está em `docs/legal/legal-review-procedure.md`.

- **MED-1 (passo do portão neutralizável).** Os dois workflows de deploy passaram a ser âncoras, e qualquer workflow alterado ou criado que publique também reprova o check protegido. A estrutura é validada por `scripts/p23/trust_anchor_guard.py`, inclusive dentro do check obrigatório `product-pages / static-audit`. A validação exige:
  - o portão como primeiro comando do job `deploy`, sem `if`, `continue-on-error`, `shell` nem `env`, com as três linhas exatas;
  - um passo de integridade (`git diff --exit-code HEAD` nos arquivos da impressão digital) logo antes de cada passo que publica;
  - nenhum `always()`, `failure()` ou `cancelled()` no `if` dos passos que publicam;
  - nenhum outro job que publique;
  - nenhum `defaults`, `BASH_ENV`, `PATH`, `PYTHON*` ou `GIT_*`.

  Testes: `tests/legal-publish-gate.test.mjs` G6.4 (variantes `coe`, `ift`, `ortrue`, `newwf` e workflow com `producao-critica`) e G11 (13 neutralizações estruturais).
- **MED-2 (impressão digital só do 1º `<main>`).** Comentários HTML saem antes da extração, é exigido exatamente um `<main>`, e entra todo o texto do `<body>` e o `<title>`. `/privacidade` e `/afiliados` entraram na impressão digital. O `visible()` do P23 também descarta comentários e `<template>`. `GENESIS_BASELINE` e `data/p23/legal-published-baseline.json` foram recalculados sobre `b7671272` com as novas regras (`aa8e8d73…`). Teste G8: isca em comentário, texto depois e antes de `</main>`, dois `<main>`, portão com a isca mesclada e `visible()` do P23.
- **LOW-1.**
  - G9: `reviewed_commit` de outro branch com o mesmo texto é recusado.
  - G10: linha de base e `legal_review` vêm das âncoras quando o gh-pages já avançou.
  - HI3: texto idêntico e nenhum 409 nos postbacks simultâneos.
  - HI4: chave por transação.
  - HI5: guarda `briefingTxn` 25 h depois.
- **LOW-2.** `/lista-de-espera` desligada responde 404 antes de qualquer leitura de KV, inclusive a do interruptor no topo do `fetch` (teste CS5, com o Worker central real e zero operações de KV).
- **LOW-3.** Código morto `_entry_introduced` removido.
- **LOW-5.** O procedimento foi reescrito. Os passos do proprietário ficaram explícitos: tornar o check obrigatório e desligar o merge por rebase. O risco de rebase foi descrito corretamente, e o escopo da impressão digital (`/privacidade` e `/afiliados`) está documentado.
- **Linhas citadas por #949.** Foram atualizadas de novo (`compat.mjs:174` e `:603`), porque o atalho da lista de espera deslocou o arquivo.

## Reauditoria rodada 5 (sobre `ae8e4d51`): desenho por bytes

O desenho convergiu para bytes do artefato, em vez de texto e padrões. O procedimento completo está em `docs/legal/legal-review-procedure.md`.

1. **Portão do artefato antes de cada deploy.**
   - A impressão digital é o SHA-256 dos bytes de cada página jurídica servida e de todo asset que ela referencia (CSS, JS, fontes, imagens), resolvido no artefato, mais as fontes na raiz e os textos de consumo.
   - O passo do portão é o primeiro comando do job `deploy` e se repete logo antes de cada passo que publica. Ele lê o código do portão do gh-pages com `git show`.
   - A gênese foi recalculada (`46675c70…`, igual em `b7671272`, `d01dd5ea` e `a6068e6a`).
   - Testes: G12 (`hide`, `input`, `srcdoc`, `attr`, `css`, asset ausente ou externo) e G8.
2. **Worker sem injeção nas rotas jurídicas.** `LEGAL_ROUTES` servem o corpo byte a byte do artefato, e as páginas jurídicas saíram de `SITE_CHAT_PAGES`. Teste `tests/legal-routes-artifact.test.mjs`, com o Worker real: chat ligado, vendas abertas, UTM, gzip e barra final.
3. **Integridade contra `$GITHUB_SHA`.** O passo exige `HEAD = $GITHUB_SHA`, nenhum `assume-unchanged` ou `skip-worktree`, `git diff --exit-code "$GITHUB_SHA"` e binários por caminho absoluto. Teste G13: commit local (r5-b1), `assume-unchanged` e reescrita simples.
4. **Âncoras conservadoras.**
   - Qualquer mudança em `.github/workflows/` ou `.github/actions/` é `CHANGED`.
   - O que serve as rotas jurídicas também virou âncora: `sales-worker.mjs`, `worker/sales-public-worker.mjs`, `worker/politica-unica.mjs`, `wrangler.sales.toml` e `scripts/ci/materialize_sales_configs.py`.
   - Teste G14: W1, V2 e as variantes de r5-newwf.
5. **Validador só no check protegido.** O passo foi removido de `product-pages-premerge.yml` (que roda com a definição do PR). A detecção de deploy ficou conservadora: aspas, variável, API e actions. Teste G11, com as variantes V1, variável, API e as do portão.
6. As saídas dos scripts do auditor contra o novo head estão em `docs/evidence/pr946-round5-audit/`.
