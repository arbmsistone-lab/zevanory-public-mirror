# EG-0072 — SOCIAL PROVIDER DIVERSITY EXPANSION

Status: APROVADO PARA IMPLEMENTACAO TECNICA / SEM CUTOVER COMERCIAL.
Data: 2026-09-09.
Escopo: ampliar o provider alternativo social sem alterar gates, identidade ou publicacao real.

## Evidencias independentes
1. Buffer API oficial: a GraphQL API permite criar posts em qualquer canal conectado usando `createPost`, `channelId`, `schedulingType` e `mode`; endpoint oficial `https://api.buffer.com`.
2. LinkedIn / Microsoft Learn — Posts API: publicacao organica exige autorizacao, author URN, versao de API e confirmacao de sucesso; prova que o provider direto continua uma rota distinta e nao pode ser presumido disponivel.
3. Google YouTube Data API — `videos.insert`: upload exige OAuth autorizado e possui cota/prova propria; prova que a rota direta YouTube tem dominio operacional distinto do agregador.

## Decisao
- Buffer pode ser registrado como adapter alternativo para Facebook, Instagram, TikTok, LinkedIn e YouTube quando houver API key e channel ID especifico.
- A rota direta continua preferivel quando qualificada; Buffer nao substitui identidade, consentimento, review ou gate comercial do canal.
- Instagram, TikTok e YouTube exigem midia HTTPS no adapter alternativo; ausencia de midia falha antes de qualquer efeito externo.
- Falha de rede/5xx depois de tentativa mutante continua `ambiguous` e bloqueia reroteamento cego.
- Nenhuma credencial, channel ID ou readiness sera inventada. Sem configuracao real, `alternate_api_configured=false`.
- `SALE_GLOBALLY_ENABLED`, `PRE_SALE_GATES_APPROVED`, checkout, financeiro e outbound permanecem fail-closed.

Resultado: APROVADO COM RESTRICOES. Implementacao de resiliencia autorizada; prova live de cada provider continua obrigatoria para marcar readiness de producao.