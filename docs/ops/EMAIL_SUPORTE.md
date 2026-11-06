# suporte@zevanory.api.br: o e-mail oficial chega ao proprietário

Com o WhatsApp banido pela Meta, `suporte@zevanory.api.br` passa a ser o único contato oficial do comprador. O CDC e o Decreto 7.962/2013 exigem um endereço eletrônico que funcione de verdade.

## Como era antes desta mudança (diagnóstico)

1. **DNS.** O MX do apex aponta para `inbound-smtp.sa-east-1.amazonaws.com`, que é o Resend Receiving (`worker/sandbox-proof-v2.mjs:8`). O Resend aceita e **guarda** e-mail para qualquer endereço do domínio. O Cloudflare Email Routing está desativado.
2. **Email Worker (`wrapped.email`, `worker/cloudflare-worker.compat.mjs`).** Trataria apenas `prova-sandbox@` e recusaria qualquer outro endereço com `mailbox_unavailable`. Como o MX não é da Cloudflare, esse handler **nunca é chamado**.
3. **Webhook `POST /api/webhooks/resend`** (handler legado em `worker/cloudflare-worker.recovered.mjs`, `src/http/webhookResend.mjs`). Ele tinha um encaminhador, mas:
   - precisava de `EMAIL_INBOUND_ENABLED=true` e de `RESEND_FORWARD_TO`, e nenhum dos dois existe no inventário do Worker (`docs/binding-audit-zevanory.md`). A resposta era sempre `503 email_inbound_disabled`;
   - e, mesmo ligado, lia o e-mail recebido com `RESEND_API_KEY`, que é uma chave só de envio e **não lê** recebidos (`worker/sandbox-proof-v2.mjs`, comentário em `resendGet`). A resposta seria `503`.
4. **Resultado.** As mensagens para `suporte@` ficavam somente no painel Resend → Receiving. Ninguém era avisado.

## O que esta mudança faz

`worker/support-email-forward.mjs`, chamado no início do `fetch` do Worker para `POST /api/webhooks/resend` e drenado pelo cron horário:

