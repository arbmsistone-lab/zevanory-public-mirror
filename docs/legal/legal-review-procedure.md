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
| `deploy` | Environment `producao-critica`; segredos só no passo | mesmo padrão do vendas, mas só com o **portão mínimo dos textos de consumo** (`--consumer-gate`, rodada 12): bloqueia só se os textos de consumo de `data/politica-unica.json` mudaram sem aprovação; scripts de operação âncora (`scripts/deploy/**` e os verificadores) lidos de `base/`. |

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

No central, o corpo é o mesmo com `--consumer-gate` no lugar de `--publish-gate`, sem a cópia de `sales-public/` (rodada 12). O validador reprova `--publish-gate` ou `--apply-snapshot` no workflow do central.

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
| `emergency` | como `production`, mas aceita código que serve as rotas jurídicas não aprovado, **só** se as páginas jurídicas, os assets e os textos de consumo servidos forem um snapshot aprovado. Só o dono do repositório, com `reason` de 20+ caracteres; registro no resumo do run, anotação `::warning` e artefato `emergency-audit-<run>` (90 dias). | (não existe: o central nunca é bloqueado) | job `deploy` (+ `emergency-audit`), só no gh-pages |

Um push no gh-pages é sempre `production`.

O `dry-run` do central confere o **código** e o pipeline de build, não a configuração de produção. As quatro variáveis de lançamento (`ZEVANORY_LAUNCH_AUTHORIZATION`, `MERCADOPAGO_PRODUCTION_ACCOUNT_HASH16`, `MERCADOPAGO_PRODUCTION_WEBHOOK_VERIFIED`, `OPERATOR_TOKEN_MIGRATION_UNTIL`) ficam no Environment `producao-critica`, que o ensaio não lê. Por isso a config ensaiada sai com elas vazias (configuração de lançamento dormente), e a de produção pode diferir só nesses `vars`, nunca no pacote do Worker. (Rodada 8, LOW-3.)

Antes do merge, o `dry-run` no branch do PR **não precisa de exceção** no Environment, porque o job `rehearsal` não usa o `producao-critica`. O resultado esperado hoje é: tudo verde até o portão, e o portão em `BLOCKED` enquanto a revisão jurídica estiver PENDING (o texto da Release 2 difere da linha de base). Isso é o portão funcionando.

No ensaio, o portão roda com `--rehearsal` (só no job `rehearsal`; o validador exige o corpo exato, sem a flag, no `deploy`). Quando o commit despachado ainda não está no gh-pages, o portão continua recusando (`LEGAL_PUBLISH_GATE=BLOCKED`), mas antes imprime o que a impressão digital daria contra as âncoras do gh-pages: `LEGAL_REHEARSAL_BASELINE` (com a origem; antes do merge da Release 2, o gh-pages ainda não tem a linha de base e vale a do commit), cada `LEGAL_REHEARSAL_CHANGED=<arquivo>` e `LEGAL_REHEARSAL_VERDICT=PASS_UNCHANGED|PASS_APPROVED|BLOCKED`. Em produção nada muda.

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

1. Um PR muda o texto. Depois do merge, o deploy de vendas serve o último texto aprovado (snapshot) e lista o texto novo em `LEGAL_PENDING`; se o código que serve ou os textos de consumo também mudaram, só o deploy de vendas fica bloqueado. O central segue.
2. Num PR separado, o proprietário cadastra o revisor: profissional (nome, OAB, `github_login`, `authorized_by: "proprietario"`, `authorized_at`) ou interno (`type: "internal_owner"`, sem OAB). O PR mexe numa âncora, então o merge é por decisão deliberada. O merge gera o commit S.
3. Num PR seguinte, também por decisão deliberada:
   - a entrada do revisor recebe `authorization_commit = S`;
   - `legal_review` fica APPROVED (profissional) ou APPROVED_INTERNAL com `type: "internal_owner"` e o `disclaimer` (interna; o registro traz o checklist P23 e a auditoria), com `reviewed_sha256` (`legal_review.py --fingerprint`), `reviewed_commit` (o commit do gh-pages com o artefato revisado) e `document_version`;
   - entra o registro `docs/legal/reviews/<sha256>.json`.
