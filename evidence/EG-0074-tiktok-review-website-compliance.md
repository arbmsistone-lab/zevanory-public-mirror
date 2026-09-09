# EG-0074 — TikTok Review Website Compliance

Status: APROVADO PARA CORRECAO TECNICA / SEM AUTORIZACAO COMERCIAL.

## Evidencias independentes
1. TikTok for Developers — App Review Guidelines (A): o website oficial deve ser um site completo, nao apenas landing/login, e os links de Privacy Policy e Terms of Service devem estar visiveis no website oficial sem abrir menu.
2. W3C WCAG 2.2 / Link Purpose (B): links devem ser identificaveis e compreensiveis por seu texto, com foco visivel para navegacao por teclado.
3. MDN / Mozilla — elemento anchor e acessibilidade (B): links reais devem usar `<a href>` e texto de link deve indicar claramente o destino.

## Evidencia operacional encontrada
- `https://zevanory.api.br/` responde HTTP 200.
- `https://zevanory.api.br/privacidade` responde HTTP 200.
- `https://zevanory.api.br/termos` responde HTTP 200.
- A home canonica atual NAO contem links visiveis para Privacidade ou Termos.
- O TikTok mostra a revisao de producao da ZEVANORY como `Em analise`.

## Decisao
Corrigir imediatamente a home oficial adicionando links visiveis e acessiveis para `/privacidade` e `/termos`, preservando identidade, single-screen, zero-scroll e gates fail-closed. Nao alterar vendas, checkout, financeiro ou outbound.