1. **Assinatura.** Verifica a assinatura Svix com o segredo existente `RESEND_WEBHOOK_SECRET`. Segredo ausente, assinatura errada ou carimbo de tempo com mais de 5 minutos de diferença recebem **401** e nada é feito (fail-closed).
2. **Escopo.** Trata somente `email.received` para `suporte@` ou `contato@`. Os demais eventos (entregas e bounces dos e-mails enviados) e destinatários (incluindo `prova-sandbox@`) seguem para o handler legado sem mudança.
3. **Outbox durável** (PostgreSQL, tabela `zevanory_support_inbound`, uma linha por `email_id` do Resend, **sem conteúdo nem endereço**):
   `forward_pending` → (encaminhou) → `ack_pending` → (confirmou) → `done`; ou `forward_pending` → `done` quando não cabe confirmação.
   - Cada passo roda sob lease de 2 minutos, com recuo exponencial (2, 4, 8… até 360 min) e Idempotency-Key própria no Resend (`support-fwd/<id>`, `support-ack/<id>`).
   - Uma falha deixa o passo pendente; o reenvio do webhook pelo Resend e o **cron horário** retomam.
   - **Orçamento de tentativas**, conferido no SQL do lease e de novo no código antes de **cada** chamada ao Resend: no máximo 10 tentativas por passo e nenhuma tentativa depois de **23 h** da chegada. O Resend guarda cada Idempotency-Key por **24 horas** ("Idempotency keys are kept in the system for 24 hours", https://resend.com/docs/dashboard/emails/idempotency-keys); assim toda repetição fica dentro da janela e não pode duplicar o envio. Fora do orçamento a linha vira `forward_dead`/`ack_dead` sem nenhum efeito externo.
   - Se o Resend responder `409 invalid_idempotent_request` ao encaminhamento, a mesma chave já foi aceita antes (as URLs temporárias dos anexos mudam a cada leitura): o encaminhamento é considerado feito e não é repetido.
   - **Alertas ao dono**, enviados ao mesmo destino do encaminhamento, de `suporte@`, só com contagens (sem conteúdo, assunto, endereço ou id). São dois: (a) mensagens que viraram `*_dead`; (b) fila atrasada, com 5 ou mais pendentes ou a mais antiga pendente há 2 h ou mais. Cada tipo sai no máximo 1 vez a cada 6 h; a vaga é reservada atomicamente e liberada se o envio falhar.
   - O webhook responde **200** assim que o registro durável existe; a partir daí o outbox garante as tentativas.
   - Nenhuma escrita em KV.
4. **Configuração obrigatória antes de aceitar.** Faltando destino, chave de envio, **chave de leitura do Resend**, `LEAD_PRIVACY_SECRET` ou banco, o webhook responde 503 **sem** registrar nada, e o Resend tenta de novo depois. Nenhuma mensagem é aceita sem que possa ser lida.
5. **Pseudônimo do remetente** com HMAC-SHA256 usando o secret existente `LEAD_PRIVACY_SECRET` (com separação de domínio própria). Sem esse secret o fluxo responde 503: nunca usa hash simples.
6. **Conteúdo.** Relido no Resend pelo id com a chave de recebimento (`RESEND_RECEIVING_API_KEY` ou chave KV privada `sandbox-config:resend-receiving-key`).
7. **Encaminhamento ao dono** (destino só em configuração):
   - remetente `suporte@zevanory.api.br`, assunto `[ZEVANORY suporte] …`, **Reply-To = o cliente**;
   - HTML higienizado por lista de permissão: sem script, estilo, iframe, formulário, imagem, atributos `on*` ou links `javascript:`/`data:`; HTML acima de 512 KB (entrada) ou 200 KB (saída) é omitido; texto cortado em 100 KB;
   - anexos: no máximo 5, até 10 MB cada e 20 MB no total; tamanho desconhecido e executáveis (`.exe`, `.js`, `.bat`, macros, `.apk`, `.iso`…) são recusados. O que ficar de fora é avisado no corpo e continua visível no painel Resend → Receiving.
8. **Confirmação ao cliente**, de `suporte@` com Reply-To `suporte@` (o endereço do dono nunca aparece):
   - nunca para auto-resposta, bounce, lista, no-reply, o próprio domínio ou o próprio dono;
   - cota reservada **atomicamente** no mesmo comando SQL que muda o estado: 1 por remetente por dia (UTC) e 30 por dia no total;
   - `SUPPORT_AUTO_ACK=false` desliga.
9. **Logs** sem conteúdo, assunto nem endereços, apenas o estado.

Respostas do webhook (aparecem no log do webhook no Resend):

| HTTP | Corpo | Significado / ação |
|---|---|---|
| 200 | `state: done` | Encaminhado (e confirmado, quando cabia) |
| 200 | `state: forward_pending` / `ack_pending` | Registrado; o passo falhou e será retomado pelo cron |
| 200 | `duplicate: true` | Reenvio do mesmo e-mail; nada é repetido |
| 401 | `webhook_auth_failed` | Segredo do webhook não confere (ver passo 4) |
| 503 | `support_forward_unconfigured` + `missing` | Falta `forward_to` (passo 1), `privacy_secret` (passo 2), `receiving_key` (passo 3), `send_key` ou `database`. Nada foi registrado; o Resend repete |
| 503 | `support_outbox_unavailable` | PostgreSQL indisponível; o Resend tenta de novo sozinho |

Para consultar pendências: `select state, count(*) from zevanory_support_inbound group by state;` (sem conteúdo).

## Correções P0 de 24/10/2026 (primeira mensagem real)

Uma mensagem real do suporte do WhatsApp chegou em 24/10 e ficou parada em `forward_retry` com `content_unavailable`, sem novas tentativas. Correções:

1. **Motivo da falha de leitura.** O conteúdo vem de `GET /emails/receiving/{email_id}`; o webhook traz só metadados ("Webhooks do not include the email body, headers, or attachments, only their metadata", https://resend.com/docs/dashboard/receiving/get-email-content e https://resend.com/docs/api-reference/emails/retrieve-received-email). O motivo agora fica no log (`SUPPORT_EMAIL ... "reason"`) e na coluna `last_reason`, sem dado pessoal:

   | Motivo | Causa provável | Ação |
   |---|---|---|
   | `content_http_401_key_permission` / `content_http_403_key_permission` | A chave em `sandbox-config:resend-receiving-key` é **só de envio** (Sending access), foi revogada ou é **de outra conta** Resend | Trocar pela chave Full access da conta que recebe o domínio (passo 3). O dono recebe um alerta "chave de leitura do Resend recusada" (1 a cada 6 h) |
   | `content_http_404_not_found` | Id ou endpoint errado, ou a mensagem é de outra conta | Conferir em Resend → Emails → Receiving se a mensagem existe **na mesma conta da chave** |
   | `content_http_5xx`, `content_timeout`, `content_network` | Falha temporária do Resend | Nada: o outbox tenta de novo |
   | `content_http_429_rate_limited` | Limite de requisições | Nada: recuo exponencial |

2. **Retentativas no cron.** O dreno rodava dentro do cron horário, junto com várias tarefas que disputam as 50 subrequisições por invocação do Workers Free, e não registrava a própria execução. Agora ele roda **primeiro** no cron horário (`0 * * * *`), numa **invocação própria** (binding `SELF` → `POST /api/internal/support/outbox/drain`). A autenticação é um HMAC (`LEAD_PRIVACY_SECRET`) sobre a string canônica `v1\nPOST\n/api/internal/support/outbox/drain\n<minuto>\n<nonce>`, com nonce aleatório de 128 bits. Só valem o minuto atual e o anterior, nunca futuro. O corpo precisa ser vazio. O nonce é consumido atomicamente no PostgreSQL (`zevanory_support_drain_nonces`, limpo após 1 h) **antes** do dreno; replay recebe 409, sem leitura de fila e sem chamada ao Resend. O cabeçalho `x-zevanory-internal` não autentica. Cada execução registra uma linha só de contagens: `SUPPORT_EMAIL {"event":"drain",...}` e `support_outbox {...}`.
3. **Sem confirmação para provedores automáticos.** `support@support.whatsapp.com` (comparação exata, sem diferenciar maiúsculas) está na lista de supressão da aplicação: a mensagem é encaminhada ao dono, mas nunca recebe confirmação automática (`ack_status = skipped_automated_provider`). A supressão global do Resend não é usada.
4. **Responder ao chamado do WhatsApp.** Quando o remetente (campo `from` do metadado do Resend, nunca um cabeçalho do corpo) é `support@support.whatsapp.com` e o `reply_to` do metadado tem **exatamente um** endereço que casa com `^[0-9]{5,20}@support\.whatsapp\.com$`, o Reply-To do encaminhamento passa a ser esse endereço, e "Responder" no Gmail vai ao chamado. Casos que continuam com o remetente:
   - domínio parecido ou subdomínio;
   - `+alias`;
   - letras no número;
   - dois destinatários;
   - quebra de linha (injeção CRLF);
   - menos de 5 ou mais de 20 dígitos;
   - Reply-To que só aparece no cabeçalho.
5. **Remetente normalizado.** Caixa, nome de exibição e espaços são normalizados. Um `from` com mais de um endereço ou com quebra de linha é inválido: o dono recebe a mensagem, mas sem Reply-To e sem confirmação.
6. **Encaminhamento obrigatório antes de qualquer "skipped".** A linha só vira `done`/`skipped_automated_provider` depois que o encaminhamento ao dono foi aceito pelo Resend.
7. **Classes de falha e orçamentos separados.**
   - Leitura e envio têm contadores próprios (`read_failures`, `send_failures`), até 10 cada **por mensagem**, somados entre encaminhamento e confirmação (não zeram na passagem para `ack_pending`). Falhas de leitura não gastam tentativas de envio.
   - Esgotar o orçamento durante a confirmação leva a `ack_dead`, sem desfazer o encaminhamento: `forward_id` e `forwarded_at` ficam, não há novo encaminhamento e o alerta de morte sai uma única vez.
   - `attempts` não é orçamento de falhas: conta os leases do passo atual e só corta laços de lease sem conclusão (invocação derrubada).
   - 404 na leitura é transitório por até 30 min da chegada e depois vira permanente (`content_http_404_not_found_permanent`).
   - 400/422 são permanentes.
   - 401/403 indicam configuração: repete e alerta o dono.
   - 429, 5xx, timeout, DNS (`network_dns`) e conexão derrubada (`network_reset`) são transitórios.
8. **Cron vermelho com fila vencida.** Se houver mensagem pendente há 2 h ou mais, a execução horária termina com erro `support_backlog_overdue` (depois das demais tarefas). Os logs do cron trazem só contagens e categorias fechadas.
9. **Corpo não confiável.** Endereços ou "instruções" no texto/HTML da mensagem nunca mudam destinatário, supressão, estado ou fluxo.

## Passos do proprietário

O código só passa a valer depois do deploy do Worker. O merge em `gh-pages` dispara o workflow `ZEVANORY central production deploy`.

### 1. Definir o destino (o seu Gmail)

**Recomendado: chave no KV privado.** Não ocupa nenhum dos slots de variável do Worker; o plano Free limita a 64 e o deploy barra acima de 60 (`scripts/deploy/check-binding-budget.py`).

1. Abra o painel da Cloudflare → **Storage & databases** → **Workers KV**.
2. Abra o namespace com o ID `728a45738e4047f29bcb89934fd533c1`, que é o binding `ZEVANORY_PRIVATE_ARTIFACTS`.
3. Clique em **KV Pairs** → **Add entry**.
4. Preencha:
   - Key: `support-config:forward-to`
   - Value: `zevanory@gmail.com`
5. Salve. É uma única escrita, feita uma vez só.

Alternativa por terminal: `npx wrangler kv key put "support-config:forward-to" "zevanory@gmail.com" --namespace-id 728a45738e4047f29bcb89934fd533c1 --remote`

**Alternativa: secret `SUPPORT_FORWARD_TO`.** Caminho: Workers & Pages → `zevanory` → **Settings** → **Variables and Secrets** → **Add** → Type **Secret**. Esse secret tem prioridade sobre o KV, mas ocupa 1 slot. Confira antes se o orçamento de variáveis ainda tem folga.

Um endereço `@zevanory.api.br` é recusado como destino, porque criaria um laço.

### 2. Confirmar o secret `LEAD_PRIVACY_SECRET`

Ele já existe no Worker (é o mesmo da lista de espera). Confira em Workers & Pages → `zevanory` → **Settings** → **Variables and Secrets** que `LEAD_PRIVACY_SECRET` aparece (tipo Secret, 32+ caracteres). Não crie um novo nem troque o valor.

### 3. Confirmar a chave de recebimento do Resend (Full access, mesma conta)

No mesmo namespace KV, a chave `sandbox-config:resend-receiving-key` precisa existir. Não abra o valor.

Se ela não existir, crie no Resend uma API key com permissão **Full access** e guarde-a no secret `RESEND_RECEIVING_KEY` do ambiente GitHub `sandbox-financial-approved`. Depois rode manualmente o workflow **Sandbox receiving key to worker**.

**Se o log mostrar `content_http_401_key_permission` ou `content_http_403_key_permission`** (ou chegar o alerta "chave de leitura do Resend recusada"), a chave guardada não lê mensagens recebidas. Troque-a assim:

1. No Resend, confira no canto superior esquerdo que está na conta **zevanory**, a mesma que lista a mensagem em **Emails → Receiving**.
2. Abra **API Keys** → **Create API Key**. Nome `zevanory-receiving`, Permission **Full access**, Domain **All domains** → **Add**. Copie a chave (`re_...`); ela só aparece uma vez.
3. No GitHub, abra o repositório → **Settings** → **Environments** → `sandbox-financial-approved` → **Environment secrets** → `RESEND_RECEIVING_KEY` → **Update** → cole a chave.
4. Em **Actions**, rode manualmente o workflow **Sandbox receiving key to worker** e aprove o ambiente. O workflow só grava se `GET /emails/receiving?limit=1` responder 200 com essa chave.
5. Não é preciso deploy: a próxima execução do cron horário relê a chave no KV e retoma as mensagens pendentes (dentro de 23 h da chegada).

### 4. Confirmar que o Resend recebe para `suporte@` e chama o webhook

Documentação oficial:

- Receiving: https://resend.com/docs/dashboard/receiving/introduction
- Domínio próprio: https://resend.com/docs/dashboard/receiving/custom-domains
- Webhook de recebimento: https://resend.com/docs/dashboard/receiving/create-receiving-webhook

1. Abra o Resend → **Domains** → `zevanory.api.br`.
2. Na seção de recebimento, confirme:
   - o toggle **Enable Receiving** está ligado;
   - o registro MX está **Verified**.

   O Resend recebe para **qualquer endereço** de um domínio com recebimento verificado. Não existe rota por endereço para criar: `suporte@` e `contato@` já estão cobertos.
3. Abra o Resend → **Webhooks** e procure o endpoint `https://zevanory.api.br/api/webhooks/resend`.
   - **Se ele existe:** abra → **Edit** → marque o evento **`email.received`**, mantendo os eventos que já estavam marcados → salve. Use o mesmo endpoint: cada endpoint tem um segredo próprio, e o Worker confere apenas `RESEND_WEBHOOK_SECRET`.
   - **Se ele não existe:** clique em **Add Webhook** → URL `https://zevanory.api.br/api/webhooks/resend` → selecione `email.received` → **Add**. Em seguida, copie o **Signing secret** (`whsec_...`) e grave-o no secret `RESEND_WEBHOOK_SECRET`. O caminho é Workers & Pages → `zevanory` → Settings → Variables and Secrets → editar. Esse secret já existe, então a mudança não ocupa slot novo.

### 5. Responder como `suporte@` (obrigatório antes de divulgar o canal)

Sem este passo, "Responder" no Gmail envia a resposta a partir de `zevanory@gmail.com` e expõe o seu e-mail pessoal ao cliente. Configure uma vez:

1. No Gmail, abra **Configurações** → **Contas e importação** → **Enviar e-mail como** → **Adicionar outro endereço**.
2. Nome `ZEVANORY suporte`, e-mail `suporte@zevanory.api.br`. **Desmarque** "Tratar como um alias".
3. Preencha os dados de SMTP (https://resend.com/docs/send-with-smtp):
   - servidor: `smtp.resend.com`
   - porta: 465 (SSL) ou 587 (TLS)
   - usuário: `resend`
   - senha: uma API key do Resend com permissão de envio
4. O código de confirmação do Gmail chega a `suporte@` e é encaminhado para o próprio Gmail por este fluxo. Confirme.
5. Em **Enviar e-mail como**, marque **"Responder da mesma forma que a mensagem foi enviada"** e torne `suporte@zevanory.api.br` o padrão.

### 6. Teste real ponta a ponta (depois do deploy)

Os testes automáticos usam Resend e banco falsos; o teste real é feito pelo proprietário depois que o deploy estiver no ar:

1. De uma conta de e-mail pessoal que **não** seja `zevanory@gmail.com`, envie para `suporte@zevanory.api.br` uma mensagem com o assunto `teste suporte 1` e um PDF pequeno anexado.
2. Em até cerca de 1 minuto, o Gmail `zevanory@gmail.com` deve receber `[ZEVANORY suporte] teste suporte 1`, de `suporte@zevanory.api.br`, com o PDF. Se não aparecer, olhe também a pasta Spam e crie um filtro "De: suporte@zevanory.api.br → Nunca enviar para spam".
3. No Gmail, clique em **Responder**: o "Para" deve ser a conta de teste e o "De" deve ser `suporte@zevanory.api.br`. Envie a resposta e confira na conta de teste que ela chegou **de** `suporte@zevanory.api.br` (sem nenhum `gmail.com` visível).
4. A conta de teste deve ter recebido uma única "Recebemos sua mensagem — ZEVANORY". Uma segunda mensagem da mesma conta no mesmo dia é encaminhada, mas não gera outra confirmação.
5. No Resend → **Webhooks** → endpoint, o evento `email.received` deve mostrar **200** com `state: done`. Se mostrar 401 ou 503, veja a tabela acima.
6. Repita para `contato@zevanory.api.br`.
