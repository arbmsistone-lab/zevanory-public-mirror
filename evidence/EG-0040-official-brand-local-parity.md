# EG-0040 — Identidade oficial e paridade local

Status: APROVADO.
Escopo: aplicar a marca oficial ZEVANORY em todas as superfícies públicas e garantir que os mesmos ativos funcionem no servidor local sem enfraquecer segurança.

## Evidências independentes
1. OWASP — Path Traversal: recomenda normalizar caminhos, restringir a raiz e usar allowlist/known-good para impedir acesso fora do web root. Fonte: https://owasp.org/www-community/attacks/Path_Traversal — classe B.
2. MDN — MIME type verification / X-Content-Type-Options: exige MIME correto para script/style e recomenda `nosniff` para impedir MIME confusion. Fonte: https://developer.mozilla.org/en-US/docs/Web/Security/Practical_implementation_guides/MIME_types — classe A/B técnica.
3. Vercel — Static assets/public resources: ativos estáticos de browser devem estar no diretório público da aplicação. Fonte: https://vercel.com/templates/template/screwfast — classe C/documentação de plataforma.

## Decisão
- Logo e favicon oficiais serão self-hosted em `public/brand/`.
- Nenhum CDN ou origem externa será necessário para a identidade.
- O servidor local servirá apenas arquivos reconhecidos dentro de `public/`, com MIME explícito, `nosniff`, CSP e proteção de traversal.
- Deploy continua serializado e fail-closed; nenhuma mudança de marca altera gates comerciais, financeiros ou de autonomia.

## Hipóteses que não mudam
- A marca aprovada não prova venda, lucro, conversão ou prontidão jurídica.
- Comercialização permanece subordinada aos gates canônicos.
