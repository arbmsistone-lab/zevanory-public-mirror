# Rodada 2 F1 — PR C bloqueado por caminho reservado

Base: `3cd47670b2c86a71696984ea9a40df349f1da585`.
DRAFT de bloqueio, sem alteração funcional; não deve ser mesclado.

## Causa confirmada

.github/workflows/indexnow-submit.yml contém um envio diário e por sitemap dos dois hosts. Faz leitura integral do sitemap e monta urlList de até 10000 URLs. O envio é inline no próprio workflow, sem módulo externo que possa ser corrigido isoladamente. Ele pode continuar reenviando todo o sitemap mesmo se o Worker for corrigido.

O caminho .github/** é reservado pela classe credenciais em ops/owner-reserved-paths.json. A instrução desta rodada diz para parar e registrar no PR caso seja necessário alterá-lo. Por isso o workflow, seu agendamento e seus gatilhos foram preservados nesta rodada. Não há alegação de que o problema do Bing esteja corrigido.

## Escopo concreto necessário para uma continuação autorizada

1. Alterar .github/workflows/indexnow-submit.yml para remover o envio inline que lê e submete sitemaps completos. Não remover os guardas de governança nem mudar secrets, permissões ou deploys. O fim do envio diário em lote deve ser acompanhado de um emissor que receba somente os eventos de publicação/alteração efetiva, com persistência de estado.
2. Corrigir o ponto de publicação no Worker (worker/multichannel-autonomy.mjs) para usar esse emissor apenas para a URL criada/alterada. Cada publicação gera uma submissão; nenhum sitemap é expandido em lista.
3. Emissor aceita no máximo 10 URLs por chamada, valida host/canonical, elimina duplicatas e mantém idempotência URL/dia. Para URLs estáticas, a identificação de alteração deve usar os arquivos/diff da publicação, não varrer o sitemap inteiro. Conteúdo inalterado não é nova publicação.
4. Falha de leitura/estado inválido bloqueia a submissão; recuperação deve consultar evidência durável de tentativa/resultado, sem apagar deduplicação para reenviar. Resultado HTTP desconhecido não deve ser declarado como sucesso. Definir comportamento concorrente para evitar duas submissões da mesma URL/dia.
5. Testes e mutantes: trocar a lista de URLs alteradas pelo sitemap completo; remover limite 10; remover deduplicação por URL/dia; enviar URL não alterada; aceitar estado corrompido. Cada um deve morrer por asserção específica, com controle positivo.

## Decisão necessária

Autorizar expressamente a exceção para editar .github/workflows/indexnow-submit.yml no escopo acima. Até essa autorização, nenhuma implementação parcial será apresentada como solução do alerta. A identidade de URLs novas/alteradas deve ser compartilhada pelo workflow e pelo Worker para não duplicar a mesma publicação.

Nenhum caminho reservado tocado. Sem merge, rótulo, dispatch, reativação ou deploy. PRs existentes intocados.