4. O deploy seguinte passa com `PASS_APPROVED`. Depois de publicar, a linha de base pode passar a ser esse `reviewed_sha256`.

## Limites que continuam

- **Só uma conta.** Toda proteção pode ser contornada pelo proprietário. O objetivo é que nenhuma aprovação, e nenhuma mudança no que roda com segredo, entre **sem** uma decisão explícita dele.
- **Pacote e código do Worker central.** O pacote do Worker central é gerado por código do repositório que não é âncora (`worker/*.mjs`; os geradores do candidato são âncora). Por desenho, um PR comum que muda o Worker central publica essa mudança no próximo deploy, e é isso que a revisão de código cobre. Correção (rodada 12): o apex **serve** `/termos`, `/privacidade`, `/reembolso` e `/afiliados`, a partir do `public/` **congelado** do commit `83620c68` (bytes imutáveis), transformado só pelo `scripts/deploy/prepare-central-candidate.py` (âncora). Nenhum texto jurídico novo chega ao apex por um PR comum; por isso o central não passa pelo portão (Sol ORDEM 312). Os textos de consumo (`data/politica-unica.json`) são âncora.
- **Dependências externas.** Rodada 7: o `wrangler 4.143.0` vem do lockfile âncora `scripts/deploy/wrangler-pin/package-lock.json` (integridade sha512 de cada pacote, `npm ci`). O `playwright@1.55.0` do smoke do Mercado Pago continua fixado só por versão (roda depois do deploy, num diretório limpo, e não entra no pacote). Os jobs `verify` (vendas) e as checagens do `build` (central) ainda rodam `npx --yes wrangler@4.143.0 --dry-run` no checkout; a saída deles não vai para produção (é só checagem, sem segredo).
- **Central: fontes do pacote.** O pacote do central sai do objeto do commit, mas `worker/*.mjs` não é âncora: um PR comum que muda o Worker central continua publicando essa mudança, coberto pela revisão de código (ver acima).

## Decisão do proprietário (L-3), substituída pela Sol ORDEM 312

Até a rodada 11, enquanto `legal_review` estivesse PENDING e o artefato jurídico fosse diferente do publicado, **todo** deploy dos dois fluxos ficava parado no portão. A Sol ORDEM 312 exige que "nenhum texto jurídico novo seja publicado sem aprovação documentada" **e** que "nenhuma correção operacional urgente fique indefinidamente bloqueada apenas porque uma revisão jurídica externa ainda não foi contratada". O desenho abaixo atende as duas.

## Dois níveis de aprovação (Sol ORDEM 312)

| Nível | `legal_review.status` / `type` | Quem | O que o registro exige | Como o portão imprime |
|---|---|---|---|---|
| **PROFESSIONAL** | `APPROVED` / ausente ou `professional` | advogado(a) com registro na OAB, cadastrado(a) pelo proprietário (`registro: OAB/UF número`) | o fluxo de sempre (registro em `docs/legal/reviews/<sha256>.json`, `decision: "APPROVED"`) | `LEGAL_APPROVAL_LEVEL=PROFESSIONAL (revisão de advogado(a) com registro na OAB)` |
| **INTERNAL_OWNER** | `APPROVED_INTERNAL` / `internal_owner` | o proprietário, cadastrado como revisor interno (`type: "internal_owner"`, **sem** OAB) | `decision: "APPROVED_INTERNAL"`, `type: "internal_owner"`, `disclaimer` exato; `checklist` com **todos** os itens de `data/p23/ecommerce-legal-checklist.json` respondidos `conforme` ou `nao_aplicavel`, cada um com evidência; `audit_report` com `ref` = arquivo versionado em `docs/legal/audits/` (URL externa recusada) que entrou no gh-pages num commit **anterior** ao do registro e declara escopo e SHA (40 hex) auditado, `sha256` conferido, `auditor` independente (comparado normalizado, sem diferenciar maiúsculas e acentos, com quem aprova e com todo revisor cadastrado) e `auditor_kind` (`independent_ai_auditor` ou `human`) | `LEGAL_APPROVAL_LEVEL=INTERNAL_OWNER (Aprovação interna do proprietário: controle temporário; não constitui parecer jurídico. ...)` |

