# T1 — ordem de ativação e migração de credenciais

Plano mestre 3.1. Documento operacional; nenhuma etapa é executada sem a autorização indicada.

## Estado (13/10/2026, parecer do auditor independente)

| Item | Estado | Evidência |
|---|---|---|
| Ativação técnica do T1 (central, vendas, painel) | **PASS** | merges #799 `82166477` e edge #210 `f501904e`; runs 38445395191, 38445395157, 38447421653 → 38447454947; `external-repository` verde (38445395184, tentativa 2) |
| **T1 integral** | **NÃO COMPROVADO** | pendência única de credenciais, abaixo |
| Autenticação da identidade executora | BLOQUEADO | identidade GitHub compartilhada (seção E) |

**Pendência aberta: exclusividade efetiva das credenciais Cloudflare**
- Responsável: o proprietário cria os tokens; o executor certifica e faz a transição.
- Critério de encerramento: os quatro `CF_TOKEN_*` passam por `SCOPE_READY` no `credential-scope`; cada publicador usa o token do seu Worker e é certificado por uma publicação real **já prevista** (nenhuma publicação só para gerar evidência); depois disso, revogação do token de conta inteira com confirmação de continuidade. O procedimento está na seção D.
- **Proibido antes disso:** revogar o token atual.
- Limites da evidência: uma publicação bem-sucedida não prova ausência de concorrência em todos os cenários, e a ausência de rollback não prova recuperação real.

## A. Ordem de integração: **#799 primeiro, #210 depois**

| Passo | Ação | Quem | Efeito em produção | Verificação |
|---|---|---|---|---|
| 0 | Pré-condição (só leitura): fonte de runtime do `main` do painel = versão efetiva do painel | Executor | Nenhum | `git log -1 -- <runtime paths>` do painel = `version.json.sha` |
| 1 | Mesclar **zevanory-public-mirror #799** | Proprietário | **Publicam:** `central-production-deploy` (Worker `zevanory`) e `zevanory-sales-public-release` (vendas), com guarda dentro da fila e pós-verificação pelas duas fontes. **Painel: nada publica** (ver A.1). Router não dispara. O check `external-repository` do #799 fica vermelho por desenho até o passo 3 | ver C |
| 2 | Leitura pós-promoção de central e vendas | Executor | Nenhum | `PROMOTION_GUARD_*`, `POST_PROMOTION_*` = PASS, smokes |
| 3 | Mesclar **zevanory-product-control-edge #210** | Proprietário | O workflow do repositório do painel vira build + dry run (**não publica**). O script de deploy passa a marcar a versão. O solicitante agendado (t2) vê a fonte à frente do live e **pede** o publicador canônico, que roda a guarda na fila, publica e certifica pelas duas fontes | `POST_PROMOTION_zevanory-product-control-portable` = PASS; `version.json.sha` = SHA do #210 |
| 4 | Reexecutar `t1-publisher-guard` (só leitura) | Executor | Nenhum | `external-repository` verde |

### A.1 Por que a janela entre os merges não tem publicação desprotegida

Inventário de quem pode publicar o painel em cada momento:

| Caminho | Antes do #799 | Entre #799 e #210 | Depois do #210 |
|---|---|---|---|
| t2 agendado (mirror) | publicador antigo; fonte = live → não publica | **solicitante** sem credencial Cloudflare; só pede quando a guarda diz `forward_of_live` | solicitante |
| `zpc-control-worker-deploy` (canônico) | despacho / pin | guarda na fila. **Avanço recusado antes de publicar** se o script da fonte não marca a versão (`SOURCE_WITHOUT_VERSION_TAG`): o `main` do painel antes do #210 não marca, então nenhum avanço é possível | guarda + publicação marcada + pós-verificação pelas duas fontes |
| `zpc-canonical-worker-promotion` (repositório do painel) | push no `main`; falha no passo de promoção em 0 s, 10/10 execuções (13/10) | inalterado (mesmo estado de hoje) | **removido** pelo #210 (vira dry run) |
| Rollback do proprietário (canônico) | disponível | **disponível** (a exigência de marcação vale só para avanço) | disponível |

