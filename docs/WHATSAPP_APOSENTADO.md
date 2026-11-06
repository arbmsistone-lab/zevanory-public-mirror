# WhatsApp aposentado — contrato do código e passos do dono

**Fato:** a Meta desativou PERMANENTEMENTE a conta WhatsApp Business da ZEVANORY (WABA `4019600665012911`,
phone_number_id `1300972319774588`) em 10/10/2026, por violação da Política de Uso Aceitável.
Causa provável, encontrada no próprio sistema: workflows de "prova de entrega" geravam webhooks de entrada
**assinados com o app secret** (rota `/api/admin/whatsapp-onboard/delivery-proof`) e os postavam no webhook de
produção. O robô respondia de verdade, com preços e links, ao número pessoal do dono, inclusive fora da janela
de 24 h (`whatsapp-delivery-recovery` runs 37702381335 e 37813017349; `voice-render-proof` run 37292205572).

## O que o código garante agora (fail-closed)

| Item | Comportamento |
|---|---|
| Aposentadoria | **Constante no código** (`WHATSAPP_CHANNEL_RETIRED = true` em `worker/whatsapp-retirement.mjs`). Nenhuma variável de ambiente, config ou KV reativa nada: `WHATSAPP_CHANNEL_RETIRED=false` e `WHATSAPP_INSTANT_REPLY=true` são ignorados (há teste e mutante para isso). Qualquer retorno exige uma PR nova. |
| Chamadas à Meta/broker | Nenhuma chamada à Graph API nem ao broker em nenhum caminho (status, health, continuity, control-plane, voz, config, webhooks). Credenciais do WhatsApp não são carregadas; globais antigas do isolate são zeradas. |
| Status | `/api/release` → `whatsapp_mode: "disabled_permanent"`; `/api/status` → `runtime.whatsapp: "disabled_permanent"`, `runtime.whatsapp_state: "retired"`, `runtime.whatsapp_reason: "meta_account_permanently_disabled"`. |
| Quórum/health | WhatsApp nunca conta: fora do quórum de continuidade (`retired_channels: ["whatsapp"]`), da prontidão de distribuição e da identidade de marca; `channel_identity_health` não tenta verificar (`attempted: false`). |
| Robô de entrada | Resposta instantânea **sempre desligada** (constante). Envio, upload de voz, download de mídia e adaptador `channel:whatsapp` recusam antes de qualquer token ou fetch. |
| Webhook da Meta | Primeiro **classifica o produto** (objeto e campos). Só entrega **comprovadamente** do WhatsApp (`object: whatsapp_business_account` com campos do WhatsApp, até 256 KB) recebe **200** e nada mais: sem checar assinatura com segredos guardados, sem processar, sem gravar conteúdo, sem responder. Instagram/Facebook, entregas grandes ou não classificáveis seguem o tratamento normal (assinatura, limite de tamanho), nunca um 200 silencioso. A chave de diagnóstico da verificação passou a `meta:webhook:last-verify`. |
| Onboarding e prova | Todas as rotas `/admin/whatsapp-onboard*` e `/api/admin/whatsapp-onboard*` (inclusive `delivery-proof`, start/callback/embedded-complete, bootstrap, finalize e a re-tentativa automática, voice-key, status) → **410 Gone**. As auditorias de voz só leitura passaram para `/api/admin/voice/audit` (mesma autenticação, sem operação de mensagem). |
| Broker `giro-whatsapp-bridge` | Lápide: qualquer rota (inclusive a antiga `/__zevanory/runtime` sem autenticação) → **410**, sem ler segredo, D1, KV nem fazer fetch. |
| Instagram/Facebook | **Somente manual** (decisão do dono). Não existe caminho de resposta automática (pública ou privada) nem chave para ligar; o handler só classifica a entrega e não carrega o token da Página. |
| Proteção estática | `tests/whatsapp-retirement.test.mjs` falha se aparecer, fora de `tests/`, qualquer gerador de webhook forjado/autoassinado (HMAC com app secret sobre payload de entrada, ou POST assinado para `/api/webhooks/meta`). |

**Por que 200 e não 410 no webhook:** a orientação de Webhooks da Meta é responder 200 OK rapidamente a toda
entrega; respostas diferentes de 2xx são reenviadas com recuo por dias e falhas repetidas marcam/desativam a
assinatura do app. 410 não tem significado especial para a Meta, é só mais uma falha, e o app
`1071149631917061` é o mesmo do Instagram/Facebook. Por isso: 200 só de confirmação, sem nenhum efeito.

## Passos do dono (NÃO executados por agente)

Faça na ordem. Nenhum passo abaixo foi executado pelo Claude.