O `disclaimer` obrigatório da aprovação interna é exatamente: "Aprovação interna do proprietário: controle temporário; não constitui parecer jurídico." Fora dele, nenhum campo da aprovação interna pode falar em "parecer" ou "opinião jurídica" (reprova). A aprovação interna não pode citar OAB.

**Sobre o `auditor_kind`, com honestidade.** `independent_ai_auditor` quer dizer que a auditoria foi feita por uma execução de IA separada de quem preparou o PR (por exemplo, as reauditorias independentes deste PR). É uma checagem técnica independente do texto e do código, não uma pessoa e não um parecer. `human` quer dizer um auditor humano identificado por nome e sobrenome.

**Revogação (rodada 12).** O proprietário revoga uma aprovação acrescentando a impressão digital em `data/p23/legal-revoked.json` (âncora; `sha256`, `revoked_at`, `reason`). Um texto revogado não passa no portão, não é servido como snapshot e não vale como linha de base.

**A aprovação interna é um controle temporário.** Ela documenta a decisão do proprietário, com o checklist P23 e uma auditoria independente, mas não substitui a análise de um profissional. Recomenda-se uma revisão profissional (OAB) antes ou logo depois da primeira venda, conforme a Sol.

As mesmas duas etapas valem para os dois níveis: o cadastro do revisor (profissional ou interno) entra num PR; a aprovação, que cita `authorization_commit`, entra num PR seguinte. Cadastro e aprovação no mesmo commit reprovam.

## Sem congelamento: o snapshot jurídico aprovado (Sol ORDEM 312)

O deploy de vendas passa a seguir quando o texto jurídico do commit ainda não foi aprovado, servindo o **último texto aprovado**:

1. No job `deploy`, depois da reconstrução comparada e antes do primeiro portão, o passo "Serve the last approved legal snapshot..." roda `legal_review.py --apply-snapshot art/site/sales-public` (código do gh-pages). Se o texto do commit está aprovado, nada muda. Se não está, as páginas jurídicas e os assets delas são trocados pelos bytes do último texto aprovado, reproduzidos do commit de origem (a gênese é `b7671272`; a6068e6a, publicado hoje, tem os mesmos bytes). Um asset compartilhado com bytes diferentes recusa.
2. O portão confere o que vai ao ar: passa só se o conjunto servido (páginas jurídicas e assets do artefato, o código que as serve e os textos de consumo de `data/politica-unica.json`) for **igual** ao de um texto aprovado e reproduzível (linha de base ou registro de aprovação válido). Imprime `LEGAL_SERVED=APPROVED_HEAD <fp>` (o texto do commit) ou `LEGAL_SERVED=APPROVED_SNAPSHOT <fp>`, o nível da aprovação e `LEGAL_PENDING=<itens do commit que aguardam aprovação e não vão ao ar>`.
3. Texto jurídico não aprovado nunca vai ao ar. Um snapshot que não se reproduz (impressão digital recalculada no commit de origem diferente da declarada) recusa.

**Prova técnica.** `tests/legal-routes-artifact.test.mjs` (LR4) troca as páginas do diretório servido pelo snapshot e roda o Worker de vendas REAL: as quatro rotas jurídicas devolvem exatamente os bytes do snapshot, com chat ligado, vendas abertas, UTM, barra final e gzip. As rotas jurídicas são servidas do `ASSETS` sem nenhuma injeção (LR1 a LR3).

