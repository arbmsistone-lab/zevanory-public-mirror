# Revisão jurídica dos textos de consumo: procedimento e âncoras de confiança

Este documento atende M1 e M-A das reauditorias do PR #946 (rodadas 2 a 5). Ele explica como funciona o portão que impede publicar texto jurídico de consumo sem aprovação.

## O que o portão confere

O script é `scripts/p23/legal_review.py`.

### Impressão digital por bytes (rodada 5)

A impressão digital é o SHA-256 dos **bytes** de tudo o que forma as páginas jurídicas como são servidas:

- Cada página jurídica servida pelo Worker de vendas, a partir do diretório de assets publicado (`sales-public/`):
  - `/termos`;
  - `/reembolso`;
  - `/privacidade`;
  - `/afiliados`.
- Todo asset que essas páginas referenciam, resolvido no próprio artefato: CSS, JS, fontes, imagens e iframes. O CSS é seguido em `url()` e `@import`. A lista exata sai de `legal_review.py --artifact-files`.
  - Um asset local ausente reprova (`LEGAL_ASSET_MISSING`).
  - Um asset externo (`https://`, `//`) reprova (`LEGAL_ASSET_EXTERNAL`).
  - Um caminho fora do artefato reprova (`LEGAL_ASSET_OUTSIDE`).
- As fontes dessas páginas na raiz: `termos/`, `reembolso/`, `privacidade/` e `afiliados/`.
- Os textos de consumo de `data/politica-unica.json`, incluindo `legal_document_version`.

Qualquer byte diferente muda a impressão digital: texto, atributo (`style`, `hidden`, `value`, `srcdoc`, `data-*`), CSS (`::after`, `content`, `display:none`), fonte, imagem ou comentário. Também é exigido exatamente um `<main>` fora de comentários em cada página servida.

### O Worker serve exatamente esses bytes

O Worker de vendas (`worker/sales-public-worker.mjs`, `LEGAL_ROUTES`) responde as quatro rotas jurídicas com o corpo **byte a byte** igual ao arquivo do artefato:

- sem chat do site (as rotas jurídicas não estão em `SITE_CHAT_PAGES`);
- sem troca de HTML do modo de vendas aberto;
- sem reescrita de UTM;
- sem compressão do corpo.

Só os cabeçalhos são da resposta. O teste `tests/legal-routes-artifact.test.mjs` roda o Worker real e compara os bytes de cada rota com o arquivo, com o chat ligado, vendas abertas, UTM, `Accept-Encoding: gzip` e barra final.

### Quando o portão roda

O passo do portão roda no job `deploy` de `zevanory-sales-public-release.yml` e de `central-production-deploy.yml`, em dois momentos:

- como **primeiro comando** do job, para falhar cedo;
- de novo, **logo antes de cada passo que publica**, sobre o artefato exato que vai ao ar.

O corpo do passo é sempre o mesmo:

```
set -euo pipefail
test "$(/usr/bin/git rev-parse HEAD)" = "$GITHUB_SHA"
test -z "$(/usr/bin/git ls-files -v | grep -E '^([a-z]|S) ' || true)"
/usr/bin/git diff --exit-code "$GITHUB_SHA" -- <páginas jurídicas e data/politica-unica.json>
/usr/bin/git fetch --no-tags --quiet origin +refs/heads/gh-pages:refs/remotes/origin/gh-pages
/usr/bin/git show refs/remotes/origin/gh-pages:scripts/p23/legal_review.py > "$RUNNER_TEMP/legal_gate.py"
/usr/bin/python3 -I "$RUNNER_TEMP/legal_gate.py" --root . --publish-gate --anchors-ref refs/remotes/origin/gh-pages
```

O que cada linha garante:

- O `HEAD` do runner é o commit do evento. Um commit local feito por um script do build reprova.
- Nenhum arquivo está marcado como `assume-unchanged` ou `skip-worktree`.
- A árvore não difere do commit do evento nos arquivos jurídicos.
- O código do portão vem do **gh-pages mesclado**, não da árvore em publicação.
- Os binários são chamados por caminho absoluto. Um `PATH` alterado por um passo anterior não troca o `git` nem o `python3`.

