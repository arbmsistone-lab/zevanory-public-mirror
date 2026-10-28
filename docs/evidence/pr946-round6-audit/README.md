# Evidência: reauditoria rodada 6 do PR #946 (H-1)

Os scripts do auditor (`scratchpad/audit-v12/pr946-r6/tools/r6-job.sh`) rodaram contra o commit `493a4603`, que separa build e deploy. O commit seguinte do PR só acrescenta testes, documentação e esta pasta.

## `r6-job.sh` original (só o SHA `H` trocado)

Arquivos: `r6-job.sh`, `r6-job-orig-worker.txt` e `r6-job-orig-origin.txt`.

O script **simula a estrutura antiga**: um job só, com portão inicial, build, `git fetch origin` e portão final. Essa estrutura não existe mais no head.

- **`MODE=worker`:** mesmo nessa simulação antiga, o portão final agora dá **`BLOCKED`**, porque o código que serve as rotas jurídicas entrou na impressão digital.
- **`MODE=origin`:** a simulação antiga ainda executa o portão falso, porque o próprio script faz `git fetch origin` depois de o build trocar a URL. O job `deploy` novo **não tem esse passo**: lê o portão do checkout confiável feito no próprio job. Ver abaixo.

## `r6-newjob.sh` (adaptado ao desenho novo)

Arquivos: `r6-newjob.sh`, `r6-newjob-worker.txt` e `r6-newjob-origin.txt`.

**Adaptações:**

- Linha 7: `H` passa a vir do ambiente.
- Tudo até a linha `# "merge" e checkout do runner` é o script original. A partir dali, o bloco marcado `ADAPTAÇÃO r7` simula os jobs novos, cada um num clone próprio (runners diferentes):
  - **`site-build`:** roda o build malicioso do PR-3 e empacota `sales-public/`. O script também confere no workflow que esse job não recebe segredo.
  - **`worker-bundle`:** clone próprio, que não roda o build (o script confere no workflow).
  - **`deploy`:** checkout confiável em `base/`, mais o artefato do site. O passo do portão é **extraído do workflow do head**, sem edição. O `/reembolso` é servido pelo Worker do clone do `worker-bundle` (fontes âncora), com os assets do artefato.

**Resultados:**

| Modo | Portão do deploy | `/reembolso` servido | Leitura |
|---|---|---|---|
| `MODE=worker` | `PASS_APPROVED` (o artefato do site não mudou) | **texto original** | A reescrita do Worker ficou no workspace do `site-build`. Caminho **impossível**. |
| `MODE=origin` | **`BLOCKED`**, rc=1 | — | O `remote.origin.url` falso só existe no workspace do `site-build`; o CSS trocado chega no artefato e o portão bloqueia. **Falha fechada.** |

**Token (c):** os jobs que rodam código de build não recebem segredo. Isso é imposto pelo validador (`tests/legal-publish-gate.test.mjs` G11, "segredo no job de build").
