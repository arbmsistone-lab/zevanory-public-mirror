# Revisão jurídica dos textos de consumo: procedimento e âncoras de confiança

Este documento atende M1 e M-A das reauditorias do PR #946 (rodadas 2 a 6). Ele explica como funciona o portão que impede publicar texto jurídico de consumo sem aprovação.

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
- O código que serve as rotas jurídicas e a configuração dele (rodada 6): `sales-worker.mjs`, `worker/sales-public-worker.mjs`, `worker/politica-unica.mjs` e `wrangler.sales.toml`.
- Os textos de consumo de `data/politica-unica.json`, incluindo `legal_document_version`.

Qualquer byte diferente muda a impressão digital: texto, atributo (`style`, `hidden`, `value`, `srcdoc`, `data-*`), CSS (`::after`, `content`, `display:none`), fonte, imagem ou comentário. Também é exigido exatamente um `<main>` fora de comentários em cada página servida. `<base>` e meta refresh são recusados (`LEGAL_PAGE_FORBIDDEN`, rodada 6).

### O Worker serve exatamente esses bytes

O Worker de vendas (`worker/sales-public-worker.mjs`, `LEGAL_ROUTES`) responde as quatro rotas jurídicas com o corpo **byte a byte** igual ao arquivo do artefato:

- sem chat do site (as rotas jurídicas não estão em `SITE_CHAT_PAGES`);
- sem troca de HTML do modo de vendas aberto;
- sem reescrita de UTM;
- sem compressão do corpo.

Só os cabeçalhos são da resposta. O teste `tests/legal-routes-artifact.test.mjs` roda o Worker real e compara os bytes de cada rota com o arquivo, com o chat ligado, vendas abertas, UTM, `Accept-Encoding: gzip` e barra final.

### Build sem segredo, deploy sem código de build (rodada 6)

Nos dois workflows de deploy, o build e o deploy estão em jobs separados.

**Vendas (`zevanory-sales-public-release.yml`)**

| Job | Segredos | O que roda | O que produz |
|---|---|---|---|
| `verify` | nenhum | as verificações de sempre (também em PR) | — |
| `worker-bundle` | nenhum (`contents: read`) | só código âncora: `scripts/ci/materialize_sales_configs.py` e o empacotador `npx --yes wrangler@4.143.0 deploy --dry-run --outdir` sobre fontes âncora (`sales-worker.mjs`, `worker/sales-public-worker.mjs`, `worker/politica-unica.mjs`, `data/politica-unica.json`, `wrangler.sales.toml`) | os pacotes prontos, as configs de release (`main` apontando para o pacote) e `MANIFEST.sha256`. O próprio job confere, sem segredo, que `--no-bundle` envia exatamente esses bytes. |
| `site-build` | nenhum (`contents: read`) | o build do repositório (`scripts/build_sales_public.py`) e a auditoria P13 | `sales-public/` e `MANIFEST.sha256` |
| `deploy` | Environment `producao-critica`; segredos **só no passo** que precisa | **nenhum código de build do repositório** (detalhes abaixo) | a publicação |

**Central (`central-production-deploy.yml`)**

| Job | Segredos | O que roda |
|---|---|---|
| `guard` | Environment `producao-critica` | o pré-guarda T1 (`promotion_guard.py`, âncora) a partir do checkout confiável. Também repassa ao build as quatro variáveis **não secretas** que o gerador do candidato usa. |
| `build` | nenhum (`contents: read`) | reconstrói o candidato (código do repositório), roda as checagens e o empacotador e confere que a config `--no-bundle` reproduz o pacote. Envia config, pacote, `public/` e o manifesto. |
| `deploy` | Environment `producao-critica`; segredos só no passo | mesmo padrão do vendas; scripts de operação âncora (`scripts/deploy/**` e os verificadores) lidos de `base/`. |

**O job `deploy`, em ordem**

1. Faz `actions/checkout` (SHA fixado) do commit do evento em `base/`, com `fetch-depth: 0` e `persist-credentials: false`. Nada do repositório rodou antes nesse job, então `remote.origin.url` e o `refs/remotes/origin/gh-pages` vêm do próprio checkout.
2. Baixa os artefatos (`actions/download-artifact` com SHA fixado).
3. Confere o hash de cada manifesto contra a saída do job que o gerou (`needs.<job>.outputs.manifest`), confere cada arquivo contra o manifesto e confere a lista exata de arquivos. Recusa `_headers`, `_redirects`, `.assetsignore`, `.env*`, `.dev.vars` e `.npmrc`.
4. Roda o **portão**, antes de qualquer passo com segredo e de novo logo antes de cada passo que publica.
5. Monta um diretório limpo (`$RUNNER_TEMP/release`), só com configs, pacotes e o site do artefato, e chama dali `npx --yes wrangler@4.143.0 deploy --no-bundle`. É o pacote pronto, sem rebuild.

