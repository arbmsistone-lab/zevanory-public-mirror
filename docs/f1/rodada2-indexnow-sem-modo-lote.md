# F1 rodada 2 — IndexNow sem modo lote

Base: `3cd47670b2c86a71696984ea9a40df349f1da585`. Exceção expressamente autorizada pelo proprietário: editar somente o escopo do envio em .github/workflows/indexnow-submit.yml. O merge exige owner-approved:<12 hex do SHA do head> conforme o guarda da base; nenhum rótulo foi aplicado.

Os gatilhos workflow_dispatch, schedule e push, os paths do push, contents:read e a chave pública foram mantidos. Nenhum secret foi acrescentado ou alterado. O envio inline que expandia dois sitemaps em listas de até 10000 URLs foi removido.

O planejador lê o diff e o conteúdo dos arquivos da publicação, usa o sitemap somente como lista de canonicals elegíveis e seleciona exclusivamente páginas novas/alteradas com arquivo HTML/Markdown correspondente. Alterar somente o sitemap não gera envio. Um corpo inalterado não é publicação nova. Conteúdo removido não é enviado. Uma URL por requisição POST, uma submissão por publicação; o validador rejeita mais de 10 URLs, e o emissor é ainda mais estrito: só aceita uma URL.

A agenda e os disparos manuais consideram alterações recentes na linha principal dos últimos 2 dias. Push usa o before do evento. Revisões antigas de mais de 48 horas não são reenviadas; uma execução sem mudança encerra sem submissão. O plano tem limite de 200 publicações; exceder bloqueia em vez de enviar parcialmente um lote.

## Idempotência e recuperação

O nome de cada job contém hash da URL, revisão de conteúdo e dia UTC. O histórico de jobs é o registro de tentativa, incluindo erros/cancelamentos que tenham começado. Antes de qualquer POST, consulta completa e paginada verifica tentativas anteriores por URL/dia e pela mesma revisão nos últimos 2 dias. Uma tentativa de resultado desconhecido nunca é repetida. Na migração, um job legado submit no mesmo dia causa retenção conservadora. Concurrency serializa o workflow e os jobs da mesma URL, com queue:max e sem cancelamento de trabalho em andamento.

O histórico é consultado pela API pública de GitHub sem token. Erro HTTP, formato inválido ou paginação incompleta bloqueia o envio. A execução seguinte recupera por nova leitura válida; nunca apaga histórico para repetir tentativa. Limites/instabilidade da API podem adiar ou impedir uma notificação. Um job que falhou antes do POST pode permanecer retido como tentativa conservadora; isso evita duplicata, mas não garante entrega ao buscador. Uma publicação com conteúdo novo volta a ser elegível em dia posterior. HTTP 200/202 do IndexNow comprova aceite, não indexação.

Não há novo estado KV neste PR; a fonte durável é o histórico operacional. Não se usa cache descartável como prova de ausência. Não foram disparados jobs nem chamadas reais ao IndexNow nesta rodada.

## Integração pendente com #1020

A base deste PR ainda não contém o publicador automático do #1020. Este PR corrige o emissor em lote existente do workflow. O envio direto de uma URL de artigo adicionado por #1020 deve ser conferido na integração futura para compartilhar a política de URL/dia, sem reintroduzir lote. #1020 e #1021 não foram alterados ou integrados nesta rodada. URLs dinâmicas sem arquivo no repositório não são expandidas pelo planejador estático.

## Provas

12 testes, incluindo quatro mutantes: envio de entradas inalteradas do sitemap, remoção de idempotência URL/dia, remoção do limite de 10 e erro de histórico tratado como vazio. Cada mutante morre por asserção específica após controle positivo. Cobertura de uma URL por chamada, retorno desconhecido, tentativas anteriores no mesmo run, IDs mais novos de run, URL inválida e contrato de gatilhos/permissões. Suíte completa, manifest-tests e gates registrados no SHA entregue.

Único caminho reservado tocado: .github/workflows/indexnow-submit.yml, conforme autorização desta sessão. Sem merge, rótulo, dispatch, reativação ou deploy.