### As âncoras de confiança

O cadastro de revisores (`data/p23/legal-reviewers.json`), a linha de base (`data/p23/legal-published-baseline.json`), os registros (`docs/legal/reviews/<sha256>.json`) e o bloco `legal_review` são lidos do **gh-pages já mesclado**, com `git show`, e nunca da árvore em publicação.

### Conferências no histórico do git

1. O commit em deploy tem de estar contido no gh-pages.
2. `authorization_commit` tem de ser o commit do gh-pages que **introduziu** a entrada daquele revisor no cadastro.
3. O registro tem de entrar no gh-pages num commit **posterior** ao `authorization_commit`.
4. `reviewed_commit` tem de ser um commit do gh-pages. A impressão digital **nesse commit** é recalculada e tem de ser igual a `reviewed_sha256`.
5. A linha de base só vale em dois casos:
   - se for a do texto publicado antes da Release 2 (`GENESIS_BASELINE`, calculada sobre `b7671272` com as regras acima; o resultado é o mesmo em `d01dd5ea` e em `a6068e6a`);
   - ou se for o `reviewed_sha256` de um registro de aprovação válido já no gh-pages.
6. `approved_at` não pode estar no futuro. Uma data com hora tolera até 5 minutos de diferença de relógio.

### Resultado

- Artefato igual à linha de base validada: `PASS_UNCHANGED`.
- Artefato diferente: o portão exige uma aprovação válida para essa impressão digital. Sem ela, responde `BLOCKED` e o deploy para antes de tocar a produção. Nada que está no ar é retirado.

## Check protegido antes do merge (o único lugar onde a guarda é imposta)

O check é `.github/workflows/legal-trust-anchors-protected.yml`. Ele roda em `pull_request_target` com o código da **base**; o PR é lido só como dado, num repositório separado, e nunca é executado. Ele roda `scripts/p23/trust_anchor_guard.py` da base.

O check `product-pages / static-audit` usa a definição de workflow do próprio PR. Por isso ele **não** impõe esta guarda, e a validação estrutural não roda mais lá.

### 1. Âncoras

O check responde `TRUST_ANCHORS=CHANGED` para todo PR que altere:

- `data/p23/legal-reviewers.json`, `data/p23/legal-published-baseline.json`, `docs/legal/reviews/**`;
- `data/politica-unica.json`;
- `scripts/p23/**`;
- **qualquer arquivo** em `.github/workflows/` ou `.github/actions/`. A detecção de "workflow que publica" só gera um aviso informativo; a âncora é a regra;
- o que serve as rotas jurídicas em tempo de execução: `sales-worker.mjs`, `worker/sales-public-worker.mjs`, `worker/politica-unica.mjs`, `wrangler.sales.toml` e `scripts/ci/materialize_sales_configs.py`.

### 2. Estrutura dos workflows de deploy

O check responde `TRUST_ANCHORS=GATE_INVALID` quando a estrutura dos dois workflows de deploy no head não garante o portão. A validação roda sempre, com ou sem mudança, e exige:

- O passo do portão (o corpo acima) é o primeiro comando do job `deploy`; antes dele só `actions/checkout`, `actions/setup-python` e `actions/setup-node`.
- Ele aparece de novo logo antes de cada passo que publica.
- Nenhum passo do portão tem `if`, `continue-on-error`, `shell`, `env` ou `working-directory`.
- Conta como "passo que publica":
  - wrangler como comando de publicação, também entre aspas ou via variável;
  - envio de código pela API da Cloudflare;
  - as actions de deploy.
- Nenhum passo que publica, nem o job `deploy`, usa `always()`, `failure()` ou `cancelled()` no `if`.
- Nenhum outro job publica.
- Não há `defaults` no workflow nem no job.
- Não há `BASH_ENV`, `ENV`, `PATH`, `LD_*`, `PYTHON*`, `NODE_OPTIONS` nem `GIT_*` no `env` do workflow ou do job.
- O YAML é válido.

