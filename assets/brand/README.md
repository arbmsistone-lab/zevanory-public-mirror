# ZEVANORY | Kit de marca oficial

Fonte canônica: `sales-public/brand/zevanory-logo-dark.svg` (logo horizontal) e `sales-public/brand/zevanory-mark.svg` (símbolo Z). Cópias fiéis em `assets/brand/`. Não alterar os originais.

## Exportação

`python scripts/build-brand-assets.py` gera `assets/brand/export/`, espelha PNGs públicos em `sales-public/brand/export/` e grava as hashes aprovadas em `worker/brand-approved.mjs`.

Avatares: `avatar-400.png` e `avatar-800.png` (mesma foto de perfil, margem para círculo). Capas: Bluesky 1500×500, YouTube 2560×1440 (elementos principais dentro da área central de 1546×423), Facebook 1640×624. Amostras de mídia: três posts 1080², pin 1000×1500, short 1080×1920 e cards link/blog/email 1200×630.

Os arquivos não implicam que qualquer perfil foi atualizado. Apenas comprovante de API bem-sucedida e readback do perfil permitem o evento `profile_updated` no painel. Falha, ausência de credencial, permissão ou API exige estado `depende_do_dono`, nunca sucesso inventado.

## Portas de saída

As chamadas de publicação de imagens devem usar `validateOutboundBrandImage` no `worker/brand-kit.mjs`. Aceita apenas uma URL HTTPS conhecida em `/brand/export/`, dimensão exata por canal, até 1MB e SHA-256 dos PNGs renderizados a partir da arte oficial. Fonte, paleta e marca são verificadas no build. Não é permitido publicar imagens desconhecidas, mesmo que estejam no domínio oficial.

## Depende do dono / edição manual (quando a API não oferecer a permissão)

- **Bluesky:** https://bsky.app/settings/account (perfil); a atualização automática exige credenciais e prova AT Protocol
- **YouTube:** https://studio.youtube.com/ → Personalização → Identidade visual (imagem e banner)
- **Facebook:** https://www.facebook.com/ → Página → Editar foto de perfil e capa, conforme permissões
- **Instagram:** https://www.instagram.com/accounts/edit/ (foto de perfil; sem capa)
- **Telegram:** https://t.me/zevanory → administrar canal → editar foto, caso o bot não seja administrador com direito de alterar informações
- **Pinterest:** https://www.pinterest.com/settings/ → editar perfil/capa, sujeito às funcionalidades da conta
- **WhatsApp Business:** aplicativo WhatsApp Business → Ferramentas comerciais → Perfil comercial (foto)
- **Google Perfil da Empresa:** https://business.google.com/ → Editar perfil → Fotos → Logotipo, se a empresa possuir perfil e acesso

Nenhuma ação externa deve ocorrer sem permissão adequada; upload manual não equivale a `profile_updated` comprovado.

Os PNGs aprovados são servidos por `https://zevanory.api.br/brand/export/<arquivo>.png`: o deploy central copia e certifica todos os hashes para `public/brand/export/` antes de publicar. `vendas.zevanory.api.br` continua sendo o endereço obrigatório do rodapé, não a dependência de CDN.

## Textos prontos para os perfis (sem fingir publicação)

**Identidade universal:** nome `ZEVANORY`; avatar `https://zevanory.api.br/brand/export/avatar-800.png` (400×400 também em `avatar-400.png`). O perfil deve usar a mesma imagem, não uma recriação. Em perfis comerciais, preencher os campos próprios com a razão social, CNPJ e contatos aprovados.

- **Instagram** (bio de até 150 caracteres, sem banner):
  `IA na prática para pequenos negócios. Criada por Renan Bitu, Várzea Alegre/CE. https://vendas.zevanory.api.br/?utm_source=instagram&utm_medium=profile`
  Foto: avatar-800; editar https://www.instagram.com/accounts/edit/
- **Facebook**:
  `IA na prática para pequenos negócios. Criada por Renan Bitu, Várzea Alegre/CE. https://vendas.zevanory.api.br/?utm_source=facebook&utm_medium=profile`
  Foto: avatar-800; capa: banner-facebook.png (1640×624); editar na página com permissões de administrador https://www.facebook.com/profile.php?id=1249902628211703
- **YouTube**:
  `IA na prática para pequenos negócios. Criada por Renan Bitu, Várzea Alegre/CE. https://vendas.zevanory.api.br/?utm_source=youtube&utm_medium=profile`
  Foto: avatar-800; capa: banner-youtube.png (2560×1440, conteúdo central 1546×423); editar https://studio.youtube.com/
- **Pinterest**:
  `IA na prática para pequenos negócios. Criada por Renan Bitu, Várzea Alegre/CE. https://vendas.zevanory.api.br/?utm_source=pinterest&utm_medium=profile`
  Foto: avatar-800; pin: pin.png; editar https://www.pinterest.com/settings/
- **WhatsApp Business** (seção Sobre, texto abreviado para caber):
  `IA prática para pequenos negócios. Renan Bitu · Várzea Alegre/CE.`
  Nome: ZEVANORY; foto: avatar-800; URL no campo Site: `https://vendas.zevanory.api.br/?utm_source=whatsapp&utm_medium=profile`; editar pelo aplicativo oficial em Ferramentas comerciais → Perfil comercial
- **Google Perfil da Empresa**: nome `ZEVANORY` apenas se corresponder à identidade empresarial real; logotipo: avatar-800; descrição sem links ou alegações proibidas: `IA na prática para pequenos negócios. Marca criada por Renan Bitu, em Várzea Alegre/CE.` URL no campo Website: `https://vendas.zevanory.api.br/?utm_source=google&utm_medium=profile`; editar https://business.google.com/
- **Telegram**: nome `ZEVANORY`; avatar-800; descrição e UTM fornecidos por `OFFICIAL_SOCIAL_PROFILE.telegram`; acesso https://t.me/zevanory
- **Bluesky**: nome `ZEVANORY`; avatar-800; capa banner-bluesky.png (1500×500); bio e UTM fornecidos por `OFFICIAL_SOCIAL_PROFILE.bluesky`; editar https://bsky.app/settings/account

**Pendências reais:** sem readback do provedor, avatar/capa/bio é `depende_do_dono` ou `pendente_conciliacao`. Não registrar `profile_updated` ou `post_published` com base em configuração local.
