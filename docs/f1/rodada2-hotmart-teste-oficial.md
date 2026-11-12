# F1 rodada 2 — webhook dedicado de teste

Base: `3cd47670b2c86a71696984ea9a40df349f1da585`. Desbloqueio autorizado pelo proprietário: não classificar payloads na rota de produção.

POST /api/webhooks/hotmart/teste autentica o hottok em comparação de bytes com tempo constante para valores de mesmo tamanho, preservando a regra de tamanho mínimo da rota atual. Aceita os eventos conhecidos da versão 2.0.0 e grava somente zpc:hotmart:webhook:teste:v1 com recebido_em, evento, versao, hottok_valido:true, TTL 30 dias. Retorna 200 {ok:true,test:true}. Não importa ou chama razão de vendas, atividade, diário, pós-venda ou e-mail. O roteamento ocorre antes da leitura do interruptor de vendas.

Hottok inválido: 401, sem escritas. Falha na leitura ou gravação da prova: 503, sem confirmação falsa; o replay autenticado pode recuperar. Prova anterior corrompida é substituída somente por nova observação autenticada, nunca usada para derivar estado financeiro. Leitor exportado readHotmartPostback distingue ausência, prova válida e LEITURA_INCONCLUSIVA para falha/estrutura inválida. Snapshot usa esse leitor estrito. #1021 não foi alterado; a exibição no relatório poderá importar o leitor após integração.

A rota original /api/webhooks/hotmart e seus módulos de ingestão não foram editados. Compra aprovada real continua gravando o evento financeiro e atividade na regressão. A prova certifica apenas transporte e autenticação na rota dedicada, não a ingestão financeira nem a entrega de um produto.

## Procedimento do proprietário após merge e deploy autorizados

Criar uma SEGUNDA configuração de webhook na Hotmart, apontando para https://zevanory.api.br/api/webhooks/hotmart/teste, versão 2.0.0. Usar Enviar teste somente nessa configuração. Não trocar a URL da configuração de produção e não usar o botão de teste contra ela. Não há filtros por nome/e-mail/transação para distinguir testes. A configuração de prova nunca deverá substituir a configuração que recebe vendas. Conferir 200 test:true e o estado datado no snapshot. Nenhuma configuração ou teste remoto foi feito nesta rodada.

Fonte do contrato de eventos/autenticação: https://developers.hotmart.com/docs/pt-BR/2.0.0/webhook/purchase-webhook/ . Limitação: a nova abordagem usa a rota como separação explícita e não tenta inferir um marcador de teste a partir do payload.

## Testes

11 cenários incluindo quatro mutantes: gravação indevida de venda, aceitação sem hottok, captura da rota de produção e vazamento do comprador na prova. Todos os mutantes morrem por asserção após controle positivo. Regressões de compra real, corpo/versão/evento inválidos, método, prova ausente/corrompida, falha transitória e recuperação. Suíte completa e gates registrados na entrega do SHA.

Nenhum caminho reservado alterado. Sem merge, rótulo, dispatch, reativação ou deploy. Telegram e WhatsApp não foram alterados.
