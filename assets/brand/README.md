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
