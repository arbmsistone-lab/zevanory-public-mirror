# ZEVANORY - Pacote de ativacao de canais

Identidade canonica:
- Marca: ZEVANORY
- Site: https://zevanory.api.br
- Cadastro: zevanory@gmail.com
- Handle preferencial quando disponível: @zevanory`r`n- Instagram real confirmado: @zevanory_`r`n- TikTok real registrado: @zevanory3
- WhatsApp: +55 88 9234-0423

Canais confirmados:
- Instagram: https://instagram.com/zevanory_
- YouTube: https://youtube.com/@zevanory
- E-mail principal: contato@zevanory.api.br
- Suporte: suporte@zevanory.api.br
- Vendas: vendas@zevanory.api.br
- Financeiro: financeiro@zevanory.api.br

Resend:
- Dominio: zevanory.api.br
- Webhook alvo: https://zevanory.api.br/api/webhooks/resend
- Evento necessario: email.received
- Forward: zevanory@gmail.com
- From: ZEVANORY <contato@zevanory.api.br>
- Ativar EMAIL_INBOUND_ENABLED somente apos DNS + API key + webhook secret validados.

Meta / Facebook / Instagram / WhatsApp:
- Categoria preferida: Software / Tecnologia
- Bio: Tecnologia, automacao, produtos e servicos digitais com foco em execucao segura e resultados reais.
- Facebook Page ZEVANORY: `1249902628211703`, identidade confirmada via Graph API.
- WABA oficial: `1765777697944833`; Phone Number ID: `1207377742466921`; numero `+55 88 9234-0423`; qualidade GREEN.
- `META_ACCESS_TOKEN` e `WHATSAPP_ACCESS_TOKEN` instalados como Secrets de producao; `META_VERIFY_TOKEN` presente.
- Instagram ainda nao esta vinculado a Pagina: provider retorna `instagram_business_account=null`; nao chamar de conectado antes do login/OAuth e prova do username `zevanory`.
- `META_APP_SECRET` ainda e necessario para certificar assinatura HMAC do webhook inbound.
- Meta ainda retorna `verified_name=Giro Local`; concluir a identidade publica do WhatsApp como ZEVANORY antes do cutover.

YouTube:
- Canal: ZEVANORY
- Handle: @zevanory
- Descricao: Canal oficial da ZEVANORY para produtos, servicos, demonstracoes e conteudo tecnico.

Pagamentos / identidade do merchant:
- Credenciais de gateway nao autorizam ativacao sozinhas.
- PAYMENT_MERCHANT_IDENTITY_VERIFIED deve permanecer false ate a conta do provedor ser conferida para a operacao ZEVANORY.
- Nao reutilizar automaticamente conta identificada como GIRO LOCAL.
- Somente apos verificacao documental/operacional do titular, definir PAYMENT_MERCHANT_IDENTITY_VERIFIED=true.
- Depois disso ainda permanecem obrigatorios credenciais, reconciliacao real e gates de pre-venda.
