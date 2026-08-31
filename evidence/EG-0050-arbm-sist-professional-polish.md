# EG-0050 — ARBM SIST professional polish

Status: APROVADO COM RESTRIÇÕES
Data: 2026-08-31
Escopo: acabamento social, semântico, acessível e visual da landing /arbm-sist.

## Evidências independentes
1. Open Graph Protocol (facebook/open-graph-protocol): exige og:title, og:type, og:url e og:image; recomenda propriedades estruturadas de imagem, incluindo width, height e alt.
2. Google Search / SoftwareApplication: dados estruturados devem refletir conteúdo real e visível; não inventar avaliações, resultados ou sinais de reputação.
3. Governança interna ZEVANORY: brand-identity.test.mjs exige identidade self-hosted e rejeita mídia externa; gates comerciais permanecem fail-closed.

## Decisão
Aprovar: cartão social self-hosted 1200×630 PNG, summary_large_image, alt de imagem, theme-color, dateModified/inLanguage, dimensões explícitas do logo, aria-live para estado comercial, foco visível e reduced-motion.

## Restrições
- Não alterar public/index.html, vercel.json ou outros arquivos protegidos.
- Não habilitar venda, checkout, WhatsApp comercial ou mídia paga.
- Não enfraquecer guards existentes para aceitar recursos externos.
- Não declarar ranking, review, rating ou superioridade não provada.
- Publicação continua serializada e fora deste worktree até integração segura.
