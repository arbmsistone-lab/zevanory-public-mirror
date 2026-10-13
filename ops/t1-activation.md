# T1 — ordem de ativação e migração de credenciais

Plano mestre 3.1. Documento operacional; nenhuma etapa é executada sem a autorização indicada.

## A. Ordem de integração

| Passo | Ação | Quem | Efeito em produção | Verificação |
|---|---|---|---|---|
| 1 | Mesclar **zevanory-product-control-edge #210** | Proprietário | O workflow do repositório do painel vira só build + dry run (**não publica**). Como `scripts/cloudflare-authoritative-repair.mjs` muda, o **reconciliador agendado do mirror** (t2, a cada 15 min) detecta novo commit de runtime e **republica o painel com o mesmo código**, passando pela sua guarda (só avança a partir do live) | `controle.zevanory.api.br/version.json` passa a mostrar o SHA do #210 |
| 2 | Reexecutar o check `external-repository` do **#799** | Executor | Nenhum (só leitura) | check verde |
| 3 | Mesclar **zevanory-public-mirror #799** | Proprietário | **Publicam:** `central-production-deploy` (Worker `zevanory`) e `zevanory-sales-public-release` (Worker de vendas). **Só verificam:** `sales-legal-publish`, `t1-publisher-guard`, checks estáticos e de voz, sondas WhatsApp (a prova real está desativada no código). O router **não** dispara | ver C |
| 4 | Leitura pós-promoção | Executor (relatório) e auditor (parecer) | Nenhum | ver C |

**Guarda real:** em cada publicação, a guarda pré-promoção roda **dentro da fila**, imediatamente antes de publicar. A prévia do merge (`merge-effect-preview`) é só indicativa: não certifica nada.

## B. Recuperação preservada

- **Central:** se a verificação pós-deploy falhar, `wrangler rollback` volta para a versão anterior àquela execução (mantido).
- **Vendas:** se o readback falhar, o snapshot da versão anterior é restaurado (10 disponíveis em 13/10). Sem snapshot, a execução falha alto **sem apagar o script** (mudança do T1).
- **Painel:** o rollback por despacho (#797) foi mantido. O reconciliador pausa com a variável `ZPC_ROLLBACK_HOLD`.
- **Produção ilegível:** a guarda recusa. Recuperação só por despacho explícito do proprietário, depois de confirmar a versão no painel da Cloudflare.

## C. Certificação da promoção real (depois do passo 3)

Para cada Worker publicado, gravar no relatório:
1. o resultado da guarda na execução real (`PROMOTION_GUARD_*`, decisão e motivo);
2. `POST_PROMOTION_*` = `effective_version_is_candidate`: tag da versão ativa na Cloudflare **e** readback (`/api/release`, `/health`) iguais ao SHA mesclado;
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
