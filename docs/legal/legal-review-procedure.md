# Revisão jurídica dos textos de consumo: procedimento e âncoras de confiança

Este documento atende M1 e M-A da reauditoria do PR #946. Ele explica como funciona o portão que impede publicar texto jurídico de consumo sem aprovação.

## O que o portão confere

O script é `scripts/p23/legal_review.py`. No deploy, ele roda com:

```
--publish-gate --anchors-ref refs/remotes/origin/gh-pages
```

Ele roda em dois jobs de deploy, antes de qualquer chamada à Cloudflare:

- `zevanory-sales-public-release.yml`;
- `central-production-deploy.yml`.

O portão separa duas coisas:

- **O texto a publicar.** É a árvore em deploy. A impressão digital é o SHA-256 do texto visível de `/termos` e `/reembolso`, nas duas superfícies, mais os textos de consumo de `data/politica-unica.json`, incluindo `legal_document_version`.
- **As âncoras de confiança.** Elas são lidas do **gh-pages já mesclado**, com `git show`, e nunca da árvore em publicação:
  - o cadastro `data/p23/legal-reviewers.json`;
  - a linha de base `data/p23/legal-published-baseline.json`;
  - os registros `docs/legal/reviews/<sha256>.json`;
  - o bloco `legal_review`.

O portão também confere o histórico do git:

1. O commit em deploy tem de estar contido no gh-pages.
2. `authorization_commit` tem de ser o commit do gh-pages que **introduziu** a entrada daquele revisor no cadastro. Com merge por squash, o cadastro entra num PR, e a aprovação só pode citá-lo num PR seguinte.
3. O registro `docs/legal/reviews/<sha256>.json` tem de entrar no gh-pages num commit **posterior** ao `authorization_commit`, nunca antes nem no mesmo commit.
4. `reviewed_commit` tem de ser um commit do gh-pages. A impressão digital do texto **nesse commit** é recalculada e tem de ser igual a `reviewed_sha256`.
5. A linha de base só vale em dois casos: se for o texto publicado antes da Release 2 (`GENESIS_BASELINE`, de `b7671272`), ou se for o `reviewed_sha256` de um registro de aprovação válido já no gh-pages. Escrever um valor no arquivo não basta.
6. `approved_at` não pode estar no futuro. Uma data sem hora vale no máximo até hoje (UTC). Uma data com hora tolera até 5 minutos de diferença de relógio.

Com o texto igual à linha de base validada, o portão responde `PASS_UNCHANGED`. Com texto novo, ele exige uma aprovação válida para essa impressão digital. Sem ela, responde `BLOCKED` e o deploy para antes de tocar a produção. Nada que está no ar é retirado.

## Check protegido antes do merge

O check é `.github/workflows/legal-trust-anchors-protected.yml`. Ele roda em `pull_request_target`, com o código da base; o PR é lido só como dado, no mesmo padrão de `secret-scan-contract-protected` (#950). O check **reprova** todo PR que altere qualquer um destes arquivos:

- `data/p23/legal-reviewers.json`
- `data/p23/legal-published-baseline.json`
- `docs/legal/reviews/**`
- `data/politica-unica.json`
- `scripts/p23/**`
- o próprio workflow

Se o PR mudar a linha de base, o check também informa se o novo valor corresponde a um registro de aprovação válido **na base**.

O check também reprova (`TRUST_ANCHORS=GATE_REMOVED`) o PR que altere um dos dois workflows de deploy e deixe de chamar, fora de comentário, `python3 -I scripts/p23/legal_review.py --root . --publish-gate --anchors-ref refs/remotes/origin/gh-pages` e a busca do gh-pages. Mudanças em outras partes desses workflows continuam livres.

O proprietário é a única conta e não pode aprovar o próprio PR, então revisão obrigatória e CODEOWNERS não funcionam aqui. Um PR que mexe nas âncoras só entra por **decisão explícita e deliberada do proprietário**: ele faz o bypass da proteção e registra o motivo no PR.

Como `pull_request_target` usa a definição da base, o check só passa a valer depois que este workflow estiver no gh-pages. Portanto ele não roda no próprio PR #946, que altera âncoras (o script do portão e `data/politica-unica.json`) e por isso já exige a decisão deliberada do proprietário.

## Limites que continuam (decisão do proprietário)

- O check protegido não está entre os checks obrigatórios do gh-pages. Este PR não muda a proteção da branch. Para o check bloquear de fato, o proprietário precisa acrescentar `legal-trust-anchors-protected / protected-trust-anchors` aos checks obrigatórios.
- O repositório permite merge por rebase. Num rebase, um PR com dois commits (o 1º cadastra o revisor, o 2º aprova citando o 1º) chega ao gh-pages com a mesma forma do fluxo legítimo em dois PRs, e o git não distingue os dois casos. Esse PR altera âncoras, então o check protegido reprova. Para fechar também esse caminho no portão, o proprietário pode desligar o merge por rebase (fica só squash).
- Com uma única conta, toda proteção pode ser contornada pelo proprietário. O objetivo é que nenhuma aprovação entre **sem** uma decisão explícita dele, registrada no PR.

## Fluxo para publicar um texto novo

1. Um PR muda o texto. O check protegido reprova se esse PR tocar `data/politica-unica.json`. Depois do merge, por bypass deliberado, os deploys param em `BLOCKED`.
2. Num PR separado, o proprietário cadastra o revisor em `legal-reviewers.json`, com nome, OAB, `github_login`, `authorized_by: "proprietario"` e `authorized_at`. O merge desse PR, por bypass, gera o commit S.
3. Num PR seguinte, entram:
   - a entrada do revisor recebe `authorization_commit = S`;
   - `legal_review` fica APPROVED, com `reviewed_sha256` igual à impressão digital do texto, `reviewed_commit` igual ao commit do gh-pages que contém o texto e `document_version`;
   - o registro `docs/legal/reviews/<sha256>.json`.
4. O deploy seguinte passa com `PASS_APPROVED`. Depois de publicar, a linha de base pode passar a ser esse `reviewed_sha256`, porque ele corresponde a um registro válido.

## Decisão do proprietário (L-3)

Enquanto `legal_review` estiver PENDING e o texto do repositório for diferente do publicado, **todo** deploy desses dois fluxos fica parado no portão, inclusive deploys sem relação com o texto jurídico.

Isso é por desenho e cabe ao proprietário decidir: manter esse bloqueio ou restringir o portão às superfícies jurídicas.

O GitHub Pages publica só os stubs de redirecionamento de `pages-mirror/`, então não publica texto jurídico.
