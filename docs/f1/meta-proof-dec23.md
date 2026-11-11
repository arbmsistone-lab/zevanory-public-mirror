# Publicação de prova DEC-23

Base: gh-pages `a76ae60893b44f132094a048a2b1e8a26ad1f7ba`. Este PR somente prepara uma execução manual; não aprova a prova nem ativa publicação contínua.

## Execução futura, mediante autorização

`meta-proof-post.yml` aceita somente workflow_dispatch em gh-pages, usa `producao-critica`, permissions contents: read e ações fixadas por SHA. Não modifica gatilhos de outros workflows. O proprietário deve confirmar antes do dispatch que esse ambiente tem sua revisão obrigatória configurada e os três segredos META_ACCESS_TOKEN, META_PAGE_ID e INSTAGRAM_BUSINESS_ACCOUNT_ID. As proteções do ambiente não podem ser impostas apenas pelo YAML; sua configuração não foi alterada nem comprovada pela conexão disponível.

O script existente `meta-permission-check.mjs` roda antes da reserva; o publicador também chama `runCheck` antes de reservar e de publicar. Só aceita pronto_para_prova estritamente true, IDs oficiais e primeira execução/primeira tentativa do workflow. O token da Página é obtido por GET autenticado, mascarado e usado nos três POSTs. Nenhum segredo vai a arquivo, URL de POST, relatório ou artefato. O único canal que recebe o valor literal é o comando nativo de mascaramento `::add-mask::`; logs e summary não contêm token. Erros de publicação usam mensagem fixa, sem corpo/stack da Meta.

Uma imagem por canal: Instagram /media, consulta limitada de status FINISHED e /media_publish; Facebook /{page}/photos com published=true. A legenda é fixa, institucional, com https://zevanory.api.br, passa por `forbidden` e não contém preço, promessa ou mensageria. A mesma arte post-01.png já existente foi convertida para JPEG (RGB, qualidade 95, sem redesenho), em brand/social/zevanory-proof-dec23.jpg. O PNG permanece inalterado. A pasta brand é copiada pelo build existente. Antes do POST, exige que a URL pública retorne image/jpeg e bytes com o mesmo SHA-256 do arquivo revisado; 404, redirecionamento, conteúdo diferente ou imagem ainda não publicada bloqueiam a prova.

## Idempotência e falha desconhecida

A primeira execução pode fazer uma única tentativa; número do run diferente de 1 ou run_attempt diferente de 1 bloqueiam tanto o workflow quanto o script. O contador monotônico do GitHub independe da retenção dos artefatos. A reserva é exclusiva em disco e enviada como artefato antes de qualquer POST. O script exige o ID desse upload e adquire uma trava local exclusiva de publicação. Concorrência do workflow é serializada, sem cancelar uma execução ativa.

Cada POST é precedido de recibo local unknown, sincronizado em disco. Após IDs confirmados, eles são gravados imediatamente. Estado existente, publicado, parcial, ilegível ou desconhecido nunca autoriza novo POST. A saída final preserva instagram_media_id e facebook_post_id no summary e no artefato; o segundo upload roda mesmo em falha posterior à reserva. Artefatos têm retenção de 90 dias; a trava de run/attempt continua bloqueando depois dessa retenção, inclusive se artefatos forem removidos. Não se deve excluir/recriar/renomear o workflow para reiniciar seu contador.

Escolha conservadora: uma primeira execução que falhe antes de publicar também consome a tentativa. Não há retentativa automática, nem recuperação por apagar arquivo/artefato. Uma tentativa adicional exige proposta separada e auditoria do que aconteceu na Meta. Não existe garantia de completar ambos os canais em transação atômica; sucesso parcial fica registrado sem republicação. Timeout ou resposta sem ID é desconhecido.

## Aprovação e governança

Não altera data/meta-prova-dec23.json. O registro da aprovação fica para PR separado, com os IDs efetivamente retornados e assinatura do proprietário. O esquema atual usa prova_facebook_video_id; uma prova de foto retorna facebook_post_id (normalmente PAGE_POST). Este PR não preenche nem converte esse campo: o PR de aprovação deverá definir a representação correta sem fingir que uma foto é vídeo. A trava de DEC-23 para o crosspost continua intacta.

Caminho reservado autorizado para criação: .github/workflows/meta-proof-post.yml. Merge exige owner-approved:<12 hex do head SHA>, aplicado pelo proprietário. Não foi aplicado rótulo. Nenhum outro reservado, preço, T6/P03, produto ou interruptor foi alterado. Sem merge, dispatch, reativação ou deploy. Nenhuma chamada de publicação real foi feita.

## Provas

31 testes locais, com respostas simuladas e sem credenciais reais. Incluem gate falso/ausente, IDs e token da Página, repetição, falhas antes de cada POST, estado parcial/desconhecido, escrita exclusiva, imagem inválida, legenda proibida e invariantes do workflow. Treze mutantes de execução e seis mutantes do workflow devem morrer por asserção; incluem obrigatoriamente gate removido, segunda publicação, token no log e legenda com preço.

Referências oficiais: https://developers.facebook.com/docs/instagram-platform/content-publishing/ ; https://developers.facebook.com/docs/graph-api/reference/page/photos/ ; https://docs.github.com/en/actions/reference/workflows-and-actions/variables ; https://github.com/actions/upload-artifact .
