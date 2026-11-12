# Publicação de prova DEC-23

Este PR prepara uma execução manual; não aprova a prova nem ativa publicação contínua.

## Execução futura, mediante autorização do proprietário no chat

O disparo é exclusivamente manual, por `workflow_dispatch` em `gh-pages`, e só pode acontecer após autorização explícita do proprietário no chat. Publicador (`meta-proof-post.yml`) e pré-voo (`meta-proof-preflight.yml`) usam `gh-pages-automacao`, o ambiente dos workflows Meta existentes. Mantêm os segredos META_ACCESS_TOKEN, META_PAGE_ID e INSTAGRAM_BUSINESS_ACCOUNT_ID, e o publicador usa `secrets.CLOUDFLARE_PUBLIC_OWNER_API_TOKEN || secrets.CLOUDFLARE_API_TOKEN` para o recibo KV. Nenhum segredo ou configuração de ambiente foi lido ou alterado nesta correção. Revisores obrigatórios não foram certificados; o YAML não substitui a autorização no chat.

Primeiro implantar a imagem revisada pelo processo autorizado de deploy do Worker. Depois executar o pré-voo somente leitura no mesmo SHA destinado à prova e informar seu `preflight_run_id` ao publicador. A API Actions valida workflow, evento workflow_dispatch, sucesso, mesmo SHA e idade máxima de 24 horas. O pré-voo é repetível: consulta permissões e imagem pública, sem reservar nem publicar.

Ações permanecem fixadas por SHA, permissões de leitura (contents: read; também actions: read no publicador), sem mudança nos gatilhos de outros workflows. O verificador exige pronto_para_prova estritamente true e IDs oficiais antes de reservar e publicar. Token da Página obtido por GET autenticado é mascarado e usado nos três POSTs; não vai a arquivo, URL de POST, relatório ou artefato. Erros de publicação não expõem corpo/stack da Meta.

## Imagem e publicação

Uma imagem por canal: Instagram /media, consulta limitada de FINISHED e /media_publish; Facebook /{page}/photos com published=true. Legenda institucional fixa com https://zevanory.api.br, validada por forbidden, sem preço, promessa ou mensageria.

A arte post-01.png foi convertida para JPEG RGB, qualidade 95, sem redesenho; PNG preservado. A cópia canônica revisada está em `assets/brand/export/zevanory-proof-dec23.jpg`, registrada nos manifestos e nos pipelines de build/export. URL obrigatória: `https://zevanory.api.br/brand/export/zevanory-proof-dec23.jpg`. Antes do POST exige image/jpeg e SHA-256 idêntico ao arquivo revisado. 404, redirecionamento ou bytes diferentes bloqueiam.

## Reserva e resultado desconhecido

Não há bloqueio por GITHUB_RUN_NUMBER==1. Falha anterior sem reserva não consome a prova. GITHUB_RUN_ATTEMPT continua exigido igual a 1.

A autorização percorre de forma paginada os artefatos dos runs anteriores e lê o recibo permanente `zpc:meta:prova:dec23:v1` no KV, sem TTL. Artefato de reserva existente (inclusive expirado), recibo existente/ilegível ou falha de leitura bloqueiam nova reserva. Concorrência do workflow é serializada, sem cancelar execução ativa. Reserva local exclusiva, recibo KV e upload do artefato antecedem qualquer POST. Publicar exige o ID do próprio upload, recibo reserved do mesmo run e trava local exclusiva.

Cada POST é precedido de estado unknown persistido localmente e no KV. IDs confirmados são gravados imediatamente. Estado publicado, parcial, ilegível ou desconhecido nunca autoriza novo POST. Summary e artefato preservam instagram_media_id e facebook_post_id; o upload de resultado roda mesmo após falha posterior à reserva. Artefatos: 90 dias; recibo KV: sem expiração. Não apagar recibos/artefatos nem recriar workflow para contornar a trava.

Não há retentativa automática nem transação atômica entre canais. Timeout ou resposta sem ID é desconhecido; sucesso parcial não é republicado. Tentativa adicional exige proposta separada e auditoria do resultado real na Meta.

## Aprovação e governança

`data/meta-prova-dec23.json` continua com aprovação pendente. Um PR separado registrará os IDs efetivos e a aprovação do proprietário. Campo canônico: `prova_facebook_post_id`, no formato PAGE_POST. O leitor aceita o legado numérico prova_facebook_video_id somente quando o canônico está ausente/nulo; canônico presente e inválido bloqueia mesmo com legado válido. Não representar foto como vídeo. A trava DEC-23 do crosspost permanece.

Merge segue a aprovação vigente, incluindo owner-approved:<12 hex do head SHA> quando aplicável. Esta correção não aplica rótulo, faz merge, deploy, dispatch ou reativação. Não altera preços, T6/P03, produtos ou interruptores. Nenhuma publicação real.

## Provas

Testes offline e mutantes cobrem reserva, pré-voo, resultados incertos, imagem, credenciais, legenda e invariantes do workflow. O contrato exige publicador e pré-voo em gh-pages-automacao, preserva o fallback Cloudflare e rejeita ambiente divergente (mutante producao-critica).

Referências: https://developers.facebook.com/docs/instagram-platform/content-publishing/ ; https://developers.facebook.com/docs/graph-api/reference/page/photos/ ; https://docs.github.com/en/actions/reference/workflows-and-actions/variables ; https://github.com/actions/upload-artifact .