### 1. Revogar o token do usuário do sistema (Meta Business Manager)
1. Abra <https://business.facebook.com/settings> e escolha o portfólio da ZEVANORY.
2. Menu lateral **Usuários → Usuários do sistema**.
3. Clique no usuário do sistema usado pela ZEVANORY (o que gerou o token do WhatsApp).
4. Clique em **Revogar tokens** (Revoke tokens) e confirme.
5. Ainda no usuário do sistema, aba **Ativos atribuídos**: remova a conta do WhatsApp (`4019600665012911`) se ainda aparecer.
6. Recomendado (o app secret assinava as provas forjadas): <https://developers.facebook.com/apps/1071149631917061/settings/basic/>
   → **Chave secreta do app → Redefinir**. Depois atualize o segredo `META_APP_SECRET` do Worker `zevanory` (passo 3),
   senão a verificação de assinatura dos webhooks do Instagram/Facebook passa a falhar.

### 2. Cancelar a assinatura do webhook do WhatsApp no app
1. Abra <https://developers.facebook.com/apps/1071149631917061/> .
2. Menu lateral **Webhooks** (em Produtos). No seletor de objeto, escolha **Whatsapp Business Account**.
3. Clique em **Cancelar assinatura deste objeto** (Unsubscribe from this object) e confirme.
   Não mexa nos objetos **Page**/**Instagram** (entregas deles seguem o tratamento normal; o atendimento é manual).
4. Se o produto **WhatsApp** ainda aparecer no menu do app: **WhatsApp → Configuração → Webhook → Gerenciar** e desmarque `messages`.

### 3. Remover os segredos do WhatsApp (somente nomes; nunca cole valores em chat)
Cloudflare (<https://dash.cloudflare.com>) → **Workers e Pages** → **zevanory** → **Configurações** → **Variáveis e segredos**:
- apague, se existirem: `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_VERIFY_TOKEN`, `META_WHATSAPP_IDENTITY_VERIFIED`;
- `WHATSAPP_CHANNEL_RETIRED`, `WHATSAPP_INSTANT_REPLY` e `META_SOCIAL_AUTOREPLY` não têm efeito no código; apague-as se existirem;
- clique em **Implantar** (Deploy) para salvar.

GitHub (<https://github.com/arbmsistone-lab/zevanory-public-mirror/settings/secrets/actions> e os Environments
`gh-pages-automacao`/`producao-critica`): apague `WHATSAPP_ACCESS_TOKEN` e `WHATSAPP_PHONE_NUMBER_ID` se existirem.

Registros do broker e do onboarding:
- **KV** `ZEVANORY_PRIVATE_ARTIFACTS` (Cloudflare → **Armazenamento e bancos de dados → KV** → namespace → **Visualizar**):
  apague `whatsapp-onboarding/runtime` (token, app secret e verify token cifrados), as chaves `whatsapp-onboarding/state/*`
  e `whatsapp:webhook:last-verify` (nome antigo; o novo registro de diagnóstico é `meta:webhook:last-verify`, expira em 24 h). **Antes**, confirme que a chave de voz Gemini existe por outro caminho
  (`GEMINI_API_KEY` ou o cofre `ai-vault:gemini`), porque o registro do onboarding também guarda a chave de voz.
- **D1** do broker (Cloudflare → **Armazenamento e bancos de dados → D1** → banco vinculado ao `giro-whatsapp-bridge` → **Console**):
  `DROP TABLE IF EXISTS zevanory_whatsapp_broker_runtime; DROP TABLE IF EXISTS zevanory_whatsapp_broker_oauth_state;`

### 4. Apagar o Worker `giro-whatsapp-bridge` (se existir)
O inventário de 13/10 (`ops/publishers.json`) não o encontrou na conta; confira:
Cloudflare → **Workers e Pages** → procure **giro-whatsapp-bridge** → **Configurações** → role até o fim →
**Excluir** (Delete) → digite o nome e confirme. Se existir um vínculo de serviço `WHATSAPP_BROKER` no Worker
`zevanory` (Configurações → Vínculos), remova-o também.

### 5. Workflows
Os seis workflows só de WhatsApp desativados via API em 23/10 continuam desativados. Não os reative.
Nesta PR: o job `production-proof` foi apagado de `whatsapp-delivery-recovery.yml`, `voice-render-proof.yml`
virou lápide (sem segredo, sem rede, só aviso em execução manual) e `whatsapp-closure-probe.yml` foi removido.

### Reabrir o canal (não recomendado)
Só com uma conta nova aprovada pela Meta, opt-in explícito, templates aprovados para mensagens fora da janela
de 24 h e ordem escrita do dono. Mesmo assim, nenhum teste pode gerar webhook assinado: a prova de entrega
real é só conversa iniciada por um cliente real.
