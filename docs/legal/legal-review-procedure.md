# Revisão jurídica dos textos de consumo: procedimento e âncoras de confiança

Este documento atende M1 e M-A das reauditorias do PR #946 (rodadas 2, 3 e 4). Ele explica como funciona o portão que impede publicar texto jurídico de consumo sem aprovação.

## O que o portão confere

O script é `scripts/p23/legal_review.py`. No deploy, ele roda com:

```
--publish-gate --anchors-ref refs/remotes/origin/gh-pages
```

Ele roda no job `deploy` de dois workflows:

- `zevanory-sales-public-release.yml`;
- `central-production-deploy.yml`.

Em cada um, ele é o **primeiro comando** do job: antes dele só rodam `actions/checkout`, `actions/setup-python` e `actions/setup-node`. Ou seja, nenhum código do repositório roda antes do portão.

O portão separa duas coisas: o texto a publicar e as âncoras de confiança.

### O texto a publicar

É a árvore em deploy. A impressão digital é o SHA-256 de **todo o texto visível** das páginas jurídicas, nas duas superfícies (`sales-public/*.html` e `<rota>/index.html`):

- `/termos`;
- `/reembolso`;
- `/privacidade` (LGPD);
- `/afiliados` (contrato do programa de afiliados).

Também entram os textos de consumo de `data/politica-unica.json`, incluindo `legal_document_version`.

Regras da extração (MED-2, rodada 4):

- Os comentários HTML são removidos antes de tudo. Uma isca `<main>` dentro de comentário não engana a extração.
- A página precisa ter exatamente um `<main>`. Se não tiver, a extração falha com `LEGAL_FINGERPRINT_MAIN_INVALID`.
- Entra todo o texto do `<body>`: antes, dentro e depois do `<main>`, inclusive `<noscript>` e `<template>`. Entram também o conteúdo de `<script>` e `<style>` inline, o `src` de scripts externos e o `<title>`.
- Qualquer texto visível acrescentado muda a impressão digital. Um comentário puro não muda.

O checklist do P23 (`visible()` em `scripts/p23/ecommerce_legal_gate.py`) também descarta comentários e `<template>` antes de procurar as frases obrigatórias.

### As âncoras de confiança

Elas são lidas do **gh-pages já mesclado**, com `git show`, e nunca da árvore em publicação:

- o cadastro `data/p23/legal-reviewers.json`;
- a linha de base `data/p23/legal-published-baseline.json`;
- os registros `docs/legal/reviews/<sha256>.json`;
- o bloco `legal_review`.

### Conferências no histórico do git

1. O commit em deploy tem de estar contido no gh-pages.
2. `authorization_commit` tem de ser o commit do gh-pages que **introduziu** a entrada daquele revisor no cadastro.
3. O registro `docs/legal/reviews/<sha256>.json` tem de entrar no gh-pages num commit **posterior** ao `authorization_commit`, nunca antes nem no mesmo commit.
4. `reviewed_commit` tem de ser um commit do gh-pages. Um commit de outro branch com o mesmo texto não serve. A impressão digital do texto **nesse commit** é recalculada e tem de ser igual a `reviewed_sha256`.
5. A linha de base só vale em dois casos:
   - se for o texto publicado antes da Release 2 (`GENESIS_BASELINE`, calculado sobre `b7671272` com as regras acima);
   - ou se for o `reviewed_sha256` de um registro de aprovação válido já no gh-pages.

   Escrever um valor no arquivo não basta.
6. `approved_at` não pode estar no futuro. Uma data sem hora vale no máximo até hoje (UTC). Uma data com hora tolera até 5 minutos de diferença de relógio.

### Resultado

- Texto igual à linha de base validada: `PASS_UNCHANGED`.
- Texto novo: o portão exige uma aprovação válida para essa impressão digital.
- Sem aprovação: `BLOCKED`, e o deploy para antes de tocar a produção. Nada que está no ar é retirado.
- Uma árvore antiga não se autoriza com a própria linha de base nem com o próprio `legal_review`. Valem sempre as âncoras do gh-pages atual.

### Integridade até o deploy

Antes de **cada** passo que publica, há um passo de integridade que roda:

```
git diff --exit-code HEAD -- <os mesmos arquivos da impressão digital>
```

Isso prova que a árvore enviada à Cloudflare tem exatamente o texto que o portão conferiu, inclusive depois do build de `sales-public/`.

## Check protegido antes do merge

