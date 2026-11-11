# F1 rodada 2 — IndexNow sem modo lote

Base: `3cd47670b2c86a71696984ea9a40df349f1da585`. Exceção expressamente autorizada pelo proprietário: editar somente o escopo do envio em .github/workflows/indexnow-submit.yml. O merge exige owner-approved:<12 hex do SHA do head> conforme o guarda da base; nenhum rótulo foi aplicado.

Os gatilhos workflow_dispatch, schedule e push, os paths do push, contents:read global e a chave pública foram mantidos. Conforme autorização explícita da rodada 2b, somente o job submit ganhou actions:read para consultar o próprio repositório com o GITHUB_TOKEN padrão. Nenhum outro segredo foi usado e nenhuma outra permissão foi ampliada. O envio inline que expandia dois sitemaps em listas de até 10000 URLs foi removido.

O planejador lê o diff e o conteúdo dos arquivos da publicação, usa o sitemap somente como lista de canonicals elegíveis e seleciona exclusivamente páginas novas/alteradas com arquivo HTML/Markdown correspondente. Alterar somente o sitemap não gera envio. Um corpo inalterado não é publicação nova. Conteúdo removido não é enviado. Uma URL por requisição POST, uma submissão por publicação; o validador rejeita mais de 10 URLs, e o emissor é ainda mais estrito: só aceita uma URL.

A agenda e os disparos manuais consideram alterações recentes na linha principal dos últimos 2 dias. Push usa o before do evento. Revisões antigas de mais de 48 horas não são reenviadas; uma execução sem mudança encerra sem submissão. O plano seleciona no máximo 50 URLs no dia UTC, considerando as tentativas anteriores do mesmo dia. Excedentes geram aviso e permanecem no registro de pendências; não são descartados depois de sair da janela de alterações recentes.

## Idempotência e recuperação

O nome de cada job contém hash da URL, revisão de conteúdo e dia UTC. O histórico de jobs é o registro de tentativa, incluindo erros/cancelamentos que tenham começado. Antes de qualquer POST, consulta completa e paginada verifica tentativas anteriores por URL/dia e pela mesma revisão nos últimos 2 dias. Uma tentativa de resultado desconhecido nunca é repetida. Na migração, um job legado submit no mesmo dia causa retenção conservadora. Concurrency serializa o workflow e os jobs da mesma URL, com queue:max e sem cancelamento de trabalho em andamento.

O histórico é consultado pela API de GitHub com Authorization: Bearer do GITHUB_TOKEN, apenas para leitura do próprio repositório. Erro HTTP, formato inválido ou paginação incompleta emite ::warning title=INDEXNOW::journal_unreadable e bloqueia o envio. Token e mensagens brutas de erro nunca são impressos. A execução seguinte recupera por nova leitura válida; nunca apaga histórico para repetir tentativa. O planejador submit publica nos próprios logs somente o registro público INDEXNOW_PENDING_V1 (URL canônica, hash, revisão e arquivo), antes dos jobs de notificação. O próximo planejador restaura a pendência mais recente por GET autenticado dos logs e a combina com os novos arquivos. Tentativas dos jobs de notificação retiram da fila a mesma revisão; uma revisão diferente da mesma URL espera até o próximo dia se ela já foi tentada hoje. O job notify herda apenas contents:read, não recebe o token e submete uma URL por vez, com max-parallel:1. Limites/instabilidade da API podem adiar ou impedir uma notificação. Um job que falhou antes do POST pode permanecer retido como tentativa conservadora; isso evita duplicata, mas não garante entrega ao buscador. Uma publicação com conteúdo novo volta a ser elegível em dia posterior. HTTP 200/202 do IndexNow comprova aceite, não indexação.

Não há novo estado KV neste PR; a fonte durável é o histórico operacional e o registro de pendências nos logs do planejador. Se o GitHub remover logs/histórico necessários pela política de retenção ou apagar um run, essa evidência deixa de estar disponível; o sistema bloqueia em vez de declarar fila vazia. Não se usa cache descartável como prova de ausência. Não foram disparados jobs nem chamadas reais ao IndexNow nesta rodada.

## Integração pendente com #1020

A base deste PR ainda não contém o publicador automático do #1020. Este PR corrige o emissor em lote existente do workflow. O envio direto de uma URL de artigo adicionado por #1020 deve ser conferido na integração futura para compartilhar a política de URL/dia, sem reintroduzir lote. #1020 e #1021 não foram alterados ou integrados nesta rodada. URLs dinâmicas sem arquivo no repositório não são expandidas pelo planejador estático.

## Provas

12 testes, incluindo quatro mutantes: envio de entradas inalteradas do sitemap, remoção de idempotência URL/dia, remoção do limite de 10 e erro de histórico tratado como vazio. Cada mutante morre por asserção específica após controle positivo. Cobertura de uma URL por chamada, retorno desconhecido, tentativas anteriores no mesmo run, IDs mais novos de run, URL inválida e contrato de gatilhos/permissões. Suíte completa, manifest-tests e gates registrados no SHA entregue.

Único caminho reservado tocado: .github/workflows/indexnow-submit.yml, conforme autorização desta sessão. Sem merge, rótulo, dispatch, reativação ou deploy.

## Rodada 2b — NC-CL-1026-01 corrigida

Autenticação em todas as leituras do diário com o token padrão e actions:read só no job submit. Sem token, falha antes da rede. Falha do diário gera aviso fixo, sem token, e não autoriza POST. Teto diário reduzido a 50 URLs e excedente persistido no registro de pendências para próximas execuções, inclusive além da janela de 48h. Cada requisição IndexNow continua contendo exatamente uma URL.

12 testes adicionais em f2b-indexnow-auth, incluindo 4 mutantes: remoção do Authorization, teto aumentado para 200 e descarte do excedente. Provas de 125 URLs distribuídas em 50/50/25, consumo do teto por outras execuções no mesmo dia, restauração de pendências antigas e bloqueio por registro inválido. Os 4 mutantes anteriores continuam ativos; as âncoras foram adaptadas ao leitor compartilhado sem remover suas provas. Gates e suíte completa registrados na entrega do SHA.

Nenhuma leitura real de token nem chamada real ao IndexNow foi realizada nesta rodada. O token somente é referenciado no código de autenticação e no ambiente do job, como autorizado. owner-approved:<12 hex do novo head> continua obrigatório no merge; nenhum rótulo foi aplicado.

O dia UTC e o número da tentativa do planejador são vinculados ao job notify. Rerun apenas de um notify falho não reutiliza o plano antigo; exige novo planejamento. Rerun completo pode consumir a fila restante com o plano da nova tentativa. Dois testes adicionais cobrem essa diferença e o mutante que remove a vinculação.
