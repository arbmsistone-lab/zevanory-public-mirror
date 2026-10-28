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
| `worker-bundle` | nenhum (`contents: read`) | só `scripts/deploy/clean_bundle.py sales` (âncora), logo depois do checkout: empacotamento limpo (ver abaixo, rodada 7) | os pacotes prontos, as configs de release (`main` apontando para o pacote) e `MANIFEST.sha256`. O próprio script confere, sem segredo, que `--no-bundle` envia exatamente esses bytes. |
| `site-build` | nenhum (`contents: read`) | o build do repositório (`scripts/build_sales_public.py`) e a auditoria P13 | `sales-public/` e `MANIFEST.sha256` |
| `deploy` | Environment `producao-critica`; segredos **só no passo** que precisa | **nenhum código de build do repositório** (detalhes abaixo) | a publicação |

**Central (`central-production-deploy.yml`)**

| Job | Segredos | O que roda |
|---|---|---|
| `guard` | Environment `producao-critica` | o pré-guarda T1 (`promotion_guard.py`, âncora) a partir do checkout confiável. Também repassa ao build as quatro variáveis **não secretas** que o gerador do candidato usa. |
| `build` | nenhum (`contents: read`) | **primeiro** `scripts/deploy/clean_bundle.py central` (empacotamento limpo, rodada 7) e o upload do artefato (config, pacote, `public/`, manifesto); **depois** as checagens e os testes do repositório, que não alcançam mais o artefato. |
| `deploy` | Environment `producao-critica`; segredos só no passo | mesmo padrão do vendas; scripts de operação âncora (`scripts/deploy/**` e os verificadores) lidos de `base/`. |

**O job `deploy`, em ordem**

1. Faz `actions/checkout` (SHA fixado) do commit do evento em `base/`, com `fetch-depth: 0` e `persist-credentials: false`. Nada do repositório rodou antes nesse job, então `remote.origin.url` e o `refs/remotes/origin/gh-pages` vêm do próprio checkout.
2. Baixa os artefatos (`actions/download-artifact` com SHA fixado).
3. Confere o hash de cada manifesto contra a saída do job que o gerou (`needs.<job>.outputs.manifest`), confere cada arquivo contra o manifesto e confere a lista exata de arquivos. Recusa `_headers`, `_redirects`, `.assetsignore`, `.env*`, `.dev.vars` e `.npmrc`.
4. **Reconstrói** o release (rodada 7): lê `scripts/deploy/clean_bundle.py` do gh-pages (`git show`, como o portão), refaz o empacotamento limpo a partir do objeto do commit em `base/` e compara **byte a byte** com o artefato baixado (`--verify`). Qualquer diferença (arquivo a mais, a menos ou um byte trocado) dá `CLEAN_BUNDLE_REPRODUCED=MISMATCH` e o job para antes de qualquer segredo.
5. Roda o **portão**, antes de qualquer passo com segredo e de novo logo antes de cada passo que publica.
6. Monta um diretório limpo (`$RUNNER_TEMP/release`), só com configs, pacotes e o site do artefato, e chama dali `npx --yes wrangler@4.143.0 deploy --no-bundle`. É o pacote pronto, sem rebuild. O `npx` resolve para a instalação fixada por integridade em `$RUNNER_TEMP` (o `clean_bundle.py` confere isso offline), com `npm_config_userconfig=/dev/null` e `npm_config_registry=https://registry.npmjs.org` no `env` do job.

**Empacotamento limpo (`scripts/deploy/clean_bundle.py`, rodada 7)**

