# EG-0044 — CANONICAL EXECUTIVE VISUAL SYSTEM

Status: APPROVED.
Escopo: consolidacao visual da pagina principal, sem alterar backend, banco ou gates comerciais.

## Evidence Gate herdado e ainda valido
1. AWS Cloudscape: dashboards devem priorizar leitura em relance, hierarquia e foco no que orienta decisao.
2. IBM Carbon: dashboards exigem hierarquia forte, numero controlado de metricas e espacamento proporcional a importancia.
3. Atlassian Design System: elevacao e contraste devem ser reservados ao que realmente precisa de enfase.

As tres fontes independentes ja foram aprovadas em EG-0041 e continuam aplicaveis; EG-0044 nao muda a decisao de produto, apenas remove divida visual acumulada.

## Evidencia operacional que motivou EG-0044
- `zevanory.api.br` e `zevanory-site.vercel.app` reportaram o mesmo SHA em `/api/release`.
- Portanto a aparencia inconsistente nao era deployment antigo: era a pilha historica de CSS.
- A interface continha varias camadas EG-0041/0042/0043.x e microtipografia de 8 px.
- O alias Vercel mostrava rodape fixo `zevanory.api.br`, gerando contradicao de superficie.

## Decisao EG-0044
- Uma unica folha visual canonica, sem stack de overrides historicos.
- Nenhum dado operacional removido ou escondido para fazer caber.
- Piso tipografico homologado: 9 px em 1280x720; 10 px em desktop alto/1600x900.
- Host do rodape deriva de `location.host`.
- Labels de apresentacao em portugues; chaves tecnicas internas permanecem intactas.
- Verde=saudavel/aprovado, amarelo=bloqueado/atencao, vermelho=risco/estado comercial indevido.

## Invariantes
Todos os kill-switches permanecem fail-closed. Esta fase nao autoriza venda, checkout, WhatsApp comercial, eventos financeiros ou autonomia.
## Prova operacional em producao
- 1280x720 efetivo 1262x624: minFont=9, truncamentos=0, overflowX=false, overflowY=false, rails sem overflow.
- 1600x900 efetivo 1582x804: minFont=10, truncamentos=0, overflowX=false, overflowY=false, rails sem overflow.
- `zevanory.api.br` e `zevanory-site.vercel.app` reportaram o mesmo SHA e renderizaram host correto no rodape.
