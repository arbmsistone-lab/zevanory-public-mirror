# ZEVANORY - Pacote de ativacao de canais

Identidade canonica:
- Marca: ZEVANORY
- Site: https://zevanory.api.br
- Cadastro: zevanory@gmail.com
- Handle preferencial: @zevanory
- WhatsApp: +55 88 99234-0423

Canais confirmados:
- Instagram: https://instagram.com/zevanory
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

Meta / Instagram:
- Categoria preferida: Software / Tecnologia
- Bio: Tecnologia, automacao, produtos e servicos digitais com foco em execucao segura e resultados reais.
- Conectar Instagram a uma Pagina ZEVANORY antes de habilitar Graph API/Metricool.

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