### 3. Linha de base

Se o PR mudar a linha de base, o check também informa se o novo valor corresponde a um registro de aprovação válido **na base**.

### Quando o check passa a valer

`pull_request_target` usa a definição da base, então o check só passa a valer depois que este workflow estiver no gh-pages. Ele não roda no próprio PR #946, que altera âncoras; o merge desse PR já é uma decisão deliberada do proprietário.

## Passos do proprietário (fora deste PR)

Este PR não muda a proteção da branch.

1. **Tornar o check obrigatório.** Acrescentar `legal-trust-anchors-protected / protected-trust-anchors` aos checks obrigatórios do gh-pages (Settings → Branches → gh-pages). Até isso ser feito, um PR que mexa nas âncoras fica vermelho nesse check, mas o merge ainda é possível sem bypass.
2. **Deixar só o merge por squash.** Em Settings → General → Pull Requests, desligar o merge por rebase e o merge commit. Assim, um PR vira um commit no gh-pages, e a regra "o cadastro e a aprovação vêm em PRs separados" fica explícita.

Depois disso, um PR que mexa nas âncoras só entra se o proprietário fizer o bypass da proteção de forma explícita e registrar o motivo no PR. O proprietário é a única conta e não pode aprovar o próprio PR, então revisão obrigatória e CODEOWNERS não funcionam aqui.

## Fluxo para publicar um texto novo

1. Um PR muda o texto. Depois do merge, os deploys param em `BLOCKED`. Nada no ar muda.
2. Num PR separado, o proprietário cadastra o revisor (nome, OAB, `github_login`, `authorized_by: "proprietario"`, `authorized_at`). O PR mexe numa âncora, então o merge é por decisão deliberada. O merge gera o commit S.
3. Num PR seguinte, também por decisão deliberada:
   - a entrada do revisor recebe `authorization_commit = S`;
   - `legal_review` fica APPROVED, com `reviewed_sha256` (`legal_review.py --fingerprint`), `reviewed_commit` (o commit do gh-pages com o artefato revisado) e `document_version`;
   - entra o registro `docs/legal/reviews/<sha256>.json`.
4. O deploy seguinte passa com `PASS_APPROVED`. Depois de publicar, a linha de base pode passar a ser esse `reviewed_sha256`.

## Limites que continuam

- **Só uma conta.** Toda proteção pode ser contornada pelo proprietário. O objetivo é que nenhuma aprovação e nenhuma neutralização do portão entrem **sem** uma decisão explícita dele.
- **Código do repositório antes do portão final, no mesmo job.** No job de deploy de vendas, o build (`scripts/build_sales_public.py`) roda antes do portão final.
  - O portão final pega uma reescrita de página, um commit local, `assume-unchanged` e uma troca de `PATH`.
  - Ele não pega um código **deliberadamente malicioso** que adultere o próprio runner, por exemplo via `sudo` ou `LD_PRELOAD` gravado em `GITHUB_ENV`.
  - Fechar isso exige separar o deploy num job novo, sem código do repositório antes da publicação, com o artefato passado entre jobs. É uma mudança de arquitetura dos workflows de produção, proposta como passo seguinte.
- **O Worker central** não serve as páginas jurídicas (o apex redireciona para `vendas`). Os textos de consumo dele (`data/politica-unica.json`) entram na impressão digital por valor. O código do Worker central não é âncora.

## Decisão do proprietário (L-3)

Enquanto `legal_review` estiver PENDING e o artefato jurídico for diferente do publicado, **todo** deploy desses dois fluxos fica parado no portão, inclusive deploys sem relação com o texto jurídico. A partir da rodada 5, isso inclui qualquer mudança de byte no CSS, nas fontes ou nas imagens que as páginas jurídicas usam.

O GitHub Pages publica só os stubs de redirecionamento de `pages-mirror/`, então não publica texto jurídico.
