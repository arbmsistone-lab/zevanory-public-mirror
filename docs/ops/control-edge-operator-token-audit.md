# Auditoria: verificação HMAC do Worker de controle e a migração da credencial de operador (R9-D1, Sol 237)

Estado: auditoria **somente leitura**.

- O código foi lido em `zevanory-product-control-edge@f501904` (main) e neste repositório (ramo do PR #923).
- Nenhuma chamada à produção, nenhum segredo lido, nenhum deploy, nenhum dispatch.
- A mudança de código correspondente está no edge #211 (rascunho).

## 1. O que é o Worker de controle

| Item | Valor |
|---|---|
| Worker Cloudflare | `zevanory-product-control-portable` (conta `1b264158…`) |
| Rotas | `controle.zevanory.api.br` (custom domain), `zevanory.api.br/control*` |
| Código | `zevanory-product-control-edge`: `cf-worker/worker.ts`, `cf-worker/wrangler.toml` |
| Publicador canônico | `zpc-control-worker-deploy.yml` (este repositório; Environment `producao-critica`) |
| Requisitante agendado | `t2-exact-control-worker-promotion.yml` (cron `*/15`; só pede o publicador, sem credencial Cloudflare) |

## 2. Verificação HMAC (`x-commercial-signature`)

Código antes do edge #211: `cf-worker/worker.ts`.

- `verifyFactoryRequest`, linhas ~189-205;
- `verifyCreativeUploadRequest`, linhas ~284-300.

Com o #211, as duas funções delegam para `cf-worker/commercial-hmac.ts`.

| Aspecto | Comportamento |
|---|---|
| Algoritmo | HMAC-SHA256; assinatura em hex minúsculo de 64 caracteres no cabeçalho `x-commercial-signature` |
| Canônica "factory" | `zevanory-commercial-creative-factory-v1\n<timestamp>\n<nonce>` |
| Canônica "upload" | `zevanory-commercial-creative-upload-v1\n<timestamp>\n<nonce>\n<slug>\n<sha256 hex do corpo>` |
| Timestamp | `x-commercial-timestamp`: 13 dígitos (ms epoch); tolerância de ±5 min (`Math.abs(now - ts) > 300000` recusa) |
| Nonce | `x-commercial-nonce`: `^[0-9a-f-]{36}$` (formato UUID solto) |
| Replay | **sem** registro de nonce no Worker: dentro de ±5 min a mesma assinatura vale de novo |
| Comparação | `crypto.subtle.verify` (tempo constante). Antes do #211, parava no primeiro candidato que casasse; com o #211, avalia todos, sem saída antecipada |
| Candidatos (hoje) | `[COMMERCIAL_ROBOT_TICK_SECRET, CERTIFICATION_E2E_TOKEN]`, cada um só se tiver pelo menos 32 caracteres; sem nenhum, recusa (fail-closed) |
| Falha | 401 `commercial_creative_factory_auth_required`, `commercial_creative_upload_auth_required` ou `commercial_publish_auth_required` |
| Registro | antes do #211, nenhum; com o #211, `commercial_hmac_auth {"category":"primary\|legacy\|tick\|none"}` uma vez por categoria por isolate, mais contadores; nunca valor |

**Rotas HMAC e canônica de cada uma:**

| Rota | Canônica | Efeito colateral |
|---|---|---|
| `POST /api/commercial/creative/background?product=&seed=` | factory | gera imagem Workers AI (custo de neurons) |
| `POST /api/commercial/creative/upload?product=&angle=` | upload | grava criativo (KV e Supabase), entra na fila de aprovação |
| `POST /api/commercial/creative/factory/tick?product=&finalize=&force=` | factory | gera e grava criativos (Workers AI, KV e Supabase) |
| `POST /api/commercial/publish/tick` | factory | `runT3Publisher`: publica na Meta |
| `GET /api/commercial/publish/status` | factory | `subscribed_apps` na Meta (comentário no código: "Has side effects") |
| `POST /api/commercial/auth/probe` (novo, edge #211) | `zevanory-commercial-auth-probe-v1` | **nenhum**: só responde a categoria |

## 3. Quem assina, e com qual segredo

| Job | Workflow / Environment | Segredo de assinatura | Chamadas |
|---|---|---|---|
| T2-1 | `t2-content-calendar.yml#compose`, `gh-pages-automacao`, cron `7 11 * * *` + dispatch | env `ZEVANORY_OPERATOR_TOKEN` = `secrets.ZEVANORY_OPERATOR_TOKEN \|\| secrets.CERTIFICATION_E2E_TOKEN` | `scripts/t2/compose-creatives.mjs` (`T2_CALENDAR=1`): `background` (factory), `upload` (upload), `factory/tick?finalize=1` (factory) |
| T2-2 | `t2-creative-compose.yml#compose`, `gh-pages-automacao`, dispatch | idem | mesmo script, 5 criativos |
| T2-3 | `t2-regenerate-ia-clean.yml#regenerate`, `gh-pages-automacao`, push do próprio arquivo + dispatch | idem | `factory/tick?product=ia-na-pratica&force=1` (factory) |
| T2-4 | `t2-workers-ai-creative-factory.yml#generate`, `gh-pages-automacao`, push do próprio arquivo + dispatch | idem | `factory/tick` 5 vezes (factory) |
| (não assina) | `zpc-control-worker-deploy.yml#deploy`, `producao-critica` | nenhum. Usa só o token Cloudflare (`CLOUDFLARE_PUBLIC_OWNER_API_TOKEN \|\| CLOUDFLARE_API_TOKEN`) para publicar | smoke **sem** assinatura: `factory/tick` precisa responder `401 commercial_creative_factory_auth_required` |
| (fora do GitHub) | Render, `server.ts` `triggerCreativeFactory` | `COMMERCIAL_ROBOT_TICK_SECRET` (env do Render) | `factory/tick` (factory) |

**Resumo por segredo:**

- **Os 4 jobs T2** assinam com o **mesmo** valor: o `ZEVANORY_OPERATOR_TOKEN` do Environment `gh-pages-automacao` quando existir, senão o `CERTIFICATION_E2E_TOKEN` desse Environment.
  - Hoje, sem o nome novo no Environment, assinam com o valor antigo.
  - No Worker de controle, esse valor casa com o candidato `CERTIFICATION_E2E_TOKEN` (categoria `legacy`).
  - Daqui não dá para verificar se o mesmo valor também está em `COMMERCIAL_ROBOT_TICK_SECRET`.
- **O Render e o cron do próprio Worker** usam `COMMERCIAL_ROBOT_TICK_SECRET`.
  - O cron (`wakeCommercialRobot`, canônica `zevanory-commercial-robot-tick-v1`) chama o Render.
  - O Render verifica em `backend/commercial-robot-auth.ts`: só `COMMERCIAL_ROBOT_TICK_SECRET`, ±120 s, cache de nonce, `timingSafeEqual`.
  - **Nada disso muda com a migração.**
- **`publish/tick` e `publish/status`:** nenhum chamador nos repositórios visíveis (este e `zevanory-product-control-edge`). Chamada manual ou de fora desses repositórios não pode ser descartada.

## 4. Como os segredos do Worker de controle são provisionados

- **`wrangler.toml`:** não declara segredos. Os `[vars]` são só `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `RENDER_BACKEND_URL` e `BACKEND_INSTANCE_ID`.
- **Deploy:** `scripts/cloudflare-authoritative-repair.mjs` (edge) roda `wrangler deploy`, que **preserva** os secrets existentes. O deploy é chamado por `zpc-control-worker-deploy.yml`, no Environment `producao-critica`.
- **Nenhum workflow grava** `COMMERCIAL_ROBOT_TICK_SECRET`, `CERTIFICATION_E2E_TOKEN` ou `ZEVANORY_OPERATOR_TOKEN` no Worker `zevanory-product-control-portable`. A gravação é fora de banda, pelo painel Cloudflare ou por `wrangler secret put` do proprietário.
  - O único precedente de gravação automatizada nesse Worker é `owner-oauth-key-bootstrap.yml` (`OWNER_OAUTH_BRIDGE_SECRET`, `producao-critica`).
- **Presença de `CERTIFICATION_E2E_TOKEN` no Worker de controle:** não verificada (exigiria ler a produção). Se os jobs T2 passam hoje, então pelo menos um candidato casa com o valor de `gh-pages-automacao`.
- **Com o edge #211 e este PR:**
  - O valor novo entra como **secret** do Worker de controle, gravado pelo proprietário no passo (5): `wrangler secret put ZEVANORY_OPERATOR_TOKEN --name zevanory-product-control-portable`.
  - A flag não secreta `OPERATOR_TOKEN_MIGRATION_UNTIL` vem de `vars.OPERATOR_TOKEN_MIGRATION_UNTIL`. O publicador `zpc-control-worker-deploy.yml` a passa ao script de deploy, que a valida (formato e teto `2026-12-31`; inválida recusa o deploy) e a grava como `--var`.
  - O deploy recusa um `wrangler.toml` que fixe a flag ou um nome de credencial.

## 5. Consumidores em outros repositórios

| Repositório | O que tem |
|---|---|
| `zevanory-public-mirror` (este) | os 4 jobs T2 (assinam), `zpc-control-worker-deploy.yml` (publica; smoke sem assinatura), `t2-exact-control-worker-promotion.yml` (pede o publicador), `owner-oauth-key-bootstrap.yml` (precedente de `secret put` no Worker de controle) |
| `zevanory-product-control-edge` | o verificador (`cf-worker/worker.ts`, e com o #211 `cf-worker/commercial-hmac.ts`); `server.ts` (Render: assina `factory/tick` com `COMMERCIAL_ROBOT_TICK_SECRET`); `backend/commercial-robot-auth.ts` (Render: verifica o robot tick com `COMMERCIAL_ROBOT_TICK_SECRET`) |
| Outros | não enumeráveis daqui: a sessão só acessa repositórios configurados, e a busca de código na organização está bloqueada. As cópias locais encontradas (`zpc-src`, `zv`) são clones desses dois repositórios |

## 6. Decisão do edge #211 e prova sem efeito colateral

- **Candidatos:**
  - `tick` e `legacy`, sempre, como hoje;
  - `primary` (`ZEVANORY_OPERATOR_TOKEN`) **só** com a janela aberta.
- **Fora da janela:** o conjunto é exatamente o de hoje. Não se remove nada antes do A2.
- **Sonda:** `POST /api/commercial/auth/probe`.
  - Usa o **mesmo** `verifyCommercialSignature`, com os mesmos candidatos, a mesma tolerância e o mesmo formato.
  - A canônica é separada: uma assinatura da sonda nunca vale numa rota T2 (que tem efeito colateral), e o contrário também não.
  - A resposta tem só `category`, `migration` e `sideEffects:"none"`.
- **Prova no GitHub:** `operator-token-consumer-auth.yml#control-edge-t2-hmac`.
  - Uma linha por job T2, no Environment `gh-pages-automacao`.
  - Usa só `secrets.ZEVANORY_OPERATOR_TOKEN`; executa `scripts/ci/control_edge_hmac_probe.mjs --require-primary`.
- **Lacuna declarada:**
  - A sonda não executa as rotas T2. As canônicas diferem, e as rotas geram, gravam ou publicam.
  - A equivalência vem do código: as 5 rotas chamam o mesmo verificador (teste estático H10 no edge).
  - A primeira execução real de ponta a ponta é o próximo job T2. O mais seguro é o cron `t2-content-calendar`, que manda um criativo para a fila de aprovação e não publica.

## 7. Riscos residuais

1. **Replay dentro de ±5 min.** Não há registro de nonce no Worker de controle. A canônica factory não amarra método, rota nem query, então uma assinatura capturada de `background` vale em `factory/tick?force=1`, `publish/tick` ou `publish/status` dentro da janela de tempo. Isso é anterior à migração e ficou inalterado por pedido. Sugestão para um PR próprio: amarrar rota e query na canônica e registrar nonces em KV com TTL de 10 min.
2. **Assimetria depois da data** (ver `operator-token-transition.md`, "Depois da data"). Sem o A2 do edge, os 4 jobs T2 falham com 401 quando a janela fecha, porque o controle volta a recusar o valor novo enquanto o Worker principal o aceita. É de propósito (fail-closed, visível). Por isso o A2 do edge precisa estar em produção antes do vencimento.
3. **Promoção automática.** O merge do edge #211 faz o reconciliador pedir o deploy do controle em até 15 min. Sem `vars.OPERATOR_TOKEN_MIGRATION_UNTIL`, a janela fica fechada e o comportamento é idêntico ao de hoje. Apagar a variável antes do A2 do edge fecha a janela no deploy seguinte, inclusive num deploy pedido sozinho.
4. **Segredos fora de banda.** A presença e a igualdade dos valores no Worker de controle não têm readback automatizado (o controle não tem um equivalente de `credential-identity`). A sonda prova a aceitação do valor novo, mas não prova a ausência de outros valores.
5. **Rotas `publish/*` sem chamador conhecido.** Se existir chamador fora dos repositórios visíveis assinando com o valor antigo, ele continua funcionando até o A2 do edge e depois falha. O registro por categoria (`legacy`) no controle é o sinal para encontrá-lo antes.
6. **Proteção do Environment `producao-critica`.** Não foi possível confirmar se há revisores obrigatórios: a API de Environments está bloqueada nesta sessão. O procedimento supõe aprovação manual dos deploys.