1. A árvore do commit não pode ter `.npmrc`, `.yarnrc*`, `package.json`, `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `.pnpmfile.cjs`, `bunfig.toml` nem nada em `node_modules/`, em pasta nenhuma (a única exceção é o par fixado em `scripts/deploy/wrangler-pin/`). Se tiver, `CLEAN_BUNDLE=REFUSED` e nada roda.
2. As fontes saem do commit com `git archive <sha> -- <lista>` para um diretório novo (nunca a árvore de trabalho que testes ou o build podem ter mexido):
   - vendas: só as âncoras que formam o Worker (`sales-worker.mjs`, `worker/sales-public-worker.mjs`, `worker/politica-unica.mjs`, `data/politica-unica.json`, `wrangler.sales.toml`, `scripts/ci/materialize_sales_configs.py`);
   - central: as entradas do candidato (`worker/`, `data/`, `scripts/deploy/`, `admin.css`, `assets/brand/`, `sales-public/brand/`) e o `public/` do commit congelado `83620c68`. Os geradores que rodam são os `scripts/deploy/*` (âncora). Nenhum código de `worker/` é executado: o arquivo do painel de controle usado é o commitado, e o `build` prova que o gerador o reproduz (`git diff --exit-code`).
3. O empacotador é o `wrangler 4.143.0` instalado com `npm ci --ignore-scripts` a partir de `scripts/deploy/wrangler-pin/package-lock.json` (âncora; cada pacote com integridade sha512 e origem `registry.npmjs.org`), lido do commit, instalado em `$RUNNER_TEMP` (fora do checkout), com `npm_config_userconfig=/dev/null`, configuração global vazia e `--registry=https://registry.npmjs.org`. O wrangler roda pelo caminho absoluto, com ambiente mínimo.
4. O mesmo script, com as mesmas entradas, roda no `build` (gera o artefato) e no `deploy` (reconstrói e compara). A saída do wrangler não depende do caminho do diretório (conferido: duas execuções em diretórios diferentes dão os mesmos bytes).

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

**Por que isso fecha os dois caminhos da rodada 7 (M-1)**

- **Teste que reescreve a fonte do Worker antes do empacotamento.** O empacotamento lê o objeto do commit, não a árvore de trabalho, e roda antes de qualquer teste; o artefato sobe antes dos testes. Mesmo que algo altere o artefato, o `deploy` reconstrói a partir do próprio checkout e recusa a diferença.
- **`node_modules/.bin/wrangler` commitado ou `.npmrc` do repositório.** O wrangler roda de fora do checkout, de uma instalação fixada por integridade, com registro explícito e sem configuração do usuário; um commit com esses arquivos é recusado pelo empacotamento e, no PR, pelo check protegido (âncoras).

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
- tudo o que os jobs com segredo executam (rodada 6): `scripts/deploy/**` (inclui `clean_bundle.py` e o lockfile fixado `scripts/deploy/wrangler-pin/`), `scripts/ci/verify-founder-and-products.sh`, `scripts/verify-production-surfaces.py`, `scripts/verify-live-headers.py`, `scripts/financial_proof_renewal.py` e `scripts/ci/credential_identity_readback.py`;
- rodada 7 (M-1c), em **qualquer pasta**: `.npmrc`, `.yarnrc*`, `package.json`, `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.pnpmfile.cjs`, `bunfig.toml`, `bun.lockb`, qualquer coisa em `node_modules/` ou `.yarn/`, e toda configuração `wrangler*.toml`, `wrangler*.json` e `wrangler*.jsonc`.

### 2. Estrutura dos workflows de deploy

O check responde `TRUST_ANCHORS=GATE_INVALID` quando a estrutura dos dois workflows de deploy no head não garante a separação e o portão. A validação roda sempre, com ou sem mudança, e exige:

- Só os jobs com segredo previstos recebem segredo (vendas: `deploy`; central: `guard` e `deploy`). Não há segredo no `env` do workflow nem no `env` de job. Os jobs de build têm `permissions: contents: read` e nada mais, e não usam o Environment.
- Todo `uses:` é fixado por SHA. No job `deploy`, só `actions/checkout` (`path: base`, `ref: ${{ github.sha }}`, `persist-credentials: false`), `actions/download-artifact` e `actions/setup-node` (rodada 7, para a reconstrução).
- Rodada 7: no job que gera o artefato do Worker (`worker-bundle` / `build`), o primeiro passo `run` é exatamente o `clean_bundle.py`, antes dele só `checkout` e `setup-node`, e logo depois vem o `upload-artifact`. No `deploy`, o passo de reconstrução (corpo exato, `clean_bundle.py` lido do gh-pages, `--verify` contra o artefato) vem depois do manifesto e antes do primeiro portão e de qualquer segredo, e o `env` do job tem `npm_config_userconfig: /dev/null` e `npm_config_registry: https://registry.npmjs.org`.
- Os jobs com segredo, e o `worker-bundle`, só executam arquivos do repositório que são âncora, e nunca código de `worker/`.
- No job `deploy`:
  - `npx` só serve para `npx --yes wrangler@4.143.0`, e só a partir de `$RUNNER_TEMP/release`;
  - `npm` só serve para instalar o `playwright@1.55.0` fixado em `$RUNNER_TEMP/pw`;
  - todo `deploy` usa `--no-bundle`;
  - não há `--dry-run` nem `--outdir` no texto do workflow (a reconstrução usa o wrangler dentro do `clean_bundle.py`, âncora lida do gh-pages);
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

## Execução manual e primeiro deploy seguro (rodada 7, L-1)

Os dois workflows têm a entrada `mode` no `workflow_dispatch`:

| `mode` | Vendas | Central | Onde |
|---|---|---|---|
| `dry-run` (padrão) | builds, manifestos, reconstrução limpa comparada byte a byte, diretório de release, `--no-bundle --dry-run` com o wrangler fixado (offline) e o portão. **Nada é publicado.** | igual (o `guard` não roda) | job `rehearsal`: sem Environment e sem segredo; qualquer branch; código do commit disparado, âncoras do gh-pages |
| `candidate` | publica **só** o candidato isolado `zevanory-sales-candidate-<run id>` em workers.dev, faz o smoke e o apaga. Sem promoção, sem tocar o domínio canônico. | (não existe: o central não tem candidato isolado) | job `deploy` (Environment `producao-critica`), só no gh-pages |
| `production` | o release completo, igual a um push no gh-pages | o deploy completo, igual a um push | job `deploy`, só no gh-pages |

Um push no gh-pages é sempre `production`.

Antes do merge, o `dry-run` no branch do PR **não precisa de exceção** no Environment, porque o job `rehearsal` não usa o `producao-critica`. O resultado esperado hoje é: tudo verde até o portão, e o portão em `BLOCKED` enquanto a revisão jurídica estiver PENDING (o texto da Release 2 difere da linha de base). Isso é o portão funcionando.

## Rollback manual por Worker

Pré-requisitos: `CLOUDFLARE_API_TOKEN` do proprietário no ambiente local (nunca colado em log), `CLOUDFLARE_ACCOUNT_ID=1b26415802588185a86c1d4d3ebf5bdb`, e rodar os comandos `wrangler` fora de qualquer checkout (`cd "$(mktemp -d)"`), para nenhum `.npmrc` ou `node_modules` local interferir. Os comandos usam a mesma versão do wrangler dos workflows.

**Vendas (`zevanory-sales-public`, domínio `vendas.zevanory.api.br`)**

```
npx --yes wrangler@4.143.0 deployments list --name zevanory-sales-public
npx --yes wrangler@4.143.0 rollback <VERSION_ID_ANTERIOR> --name zevanory-sales-public --message "rollback manual: <motivo>" --yes
curl -fsS https://vendas.zevanory.api.br/health        # "release" tem de ser o SHA da versão restaurada
curl -fsS https://vendas.zevanory.api.br/termos | grep -F 'inscrita no CNPJ sob o nº 69.077.233/0001-99'
```

Se sobrar um candidato de um run interrompido (`zevanory-sales-candidate-<run id>`, nunca o canônico):

```
npx --yes wrangler@4.143.0 delete --name zevanory-sales-candidate-<RUN_ID>
```

**Central (`zevanory`, domínio `zevanory.api.br`)**

```
npx --yes wrangler@4.143.0 deployments list --name zevanory
npx --yes wrangler@4.143.0 rollback <VERSION_ID_ANTERIOR> --name zevanory --message "rollback manual: <motivo>" --yes
curl -fsS https://zevanory.api.br/api/release          # deployment.commit_sha tem de ser o da versão restaurada
curl -fsS https://zevanory.api.br/api/health -o /tmp/rollback-health.json
# num checkout limpo do gh-pages:
python3 -I scripts/deploy/verify-rollback-health.py /tmp/rollback-health.json
```

O rollback restaura código e configuração da versão escolhida; não mexe em segredos, KV ou banco. Depois de um rollback manual do central, a renovação da prova financeira não roda sozinha (o workflow só renova depois de um rollback automático saudável): disparar `order12a-financial-proof-renewal.yml` no gh-pages se a saúde estiver ok.

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
- **Dependências externas.** Rodada 7: o `wrangler 4.143.0` vem do lockfile âncora `scripts/deploy/wrangler-pin/package-lock.json` (integridade sha512 de cada pacote, `npm ci`). O `playwright@1.55.0` do smoke do Mercado Pago continua fixado só por versão (roda depois do deploy, num diretório limpo, e não entra no pacote). Os jobs `verify` (vendas) e as checagens do `build` (central) ainda rodam `npx --yes wrangler@4.143.0 --dry-run` no checkout; a saída deles não vai para produção (é só checagem, sem segredo).
- **Central: fontes do pacote.** O pacote do central sai do objeto do commit, mas `worker/*.mjs` não é âncora: um PR comum que muda o Worker central continua publicando essa mudança, coberto pela revisão de código (ver acima).

## Decisão do proprietário (L-3)

Enquanto `legal_review` estiver PENDING e o artefato jurídico for diferente do publicado, **todo** deploy desses dois fluxos fica parado no portão, inclusive deploys sem relação com o texto jurídico. A partir da rodada 5, isso inclui qualquer mudança de byte no CSS, nas fontes ou nas imagens que as páginas jurídicas usam.

O GitHub Pages publica só os stubs de redirecionamento de `pages-mirror/`, então não publica texto jurídico.