O check é `.github/workflows/legal-trust-anchors-protected.yml`. Ele roda em `pull_request_target`, com o código da base; o PR é lido só como dado, no mesmo padrão de `secret-scan-contract-protected` (#950). Ele faz três coisas.

### 1. Reprova a alteração de âncoras

Resposta `TRUST_ANCHORS=CHANGED`, para todo PR que altere:

- `data/p23/legal-reviewers.json`
- `data/p23/legal-published-baseline.json`
- `docs/legal/reviews/**`
- `data/politica-unica.json`
- `scripts/p23/**`
- o próprio workflow protegido
- os **dois workflows de deploy** acima

### 2. Reprova workflow que publica

Também responde `CHANGED` quando o PR altera ou cria **qualquer outro workflow que publique**. Conta como publicar:

- `wrangler deploy` ou `publish` sem `--dry-run`, `versions deploy` ou `pages deploy`;
- `cloudflare/wrangler-action`, `cloudflare/pages-action` ou `actions/deploy-pages`;
- uso do Environment `producao-critica`.

### 3. Valida a estrutura dos workflows de deploy

Resposta `TRUST_ANCHORS=GATE_INVALID`. A estrutura dos dois workflows de deploy no head é validada sempre, mesmo sem mudança:

- O passo do portão é o primeiro comando do job `deploy`. Ele roda exatamente as três linhas esperadas e não tem `if`, `continue-on-error`, `shell`, `env` nem `working-directory`.
- Cada passo que publica vem logo depois do passo de integridade e não usa `always()`, `failure()` ou `cancelled()` no `if`.
- O job `deploy` não usa `always()`, `failure()` ou `cancelled()` no `if`, nem tem `continue-on-error`.
- Nenhum outro job desses workflows publica.
- Não há `defaults` (troca de shell) no workflow nem no job.
- Não há `BASH_ENV`, `ENV`, `PATH`, `LD_*`, `PYTHON*`, `NODE_OPTIONS` nem `GIT_*` no `env` do workflow ou do job.

A mesma validação estrutural roda no check **obrigatório** `product-pages / static-audit`, com `trust_anchor_guard.py --validate-workflows`, e na suíte (`tests/legal-publish-gate.test.mjs` G11).

Se o PR mudar a linha de base, o check também informa se o novo valor corresponde a um registro de aprovação válido **na base**.

### Quando o check passa a valer

`pull_request_target` usa a definição da base, então o check só passa a valer depois que este workflow estiver no gh-pages. Portanto ele não roda no próprio PR #946. Este PR altera âncoras (o script do portão, `data/politica-unica.json` e os dois workflows de deploy), então o merge dele já é uma decisão deliberada do proprietário.

## Passos do proprietário (fora deste PR)

Este PR não muda a proteção da branch. Para o desenho ficar completo, o proprietário precisa fazer duas coisas.

1. **Tornar o check obrigatório.** Acrescentar `legal-trust-anchors-protected / protected-trust-anchors` aos checks obrigatórios do gh-pages, em Settings, Branches, gh-pages. Enquanto ele não for obrigatório, um PR que mexa nas âncoras fica vermelho nesse check, mas o merge ainda é possível sem bypass.
2. **Desligar o merge por rebase.** Em Settings, General, Pull Requests, deixar só o squash.
   - O "rebase and merge" do GitHub reescreve os SHAs. Por isso, um PR com dois commits (cadastro e depois aprovação citando o 1º) já não funciona: o `authorization_commit` citado não existiria no gh-pages.
   - Mesmo assim, ficar só com o squash garante "um PR = um commit no gh-pages" e torna explícita a regra "o cadastro e a aprovação vêm em PRs separados".

Com o check obrigatório, um PR que mexa nas âncoras só entra se o proprietário fizer o bypass da proteção de forma explícita e registrar o motivo no PR. O proprietário é a única conta e não pode aprovar o próprio PR, então revisão obrigatória e CODEOWNERS não funcionam aqui.

## Fluxo para publicar um texto novo

1. Um PR muda o texto. Depois do merge, os deploys param em `BLOCKED`. Nada no ar muda.
2. Num PR separado, o proprietário cadastra o revisor em `legal-reviewers.json`, com nome, OAB, `github_login`, `authorized_by: "proprietario"` e `authorized_at`. Esse PR mexe numa âncora, então o check fica vermelho e o merge é por decisão deliberada do proprietário. O merge gera o commit S.
3. Num PR seguinte, também por decisão deliberada, entram:
   - a entrada do revisor recebe `authorization_commit = S`;
   - `legal_review` fica APPROVED, com `reviewed_sha256` igual à impressão digital do texto, `reviewed_commit` igual ao commit do gh-pages que contém o texto e `document_version`;
   - o registro `docs/legal/reviews/<sha256>.json`.
4. O deploy seguinte passa com `PASS_APPROVED`. Depois de publicar, a linha de base pode passar a ser esse `reviewed_sha256`, porque ele corresponde a um registro válido.

## Limites que continuam

- Com uma única conta, toda proteção pode ser contornada pelo proprietário. O objetivo é que nenhuma aprovação, e nenhuma neutralização do portão, entre **sem** uma decisão explícita dele.
- Texto montado em tempo de execução por um script externo (por exemplo, o widget do chat) não entra na impressão digital, porque só o `src` do script é considerado. O chat do site tem contrato e testes próprios, e o widget só é anexado com `SITE_CHAT_ENABLED`.
- O passo de integridade usa o `git` do runner. Um código malicioso no build de `sales-public/` que adulterasse o próprio runner exigiria mudar `scripts/build_sales_public.py` com esse propósito. Isso fica fora do alcance de uma simples mudança de texto e é visível na revisão do PR.

## Decisão do proprietário (L-3)

Enquanto `legal_review` estiver PENDING e o texto do repositório for diferente do publicado, **todo** deploy desses dois fluxos fica parado no portão, inclusive deploys sem relação com o texto jurídico.

Isso é por desenho e cabe ao proprietário decidir: manter esse bloqueio ou restringir o portão às superfícies jurídicas.

O GitHub Pages publica só os stubs de redirecionamento de `pages-mirror/`, então não publica texto jurídico.
