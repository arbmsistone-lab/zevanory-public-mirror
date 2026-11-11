# Rodada 2 F1 — PR A bloqueado: assinatura oficial do teste

Base: `3cd47670b2c86a71696984ea9a40df349f1da585`.
Este DRAFT registra um bloqueio de especificação. Não contém implementação do handler, não deve ser mesclado e não certifica o postback.

## Evidência consultada em 11/11/2026

- https://developers.hotmart.com/docs/pt-BR/2.0.0/webhook/purchase-webhook/ descreve o contrato de compra e a autenticação X-HOTMART-HOTTOK. Não foi encontrada uma flag documentada que identifique exclusivamente o botão Enviar teste.
- https://developers.hotmart.com/docs/en/changelog documenta que os envios de teste passaram a usar o hottok do próprio produtor e que os payloads de sandbox foram atualizados.
- https://suportehotmart.zendesk.com/hc/pt-br/articles/360001491352-Como-configurar-a-API-do-meu-produto-usando-o-Webhook-Postback confirma o botão de teste, mas não define uma assinatura exclusiva para classificar seu payload.

Não se conclui que a Hotmart não possua qualquer mecanismo; falta evidência suficiente nas fontes consultadas. O exemplo genérico de uma compra na documentação não prova identidade com o payload atual enviado pelo botão. Não usar o exemplo, nome do comprador, e-mail, prefixo HP ou um suposto campo test como autorização para ignorar uma venda.

## Necessário para continuar

Uma amostra comprovadamente produzida pelo botão oficial (histórico já existente ou documentação/suporte oficial), sem hottok, cabeçalhos de autenticação, dados pessoais ou tokens. Preservar apenas os campos técnicos necessários: versão, evento, identificadores de exemplo de produto/transação e eventual indicador de teste. Não disparar o botão contra o endpoint de produção atual para produzir essa evidência: ele ainda pode registrar uma venda falsa. Se não houver amostra segura existente, obter confirmação da Hotmart ou planejar uma captura isolada, sem efeitos de venda, em autorização separada.

A assinatura deve ser estrita e impedir que qualquer produto/transação real seja descartado. Ambiguidade permanece real com aviso sanitizado. Após a evidência: autenticar antes de classificar; interromper antes de sales-ledger, atividade e diarioSombra; gravar somente zpc:hotmart:webhook:teste:v1 com recebido_em, evento, versao, hottok_valido e TTL de 30 dias; leitura estrita da prova com estado inconclusivo em erro e recuperação pela nova leitura/fonte autenticada, sem fabricar sucesso. Snapshot deve usar o mesmo leitor. #1021 não será alterado; exportar leitor para integração posterior.

## Provas exigidas quando houver implementação

Teste autenticado: resposta 200 test/ignored, uma única prova sem dados pessoais e zero venda/atividade/diário/e-mail. Sem autenticação: 401 e zero escritas. Compra real: regressão do fluxo atual. Mutantes: teste como venda; teste sem hottok; produto/transação real como teste; prova com dados pessoais. Cada mutante deve morrer pela asserção correspondente, após controle positivo.

Nenhum caminho reservado alterado. Nenhuma regra funcional foi implementada ou certificada neste DRAFT. Sem merge, rótulo, dispatch, reativação ou deploy. Outros PRs permanecem intocados.
