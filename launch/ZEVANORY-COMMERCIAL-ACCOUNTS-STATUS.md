# ZEVANORY - Contas comerciais oficiais

Identidade institucional:
- Marca: ZEVANORY
- Cadastro/ownership operacional: zevanory@gmail.com
- E-mail profissional: contato@zevanory.api.br
- Site: https://zevanory.api.br
- WhatsApp oficial: +55 88 9234-0423
- Handle preferencial: @zevanory

Estado verificado em 2026-09-01:
- Site proprio: ATIVO em producao no dominio oficial.
- E-mail/Resend: OPERACIONAL; MX, SPF, DKIM e DMARC publicados; aliases profissionais ativos.
- Mercado Pago: credenciais PROD instaladas como secrets; webhook PROD configurado; merchant identity verificada; readiness sem blocker de pagamento.
- Facebook: Pagina oficial NOVA ZEVANORY criada no portfolio empresarial Zevanory; System User `ZEVANORY Automation` vinculado; Page ID `1249902628211703`; token de producao instalado; identidade `Zevanory` confirmada pela Graph API. Pagina legada Central Giro de Ofertas permanece separada.
- Instagram: conta ZEVANORY existente, mas a Pagina Meta ainda retorna `instagram_business_account=null`; login/OAuth/2FA e vinculo ao portfolio permanecem externos e pendentes.
- WhatsApp: WABA oficial `1765777697944833` e Phone Number ID `1207377742466921` confirmados para `+55 88 9234-0423`; System User token instalado em producao; provider status Conectado/qualidade GREEN. Meta ainda retorna `verified_name=Giro Local`, portanto a migracao publica do display name nao esta concluida. `META_APP_SECRET` e confirmacao final do webhook inbound ainda pendentes.
- YouTube: canal ZEVANORY existente e conectado ao Metricool; analytics reais retornados pelo conector. OAuth direto da ZEVANORY continua ausente.
- Metricool: marca id 6742761 ativa; YouTube conectado com channel id UCMl8-SxMVv77S2tz2H63P3A.
- TikTok: adapter tecnico implementado; token externo ausente; readiness exige content source verified=true e consentimento.
- LinkedIn: adapter tecnico implementado; token/author URN externos ausentes.
- Afiliados: adapter HTTPS/idempotente implementado; provider/webhook/token externos ausentes.

Governanca:
- ARBM SIST e produto do portfolio, nunca identidade proprietaria das contas.
- Nenhuma senha, CAPTCHA, SMS, e-mail de verificacao, MFA, KYC ou aceite juridico sera contornado.
- Canais externos so podem ser chamados de conectados quando houver evidencia do provedor; adapter implementado nao equivale a canal ativo.
- Gates comerciais globais permanecem OFF ate fechamento do release publico e cutover controlado.