**Escolha de segurança e o custo dela.** Se o **código que serve** as rotas jurídicas (`sales-worker.mjs`, `worker/sales-public-worker.mjs`, `worker/politica-unica.mjs`, `wrangler.sales.toml`) ou os **textos de consumo** de `data/politica-unica.json` mudaram sem aprovação, o snapshot não resolve. Esses arquivos vão no pacote do Worker, e trocar o Worker inteiro por uma versão antiga desfaria outras correções.
- Nesse caso, só o deploy do Worker de vendas fica bloqueado (`LEGAL_SERVING_UNAPPROVED` ou `LEGAL_UNAPPROVED_TEXT_SERVED`), com a lista do que está pendente.
- O central não é bloqueado por página jurídica nem pelo código de vendas; ele só confere os textos de consumo (ver abaixo). O site de vendas e o Worker de vendas são publicados juntos, num único deploy com os assets, então "o site" segue o Worker.
- O custo é que uma mudança no código que serve exige aprovação (interna serve) ou o modo emergência. O ganho é que nenhum código não aprovado decide o que as rotas jurídicas mostram sem uma decisão registrada.

**Rotas jurídicas fora de vendas (rodada 12, MED-1; corrige a rodada anterior).** A afirmação "o apex serve as páginas congeladas" estava errada.
- No apex, `/termos*`, `/privacidade*`, `/reembolso*` e `/afiliados*` são do Worker `zevanory-public-router`.
- Nos outros hosts do central (`edge.`, `backup.`, workers.dev), o roteamento era do código não âncora do central.

Agora todo host que não é vendas responde a essas rotas, em qualquer variante (`.html`, `/index.html`, barra final, maiúsculas, query), com **308 para a mesma rota em `vendas.zevanory.api.br`**, sem corpo próprio. O texto jurídico só existe onde o portão por bytes e o snapshot valem.
- O desvio está no módulo âncora `worker/legal-routes-redirect.mjs`.
- O roteador público (`worker/public-surface-router.mjs`) é âncora inteiro. O workflow dele também é, como todo workflow.
- No central, a **primeira instrução** de `wrapped.fetch` no ponto de entrada (`worker/cloudflare-worker.compat.mjs`) é a chamada ao módulo. O check protegido reprova um head em que ela suma ou deixe de ser a primeira.
- Prova: `tests/legal-routes-hosts.test.mjs` roda o roteador e o ponto de entrada **real** do central, em quatro hosts e seis variantes por rota.
- O roteador não precisa de portão próprio: ele não produz texto jurídico (só redireciona), e mudar isso exige mudar uma âncora.

**O central: portão mínimo dos textos de consumo (rodada 12, MED-3a, opção mais segura, sujeita ao aceite da Sol).** O Worker central serve textos de consumo que vêm de `data/politica-unica.json`: a regra dos 7 dias e as respostas de reembolso e de suporte. Antes de qualquer segredo e logo antes do deploy, o central roda `legal_review.py --consumer-gate` (código do gh-pages).
- Ele passa se esses campos forem os de um texto aprovado: o texto do commit, aprovado, ou um snapshot aprovado e reproduzível.
- Se não forem, bloqueia **só** o central, com `LEGAL_CONSUMER_PENDING=<campos>`.
- Páginas jurídicas e código de vendas não bloqueiam o central.

**Este PR depois do merge (rodada 12, MED-3b).** Em relação à gênese, o PR muda as páginas jurídicas, o código que serve e os textos de consumo. Por isso, **depois do merge, o deploy de vendas e o deploy central ficam bloqueados** até o proprietário registrar uma aprovação, profissional ou interna. A produção fica como está. Com o kit abaixo, a aprovação interna leva minutos.

## Aprovação interna da Release 2: procedimento exato em dois PRs (rodada 12, MED-3b)

Pré-requisitos:
- o merge do #946;
- `git fetch origin gh-pages`;
- o relatório da auditoria independente em Markdown, com uma linha "Escopo" e o SHA (40 hex) auditado.

**PR 1, cadastro e auditoria (o merge cria o `authorization_commit`):**

```
python3 -I scripts/p23/internal_approval.py register --name "<nome e sobrenome do proprietário>" --github-login arbmsistone-lab --audit-report <relatorio.md>
git add data/p23/legal-reviewers.json docs/legal/audits/<relatorio.md>
```

Abra o PR. Ele mexe em âncoras, então o merge é deliberado, por squash.