**O corpo do portão no vendas**

```
set -euo pipefail
test "$(/usr/bin/git -C base rev-parse HEAD)" = "$GITHUB_SHA"
/usr/bin/git -C base show refs/remotes/origin/gh-pages:scripts/p23/legal_review.py > "$RUNNER_TEMP/legal_gate.py"
rm -rf base/sales-public && cp -a art/site/sales-public base/sales-public
/usr/bin/python3 -I "$RUNNER_TEMP/legal_gate.py" --root base --publish-gate --anchors-ref refs/remotes/origin/gh-pages
```

No central, o corpo é o mesmo, sem a cópia de `sales-public/`.

**Por que isso fecha os três caminhos da rodada 6**

- **Reescrever o Worker depois do portão.** Um build que reescreve o Worker só altera o workspace do `site-build`. O pacote vem do `worker-bundle`, que nunca roda o build. Além disso, o código que serve as rotas jurídicas e a configuração dele entram na impressão digital.
- **Trocar `remote.origin.url`.** Isso só vale no workspace do `site-build`. O portão do deploy lê do próprio checkout confiável.
- **Usar o token.** O token não existe nos jobs que rodam código de build.

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
- o que serve as rotas jurídicas em tempo de execução: `sales-worker.mjs`, `worker/sales-public-worker.mjs`, `worker/politica-unica.mjs`, `wrangler.sales.toml` e `scripts/ci/materialize_sales_configs.py`;
- tudo o que os jobs com segredo executam (rodada 6): `scripts/deploy/**`, `scripts/ci/verify-founder-and-products.sh`, `scripts/verify-production-surfaces.py`, `scripts/verify-live-headers.py`, `scripts/financial_proof_renewal.py` e `scripts/ci/credential_identity_readback.py`.

### 2. Estrutura dos workflows de deploy

O check responde `TRUST_ANCHORS=GATE_INVALID` quando a estrutura dos dois workflows de deploy no head não garante a separação e o portão. A validação roda sempre, com ou sem mudança, e exige:

- Só os jobs com segredo previstos recebem segredo (vendas: `deploy`; central: `guard` e `deploy`). Não há segredo no `env` do workflow nem no `env` de job. Os jobs de build têm `permissions: contents: read` e nada mais, e não usam o Environment.
- Todo `uses:` é fixado por SHA. No job `deploy`, só `actions/checkout` (`path: base`, `ref: ${{ github.sha }}`, `persist-credentials: false`) e `actions/download-artifact`.
- Os jobs com segredo, e o `worker-bundle`, só executam arquivos do repositório que são âncora, e nunca código de `worker/`.
- No job `deploy`:
  - `npx` só serve para `npx --yes wrangler@4.143.0`, e só a partir de `$RUNNER_TEMP/release`;
  - `npm` só serve para instalar o `playwright@1.55.0` fixado em `$RUNNER_TEMP/pw`;
  - todo `deploy` usa `--no-bundle`;
  - não há `--dry-run` nem `--outdir`;
  - não há scripts de build.
- O manifesto é conferido antes do portão.
- O portão (o corpo acima) roda antes de qualquer passo com segredo e logo antes de cada passo que publica, sem `if`, `continue-on-error`, `shell` ou `env`.
- Passo que publica não usa `always()`, `failure()` ou `cancelled()`, nem o job `deploy`. Nenhum outro job publica.
- Não há `defaults` nem `BASH_ENV`, `PATH`, `PYTHON*` ou `GIT_*` no `env`. O YAML é válido.

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

- **Só uma conta.** Toda proteção pode ser contornada pelo proprietário. O objetivo é que nenhuma aprovação, e nenhuma mudança no que roda com segredo, entre **sem** uma decisão explícita dele.
- **Pacote e código do Worker central.** O pacote do Worker central é gerado por código do repositório que não é âncora (`worker/*.mjs` e os geradores do candidato rodam no build, sem segredo). Por desenho, um PR comum que muda o Worker central publica essa mudança no próximo deploy, e é isso que a revisão de código cobre. O central não serve as páginas jurídicas (o apex redireciona para `vendas`). Os textos de consumo dele (`data/politica-unica.json`) são âncora e entram na impressão digital.
- **Dependências externas fixadas por versão.** `wrangler@4.143.0` e `playwright@1.55.0` vêm do registro npm, fixados por versão, não por hash. Eles rodam a partir de diretórios limpos e não são dependências do repositório.

## Decisão do proprietário (L-3)

Enquanto `legal_review` estiver PENDING e o artefato jurídico for diferente do publicado, **todo** deploy desses dois fluxos fica parado no portão, inclusive deploys sem relação com o texto jurídico. A partir da rodada 5, isso inclui qualquer mudança de byte no CSS, nas fontes ou nas imagens que as páginas jurídicas usam.

O GitHub Pages publica só os stubs de redirecionamento de `pages-mirror/`, então não publica texto jurídico.
