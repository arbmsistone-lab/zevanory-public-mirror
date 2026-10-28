# Evidência: reauditoria rodada 5 do PR #946

As ferramentas do auditor (`scratchpad/audit-v12/pr946-r5/tools/`) rodaram contra o commit `0e890b12`, que traz o desenho por bytes. Nenhum dos três `.sh` do auditor aceita o head como parâmetro, então a **única** mudança neles foi o valor fixo de `H` (`ae8e4d51…` → `0e890b12…`). O resto vem sem edição, e as saídas brutas estão aqui.

## Saídas sem adaptação (só `H`)

| Arquivo | Resultado | Leitura |
|---|---|---|
| `r5-newwf.txt` | `quoted`, `varcmd`, `npmscript`, `reusable` e `apicurl`: **`TRUST_ANCHORS=CHANGED`** | Todo workflow novo é âncora. |
| `r5-b1.txt` | O build malicioso ainda "publica" no passo 4 | O script **simula o job da rodada 4**: portão antes do build e integridade `git diff --exit-code HEAD`. Ele não roda o passo do portão novo; ver `r5-b1-newjob` abaixo. |
| `r5-attacks.txt` | `fp=LEGAL_ASSET_MISS` em todos os casos | O T0 restaura as páginas da base, que referenciam `assets/legal.dd437829cb.css`. Esse arquivo não existe no head, e a impressão digital por bytes **reprova fechada** (`LEGAL_ASSET_MISSING`). Para medir os ataques, o T0 precisa da adaptação abaixo. |
| `ma-attacks-orig.txt` | Mesmo efeito no T0 e no A1b; A1 dá `BLOCKED`; A2 `coe`, `ift`, `ortrue` e `newwf` dão `CHANGED` | — |

## Adaptações inevitáveis, linha por linha

1. **`r5-attacks-adapted.sh`** e **`ma-attacks-adapted.sh`**: uma única linha foi **acrescentada**, logo depois da linha do T0 `for f in $LEGAL ... show $BASE:$f > $f; done`:

   ```
   for a in $(git -C "$WT" ls-tree -r --name-only $BASE sales-public/assets | grep -E 'legal\.[0-9a-f]+\.css$'); do git -C "$WT" show $BASE:$a > $a; git add $a; done
   ```

   O T0 representa "o que está publicado". Agora isso inclui os bytes do CSS que as páginas jurídicas da base referenciam, então o CSS da base precisa existir e entrar no commit T0. Sem o `git add`, o arquivo ficaria não versionado: os passos C[attr] e C[css] o alterariam, e o `git checkout -f` não o restauraria. Nenhuma outra linha mudou.
   - Em `ma-attacks-adapted.txt`, o T0 continua `BLOCKED`. O T0 original desse script restaura só termos e reembolso, e `/privacidade` e `/afiliados` do head diferem da base. É o mesmo efeito que o próprio auditor registrou na rodada 5. A1 continua `BLOCKED`.
   - O rótulo "gênese 4f8d16325…" do A1b é o valor antigo. A gênese atual é `46675c70…`, e o A1b dá outro valor.
2. **`r5-b1-newjob.sh`**: é o `r5-b1.sh` (com `H`) **mais um passo 5 acrescentado no fim**. Nada acima foi tocado. O passo 5 extrai do workflow do head, sem edição, o corpo do passo "Legal artifact gate before the candidate deploy" e o executa com `GITHUB_SHA=S3`, no estado deixado pelo build malicioso. Resultado: **`rc=1`**. O `HEAD` deixou de ser o commit do evento, por causa do commit local do build, e o deploy para.

## Saídas com adaptação

- `r5-attacks-adapted.txt`:
  - T0 com `fp=46675c70`, `PASS_UNCHANGED`.
  - **`hide`, `input`, `srcdoc`, `attr` e `css`: impressão digital diferente do T0** ("igual T0: nao"). O portão bloqueia o deploy desses PRs. A guarda fica `UNCHANGED` porque páginas não são âncora: quem pega é o portão.
  - **W1: `CHANGED`.** O Worker de vendas é âncora. A linha "servido" do script chama `injectSiteChatHtml` direto sobre o HTML; as rotas jurídicas não passam mais por essa função (`tests/legal-routes-artifact.test.mjs` compara os bytes servidos pela rota).
  - **B1:** a integridade do script dá rc=1, e nada é publicado.
  - **V1:** validador `INVALID` e guarda `CHANGED`.
  - **V2:** o passo do validador **não existe mais** em `product-pages-premerge.yml` (ele foi para o check protegido). Por isso o trecho do script que o removeria falha (`substring not found`) e não cria commit. A linha impressa mede o mesmo HEAD do V1. Qualquer mudança no premerge é `CHANGED` (teste G14 "V2 premerge").
- `r5-b1-newjob.txt`: passo 5 com **rc=1**, deploy parado.

## Testes na suíte, para cada reprodução

| Reprodução | Teste |
|---|---|
| r5-b1 (commit local) e variantes `assume-unchanged` e reescrita | `tests/legal-publish-gate.test.mjs` G13 |
| `hide`, `input`, `srcdoc`, `attr`, `css`, asset ausente ou externo | G12 |
| W1, V2, r5-newwf (`quoted`, `varcmd`, `npmscript`, `apicurl`), action local | G14 |
| V1 (wrangler entre aspas com `if: always()`), deploy via variável, upload pela API | G11 |
| Corpo servido igual ao artefato | `tests/legal-routes-artifact.test.mjs` LR2 |
