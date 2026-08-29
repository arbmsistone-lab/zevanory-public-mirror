# EG-0036 — Composable Commerce Infrastructure Benchmark

Status: APROVADO PARA IMPLEMENTACAO.
Release alvo: `ZEVANORY-EG0036-FINAL`.
Escopo: arquitetura interna, limites de dominio, integracoes assincronas e resiliência sem ativar vendas.

## Cinco referencias profissionais consolidadas
1. Shopify Hydrogen/Oxygen — stack headless oficial com React Router, SSR, APIs de commerce e runtime de deploy integrado.
   Fonte: https://shopify.dev/docs/storefronts/headless/hydrogen/fundamentals
2. commercetools — composable commerce baseado em MACH: microservices, API-first, cloud-native e headless; recomenda migracao progressiva em vez de replatform total.
   Fonte: https://commercetools.com/blog/mach-r-technology-unveiled-powering-modern-digital-commerce-experiences
3. Salesforce Composable Storefront — PWA Kit desacoplado do backend, Commerce API e Managed Runtime; permite combinar componentes e fornecedores independentes.
   Fonte: https://developer.salesforce.com/docs/commerce/commerce-solutions/guide/getting-started.html
4. Adobe Commerce Cloud — arquitetura totalmente headless, APIs GraphQL/REST, separacao de front-end e core, ambientes de integracao/staging/producao e CDN.
   Fonte: https://experienceleague.adobe.com/en/docs/commerce/cloud-service/overview
5. BigCommerce Catalyst — storefront orientado a GraphQL e canais desacoplados, com capacidades de localizacao e composicao via API.
   Fonte: https://developer.bigcommerce.com/docs/storefront/catalyst/content-management/internationalization/multi-language/overview

## Sintese comparativa
- Melhor principio estrutural: commercetools/MACH — modularidade, API-first, cloud-native e headless.
- Melhor disciplina de storefront/runtime: Shopify Hydrogen/Oxygen e Salesforce Composable Storefront.
- Melhor separacao enterprise de experiencia/core/ambientes: Adobe Commerce.
- Melhor exemplo de canais e dados consumidos por API: BigCommerce Catalyst.

## Decisao para a Zevanory
Adotar **monolito modular composable** agora, e nao microservicos distribuidos. O tamanho atual da operacao nao justifica custo, observabilidade e falhas extras de uma malha de microservicos.

Implementar:
- contrato arquitetural explicito e aciclico entre Experience, Revenue, Commerce, Intelligence, Integrations e Platform;
- portas/adaptadores para canais e fornecedores, mantendo o cerebro independente de Meta, e-mail, afiliados e pagamento;
- transactional outbox PostgreSQL/Neon para desacoplar integracoes externas de transacoes internas com idempotencia, retry e dead-letter;
- evolucao por strangler pattern: novos componentes entram por contratos, sem reescrever o core aprovado;
- fail-closed comercial/financeiro preservado;
- nenhuma nova dependencia paga ou novo provedor obrigatorio.

## Evidencia e limites
Resultado do Evidence Gate: APROVADO.
Comprovado: as cinco arquiteturas convergem em desacoplamento, APIs e composicao; a Zevanory pode obter esses beneficios sem trocar Vercel/Neon.
Hipotese ainda nao comprovada: ganho comercial. Esta mudanca e exclusivamente estrutural e nao autoriza vendas, autonomia comercial ou eventos financeiros reais.