- **Ordem inversa (#210 primeiro), descartada:** o t2 antigo, ainda sem a guarda nova, republicaria o painel com o script do #210. Era essa a janela apontada pelo auditor.
- **Nenhum experimento em produção:** a prova é a simulação integrada `tests/test_t1_transition.py`, que executa os scripts reais dos workflows contra um repositório-fixture e uma rede simulada (cenários S0–S9), mais os testes do inventário. A primeira publicação real do painel no passo 3 é a certificação.
- **Rollback preservado:** um rollback para fonte anterior ao #210 funciona. A pós-verificação dele fica NÃO COMPROVADO, porque essa versão não carrega a marcação: só o readback a confirma. O passo falha e a versão permanece, por decisão do proprietário.
- **Failover preservado:** central mantém o `wrangler rollback` automático e vendas mantém o snapshot. Ambos disparam também quando a pós-verificação dá FAIL ou NÃO COMPROVADO.
- **Risco residual da janela:** o publicador do repositório do painel continua existindo até o #210, como hoje. Ele falha no passo de promoção, mas a causa (credencial ausente) está **NÃO COMPROVADA** por log, porque os logs de job não são legíveis daqui. O indício é a duração de 0 s, compatível com `CLOUDFLARE_API_TOKEN_REQUIRED`, que o script verifica antes de qualquer chamada de rede. Mitigação: mesclar o #210 logo após a leitura do passo 2.

## B. Recuperação preservada

**Política após a pós-verificação (T1 v6):**
- **FAIL** = evidência positiva: uma fonte respondeu com outro SHA, as fontes divergem, o serviço respondeu com erro HTTP, ou a Cloudflare respondeu sem versão única marcada. A recuperação automática roda.
- **NAO_COMPROVADO** = o observador não alcançou uma fonte (rede, timeout, API da Cloudflare, credencial). **Não há rollback.** Os smokes passaram e não há evidência contrária, então a versão fica no ar. O passo de certificação reprova a execução, e a verificação independente (`t1-publisher-guard`, `workflow_dispatch`, `recheck_service`) decide. Só um FAIL nela autoriza a recuperação, pelo caminho documentado do serviço.
- **Sem congelamento automático das próximas promoções:** cada promoção seguinte passa pela mesma fila, pela mesma guarda (que recusa divergência) e pela mesma pós-verificação. Um congelamento exigiria estado persistente gravável pelo workflow (variável de repositório), e o `GITHUB_TOKEN` não tem permissão para isso.

- **Central:** se a verificação pós-deploy falhar, `wrangler rollback` volta para a versão anterior àquela execução (mantido).
- **Vendas:** se o readback falhar, o snapshot da versão anterior é restaurado (10 disponíveis em 13/10). Sem snapshot, a execução falha alto **sem apagar o script** (mudança do T1).
- **Painel:** o rollback por despacho (#797) foi mantido e é a única exceção documentada ao caminho de avanço, dentro do próprio publicador canônico (mesma fila, mesma receita, auditoria, pós-verificação). O solicitante t2 pausa com a variável `ZPC_ROLLBACK_HOLD` e nunca pede rollback.
- **Produção ilegível:** a guarda recusa. Recuperação só por despacho explícito do proprietário, depois de confirmar a versão no painel da Cloudflare.

## C. Certificação da promoção real (depois do passo 3)

Para cada Worker publicado, gravar no relatório:
1. o resultado da guarda na execução real (`PROMOTION_GUARD_*`, decisão e motivo);
2. `POST_PROMOTION_*` com estado `PASS`: tag da versão ativa na Cloudflare **e** readback (`/api/release`, `/health`, `version.json`) presentes, iguais entre si e iguais ao SHA mesclado. Fonte ausente = `NAO_COMPROVADO`, divergência = `FAIL`; ambos reprovam o passo;
3. a verificação pós-deploy existente (smoke, readback, legal) verde.

Sem esses três itens, a promoção é NÃO COMPROVADA, mesmo com o merge feito.

## D. Migração para credenciais de menor privilégio (sem revogar antes de certificar)

Hoje os 19 workflows que alteram Workers usam o mesmo token, que **lista** os 39 Workers da conta. A permissão de **edição** desse token só fica comprovada se as políticas do próprio token forem legíveis; o job `credential-scope` tenta lê-las e marca NAO_COMPROVADO quando não consegue.

1. **Proprietário:** no painel da Cloudflare, criar tokens de conta com escopo **"Specified Workers"**:
   - `CF_TOKEN_ZEVANORY`: Editor em `zevanory`;
   - `CF_TOKEN_SALES`: Editor em `zevanory-sales-public`;
   - `CF_TOKEN_ROUTER`: Editor em `zevanory-public-router` + Zone › Workers Routes › Write só se o deploy alterar rotas;
   - `CF_TOKEN_PANEL`: Editor em `zevanory-product-control-portable`.

   Gravar cada um como **segredo do repositório** com esse nome. Não colar valores em chat, PR ou arquivo.
2. **Executor:** reexecutar `t1-publisher-guard`. Cada token novo precisa dar `SCOPE_READY` (enxerga só o seu Worker; lê deployments e settings).
3. **Executor, em PR separado:** trocar o token nos publicadores daquele Worker para `secrets.CF_TOKEN_<X>`, com o token atual como reserva. Depois, publicar uma vez e certificar pelo item C.

   Recursos que não são Workers (KV, D1, segredos de conta), usados por alguns passos, podem exigir permissões adicionais. Isso é medido nesta etapa, não presumido.
4. **Proprietário:** só depois de todos os publicadores certificados com o token próprio, **revogar** o token de conta inteira. Antes disso, nenhuma revogação.
5. **Ficam de fora até autorização escrita:** workflows financeiros e `owner-oauth-key-bootstrap`, que lê `zevanory` e escreve no painel, logo precisa de escopo nos dois.

## E. Identidade do executor: o que é e o que não é autenticado

- `session-guard` lê identificadores de sessão **declarados** em commits e no corpo do PR. Reprova se não houver nenhum (identidade não estabelecida) e se houver algum fora de `ops/executor.json`.
- **Não autentica.** Declaração é texto, e todos os agentes publicam com a mesma identidade GitHub do proprietário. Actor e autor não distinguem proprietário de agente.
- **Controle decisivo:** só o proprietário mescla (revisão do PR). Tornar `session-guard` e `external-repository` obrigatórios é decisão de proteção de branch do proprietário.