**PR 2, aprovação:**

1. Copie `docs/legal/internal-approval/checklist-p23.json` e preencha **cada** item com `answer` (`conforme` ou `nao_aplicavel`) e `evidence` (onde conferiu). As respostas são do proprietário; o modelo vem em branco.
2. Gere a aprovação:
   ```
   python3 -I scripts/p23/internal_approval.py approve --checklist <checklist preenchido.json> --audit-report docs/legal/audits/<relatorio.md> --auditor "<quem auditou>" --auditor-kind independent_ai_auditor
   ```
   O script grava `legal_review` (`APPROVED_INTERNAL`) em `data/politica-unica.json`, o `authorization_commit` no cadastro e o registro `docs/legal/reviews/<sha256>.json`. Antes de terminar, ele roda a mesma validação do portão e responde `INTERNAL_APPROVAL_PR2=READY` ou `INVALID`.
3. Faça o commit dos três arquivos num PR, merge deliberado por squash.

Depois do merge do PR 2:
- o deploy de vendas passa com `LEGAL_APPROVAL_LEVEL=INTERNAL_OWNER (... não constitui parecer jurídico ...)`;
- o central passa no portão de consumo.

O G23 roda esse fluxo de ponta a ponta numa fixture.

## Modo emergência (Sol ORDEM 312, item 3)

- `workflow_dispatch` com `mode: emergency` e `reason` de pelo menos 20 caracteres, **só** no gh-pages e **só** pelo dono do repositório.
- O próprio portão confere, a partir do evento gravado pelo GitHub no runner: modo, motivo, autor = dono e ref. O passo "Emergency mode record" também confere e grava o registro no resumo do run.
- O job `emergency-audit` guarda `record.json` (autor, motivo, commit, run) por 90 dias.
- O dono é conferido por `github.triggering_actor` (`GITHUB_TRIGGERING_ACTOR`), que num re-run é quem dispara agora, e não quem disparou a primeira vez.
- Ele passa um Worker de vendas cujo código que serve não está aprovado **somente** se os arquivos das páginas jurídicas, os assets e os textos de consumo servidos forem exatamente os de um snapshot aprovado (`LEGAL_SERVED=EMERGENCY_SNAPSHOT`, anotação `::warning`). Com texto de consumo alterado, recusa.
- **Limite, dito com honestidade (rodada 12, LOW-1):** o código que serve, não aprovado, poderia em tese alterar em tempo de execução o que as rotas jurídicas devolvem, como no ataque W1 da rodada 5. A emergência é uma **sobreposição auditada do proprietário** (dono, motivo, registro de 90 dias), não um caminho aberto a um PR comum (o código que serve é âncora).
- Não existe outro desvio.

## Implantação inicial do check protegido (bootstrap)

O `pull_request_target` roda a definição da **base**, então o check `legal-trust-anchors-protected` não protege o PR que o introduz (#946). A sequência inicial é:

1. Merge do #946 por squash, por decisão deliberada do proprietário.
2. Conferir que `.github/workflows/legal-trust-anchors-protected.yml` está no gh-pages.
3. O proprietário torna `protected-trust-anchors` um check obrigatório do gh-pages (Settings → Branches).
4. O proprietário deixa só o merge por squash (desliga rebase e merge commit).
5. Conferência somente leitura: `python3 -I scripts/ops/verify_required_checks.py`. Deve imprimir `PROTECTED_CHECK_WORKFLOW=PRESENT`, `REQUIRED_CHECK=PRESENT`, `SQUASH_ONLY=YES` e `BOOTSTRAP=COMPLETE` (rc 0). O script só faz `GET` na API REST (`gh api`). Hoje, antes do merge, ele imprime `BOOTSTRAP=INCOMPLETE`: o check não existe no gh-pages, os obrigatórios são só `product-pages / static-audit` e `zees16-evidence / fail-closed`, e rebase e merge commit estão ligados.

O GitHub Pages publica só os stubs de redirecionamento de `pages-mirror/`, então não publica texto jurídico.
