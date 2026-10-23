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

`worker/support-email-forward.mjs`, chamado no início do `fetch` do Worker para `POST /api/webhooks/resend`:

1. Verifica a assinatura Svix com o segredo existente `RESEND_WEBHOOK_SECRET`. Segredo ausente, assinatura errada ou carimbo de tempo com mais de 5 minutos de diferença recebem **401** e nada é feito (fail-closed).
2. Trata somente o evento `email.received` para `suporte@` ou `contato@`. Os demais eventos (entregas e bounces dos e-mails enviados) e os demais destinatários (incluindo `prova-sandbox@`) seguem para o handler legado sem nenhuma mudança.
3. Elimina duplicatas pelo `email_id` do Resend no PostgreSQL (tabela `zevanory_support_inbound`, que não guarda conteúdo e usa só o hash do remetente). Não faz **nenhuma escrita em KV**. Se o Resend reenviar a mesma mensagem, ela não é encaminhada de novo.
4. Lê o conteúdo com a chave de recebimento: `RESEND_RECEIVING_API_KEY` ou, quando ela não existe, a chave KV privada `sandbox-config:resend-receiving-key`, que já é gravada pelo workflow "Sandbox receiving key to worker".
5. Encaminha a mensagem ao destino configurado pelo dono:
   - remetente `suporte@zevanory.api.br`;
   - assunto com o prefixo `[ZEVANORY suporte]`;
   - **Reply-To = o cliente**, para que "Responder" no Gmail vá direto a ele;
   - os anexos vão junto.
6. Responde ao cliente com uma confirmação automática somente quando não há risco de laço:
   - nunca para auto-resposta, bounce, lista, no-reply, o próprio domínio ou o próprio dono;
   - no máximo 1 por remetente a cada 24 h e 30 por dia no total.

   Para desligar, defina `SUPPORT_AUTO_ACK=false`.
7. Os logs não registram conteúdo, assunto nem endereços, apenas o estado.

Códigos de resposta (aparecem no log do webhook no Resend):

| HTTP | `error` | Significado / ação |
|---|---|---|
| 200 | — | Encaminhado (`forwarded:true`) ou duplicado já tratado (`duplicate:true`) |
| 401 | `webhook_auth_failed` | Segredo do webhook não confere (ver passo 3) |
| 503 | `support_forward_unconfigured` | Destino não configurado (ver passo 1) |
| 503 | `support_content_unavailable` | Chave de recebimento ausente ou inválida (ver passo 2) |
| 503 | `support_dedupe_unavailable` | PostgreSQL indisponível; o Resend tenta de novo sozinho |
| 503 | `support_forward_failed` | Envio pelo Resend falhou; o Resend tenta de novo sozinho |

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

### 2. Confirmar a chave de recebimento do Resend

No mesmo namespace KV, a chave `sandbox-config:resend-receiving-key` precisa existir. Não abra o valor.

Se ela não existir, crie no Resend uma API key com permissão **Full access** e guarde-a no secret `RESEND_RECEIVING_KEY` do ambiente GitHub `sandbox-financial-approved`. Depois rode manualmente o workflow **Sandbox receiving key to worker**.

### 3. Confirmar que o Resend recebe para `suporte@` e chama o webhook

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

### 4. Testar

1. De uma conta de e-mail pessoal que **não** seja `zevanory@gmail.com`, envie para `suporte@zevanory.api.br` uma mensagem com o assunto `teste suporte 1`.
2. Em até cerca de 1 minuto, o Gmail `zevanory@gmail.com` deve receber `[ZEVANORY suporte] teste suporte 1`, de `suporte@zevanory.api.br`. Se não aparecer, olhe também a pasta Spam. Para evitar que isso se repita, crie um filtro "De: suporte@zevanory.api.br → Nunca enviar para spam".
3. No Gmail, clique em **Responder**. O campo "Para" deve mostrar o endereço da conta pessoal de teste.
4. A conta pessoal deve receber "Recebemos sua mensagem — ZEVANORY".
5. No Resend → **Webhooks** → endpoint, o evento `email.received` deve mostrar a resposta **200**. Se mostrar 401 ou 503, veja a tabela acima.
6. Repita o teste para `contato@zevanory.api.br`.

### 5. (Opcional) Responder como `suporte@` em vez do Gmail pessoal

Por padrão, a resposta sai de `zevanory@gmail.com`. Para responder como `suporte@zevanory.api.br`:

1. No Gmail, abra **Configurações** → **Contas e importação** → **Enviar e-mail como** → **Adicionar outro endereço**.
2. Informe `suporte@zevanory.api.br`.
3. Preencha os dados de SMTP (https://resend.com/docs/send-with-smtp):
   - servidor: `smtp.resend.com`
   - porta: 465 (SSL) ou 587 (TLS)
   - usuário: `resend`
   - senha: uma API key do Resend com permissão de envio
4. O código de confirmação do Gmail chega a `suporte@` e é encaminhado para o próprio Gmail por este fluxo.
