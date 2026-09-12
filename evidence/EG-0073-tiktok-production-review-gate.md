# EG-0073 — TikTok production review gate

Status: APROVADO COM RESTRICOES.
Data: 2026-09-09.
Escopo: impedir OAuth de producao enquanto o app TikTok estiver `In review`, preservando sandbox e mantendo vendas fail-closed.

## Evidencias independentes
1. TikTok for Developers — App Review FAQ / Register Your App (A): `In review` significa aprovacao pendente; integracoes entram em `Live` somente apos aprovacao. A documentacao afirma que o app nao tem acesso as APIs ate ser aprovado.
2. RFC Editor — RFC 6749 (A): `unauthorized_client` significa que o cliente nao esta autorizado a solicitar o authorization code/metodo de autorizacao.
3. Auth0 Docs (C): documenta `unauthorized_client` como ausencia de autorizacao/grant para a API solicitada, corroborando o tratamento fail-closed do cliente OAuth.

## Evidencia operacional observada
- Portal TikTok do app ZEVANORY Social Publisher mostra Producao `Em analise`.
- OAuth de producao retorna historicamente `unauthorized_client` para o client key configurado.
- Sandbox possui credencial separada e permanece o ambiente apropriado para validacao enquanto producao nao esta Live.

## Decisao
- OAuth de producao deve falhar localmente, antes de redirecionar ao TikTok, enquanto `TIKTOK_PRODUCTION_REVIEW_STATUS` nao for `live`.
- Sandbox continua permitido quando suas credenciais estiverem configuradas.
- O endpoint deve expor estado legivel (`production_review_pending`) em vez de enviar o usuario para uma pagina de erro do provedor.
- Nenhuma flag comercial, financeira ou de publicacao e habilitada por esta mudanca.

## Restricoes
- O sistema nao pode marcar `live` por inferencia. A promocao exige evidencia do portal TikTok mostrando status Live/aprovado.
- Esta mudanca nao acelera nem contorna a revisao do TikTok; apenas elimina o erro recorrente e torna o comportamento correto enquanto a revisao esta pendente.
