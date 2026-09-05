# EG-0061 — Brand Identity Live Audit — 2026-09-05

Objetivo: impedir que 12/12 operacional seja confundido com 12/12 de identidade visual.

Evidencia real lida server-side dos provedores:
- Facebook: nome `Zevanory` confirmado; foto publica retornou asset generico/default e exige correcao visual.
- Instagram: username `zevanory_`, nome `ZEVANORY`, bio e website ZEVANORY confirmados.
- WhatsApp: numero oficial e qualidade GREEN confirmados; `verified_name` ainda retorna `Giro Local`.
- YouTube: canal ID canonico e titulo `ZEVANORY` confirmados.
- TikTok: identidade publica conhecida, mas API de producao segue sem credencial de publicacao auditada.
- LinkedIn: fallback atual aponta para perfil pessoal do responsavel, nao para pagina corporativa ZEVANORY comprovada.
- Nuvemshop: storefront ZEVANORY existe; identidade visual completa ainda exige prova de perfil/storefront.
- Mercado Livre: integracao esta operacional, mas identidade visual publica precisa prova separada.

Regra nova: nenhum canal externo recebe `BRAND_IDENTITY_VERIFIED=true` sem prova real de nome + logo/foto + descricao/bio apropriada.

O gate e fail-closed e independente do gate 12/12 operacional.