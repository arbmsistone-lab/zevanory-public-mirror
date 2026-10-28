# Release 2 — evidência local do candidato

Esta pasta contém evidência reproduzível, sem credenciais e sem acesso a produção, do candidato consolidado iniciado em `gh-pages@a098d8802a184df02b362d46f08fb6c81b7382f9`.

- `matrix.json`: 18 rotas, cinco viewports (320, 360, 390, 768 e desktop) e dois temas; 180 combinações. Verifica HTTP, rolagem, clipping, axe, CTAs e campos de formulário. Inclui `/reembolso`, `/privacidade`, `/afiliados`, `/material-gratuito` e `/comprar/ZEV-IA-011`.
- `screenshots/`: capturas claras e escuras nas cinco larguras para as superfícies representativas e as rotas críticas acima.
- `manifest.json`: SHA final (`release_sha`), tamanho e SHA-256 de cada evidência, além do resumo da matriz.

Comandos de reprodução:

```text
python -B scripts/build_sales_public.py
node scripts/audit/sales-local-server.mjs 8791 sales-public
node scripts/audit/sales-scroll-gate.mjs http://127.0.0.1:8791 docs/evidence/release-2/matrix.json
COLOR_SCHEME=light node scripts/audit/sales-screenshots.mjs http://127.0.0.1:8791 docs/evidence/release-2/screenshots/light
COLOR_SCHEME=dark node scripts/audit/sales-screenshots.mjs http://127.0.0.1:8791 docs/evidence/release-2/screenshots/dark
node scripts/audit/release-2-evidence-manifest.mjs
```

O aceite do proprietário aplicável à matriz é: `APROVO ROLAGEM VERTICAL NAS PÁGINAS PÚBLICAS`. A evidência aprova rolagem vertical normal do documento; não autoriza rolagem horizontal, conteúdo cortado ou sobreposição.
