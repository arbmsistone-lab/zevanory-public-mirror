# EVIDENCE GATE

ID: EG-0026 / Asaas Sandbox E2E
Decisao: autorizar homologacao ponta a ponta exclusivamente em deployment Preview isolado, com credenciais Sandbox, dados identificados por UUID de homologacao e restauracao integral dos kill-switches ao final.
Problema: provar checkout, cobranca, Webhook, reconciliacao, idempotencia, replay e recovery sem confundir simulacao Sandbox com venda real ou liberar o ambiente Production.

## Evidencia 1
Fonte: Asaas Checkout - https://docs.asaas.com/docs/asaas-checkout
Classe: A
Constatacao: o provedor exige chave do ambiente correto, recomenda Sandbox antes da liberacao, usa externalReference para reconciliacao e declara que callback de navegador nao substitui Webhook.
Limite: a documentacao define o contrato; a conta ZEVANORY ainda precisa provar o fluxo real no Sandbox.

## Evidencia 2
Fonte: Vercel Environment Variables - https://vercel.com/docs/environment-variables/managing-environment-variables
Classe: A
Constatacao: variaveis sao escopadas por ambiente e cada deployment recebe um snapshot; alterar targets exige novo deployment e nao altera artefatos anteriores.
Limite: Preview que recebeu secrets precisa ser removido depois da prova, alem de restaurar os targets das variaveis.

## Evidencia 3
Fonte: PostgreSQL Transaction Isolation - https://www.postgresql.org/docs/current/transaction-iso.html
Classe: A
Constatacao: transacoes e restricoes de unicidade permitem provar que insercao do evento financeiro e transicao do pedido sao atomicas e idempotentes sob reprocessamento.
Limite: a garantia depende das constraints e da instrucao SQL efetivamente implantadas no banco usado pela homologacao.

## Convergencia e contradicoes
As fontes convergem em tres fronteiras: Sandbox separado de Production, verdade financeira consultada diretamente no provedor e persistencia local protegida por transacao/constraints. O redirecionamento do navegador nunca sera aceito como prova de pagamento. A homologacao pode habilitar interruptores somente no Preview e deve destruir o deployment que recebeu secrets ao final.

## Criterios operacionais obrigatorios
- API Key aceita por chamada read-only no runtime Preview.
- Checkout e cobranca Sandbox reconciliados por payment.id e externalReference canonica.
- Webhook autenticado por asaas-access-token, reconciliado por GET /payments/{id} e persistido com HTTP 200.
- Reprocessamento do mesmo event.id nao duplica financial_event, pedido ou cobranca.
- Replay e recovery permanecem fail-closed; checkout_uncertain nunca cria nova cobranca automaticamente.
- Refund parcial e total sao executados quando o meio Sandbox for elegivel; impossibilidade do provedor deve ser registrada sem simulacao.
- Production permanece com os cinco interruptores false durante toda a prova.
- Secrets, Webhook temporario e deployments Preview de homologacao sao removidos/restaurados ao final.

## Evidencia operacional
Status: APROVADA EM 2026-08-25.

- A API Key Sandbox foi aceita pelo Asaas em chamada read-only dentro do runtime Vercel, com HTTP 200. O token do Webhook esteve presente no runtime sem que seu valor fosse registrado.
- Um Checkout hospedado Sandbox de R$ 497 foi criado e pago com dados ficticios autorizados. A pagina do provedor exibiu pagamento confirmado e a consulta direta ao Asaas confirmou o pagamento em estado CONFIRMED.
- O pagamento de Checkout hospedado retornou externalReference vazio e checkoutSession igual ao identificador do Checkout. A reconciliacao foi endurecida para aceitar somente correspondencia exata entre checkoutSession e provider_checkout_id persistido, preservando valor, payment.id e identidade canonica do pedido.
- Entregas reais do Asaas alcancaram o endpoint temporario de Webhook no runtime Vercel. Os logs registraram um HTTP 200 inicial e tres HTTP 409 de retry para um evento parcial que chegou depois de o provedor ja ter avancado ao reembolso integral. O handler passou a reconhecer esse evento parcial obsoleto somente quando identidade, valor e soma exata dos refunds DONE provam que o pagamento ja esta REFUNDED.
- A confirmacao foi reconciliada no schema isolado: pedido em paid, um financial_event e replay repetido com HTTP 200/duplicate=true, sem duplicacao.
- O recovery foi apenas leitura: nenhuma nova cobranca, nenhum novo evento financeiro e nenhuma alteracao de estado.
- O reembolso parcial de R$ 100 ficou inicialmente PENDING por saldo Sandbox insuficiente. Com autorizacao explicita, um PIX ficticio de R$ 600 foi criado e confirmado apenas no Sandbox para financiar a simulacao. Em seguida, R$ 397 foram reembolsados; o Asaas confirmou ambos os refunds como DONE e o pagamento como REFUNDED, total exato de R$ 497.
- A reconciliacao final encerrou o pedido isolado em refunded, com dois eventos financeiros canonicos (confirmacao e reembolso), total reembolsado de R$ 497 e replay idempotente em HTTP 200.
- O evento parcial nao transitou o pedido isolado por partially_refunded porque a fila o entregou somente depois do estado integral REFUNDED. A prova parcial permanece na verdade do provedor (refund DONE de R$ 100); a aplicacao tratou a entrega tardia de forma fail-closed e deterministica.
- O Webhook temporario do Asaas foi removido e o schema PostgreSQL isolado foi destruido. Os registros Sandbox de pagamento/reembolso permanecem somente como trilha de auditoria do provedor, sem efeito financeiro real.
- A protecao de deployments Vercel foi restaurada para all_except_custom_domains e a contagem final de bypasses de automacao e zero. Um identificador temporario de bypass apareceu em saida operacional interna durante a prova e foi revogado imediatamente; nenhum segredo Asaas foi exibido.
- Os deployments Preview e variaveis temporarias de homologacao foram removidos ao fechamento. ASAAS_API_KEY e ASAAS_WEBHOOK_TOKEN voltaram ao target exclusivo Production.
- Durante a retirada do target Preview, a CLI Vercel removeu integralmente os dois registros Sensitive em vez de preservar Production. O deploy final foi interrompido antes de qualquer impacto no snapshot Production ativo; a API Key Sandbox foi rotacionada no painel Asaas sem permissao de saque e o token de Webhook foi regenerado criptograficamente. Ambos foram recriados como Sensitive, somente em Production, sem exibicao ou gravacao local dos valores.
- Os quatro kill-switches comerciais permanecem false: SALE_GLOBALLY_ENABLED, PRE_SALE_GATES_APPROVED, CHECKOUT_ENABLED e WHATSAPP_SALES_ENABLED. Nenhuma venda real ou autonomia comercial foi habilitada.

## Veredito
Veredito: APROVADO
Escopo: homologacao tecnica Asaas Sandbox concluida. O blocker asaas_sandbox_unconfigured pode ser removido, mas PRE_SALE_APPROVAL permanece false e nao autoriza venda, experimento comercial ou autonomia.
Kill-switch: qualquer chamada fora de api-sandbox.asaas.com, alteracao dos quatro gates comerciais, falha de reconciliacao, duplicidade ou vazamento bloqueia novamente o avanco.
