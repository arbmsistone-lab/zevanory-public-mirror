# Demonstração exemplar — ARBM ONE Comercial by Zevanory

## Objetivo
Mostrar a operação ponta a ponta de uma empresa: configuração, cliente, produto, venda, atendimento, entrega, financeiro e gestão.

## Preparação
1. Usar uma instância de demonstração isolada com dados fictícios.
2. Configurar nome da empresa, usuário demonstrador e permissões.
3. Cadastrar três produtos com estoque, preço e unidade.
4. Cadastrar um cliente fictício e uma forma de pagamento de teste.
5. Nunca usar credenciais, PIX ou dados reais durante demonstração pública.

## Roteiro principal
1. Login: mostrar identificação da empresa e acesso por perfil.
2. Dashboard: explicar indicadores e onde o gestor identifica prioridade.
3. Produtos/estoque: localizar item, conferir saldo, preço e situação.
4. Cadastro: criar um produto de exemplo com nome, SKU, unidade, preço e estoque.
5. Clientes: cadastrar cliente apenas com os dados necessários ao cenário.
6. PDV: adicionar produto pelo grid e revisar carrinho.
7. Ajustar quantidade e demonstrar desconto dentro da regra configurada.
8. Escolher Entrega, Retirada ou Programar e explicar quando usar cada opção.
9. Finalizar a venda com forma de pagamento de demonstração.
10. Mostrar reflexo no estoque e no resumo financeiro.
11. Central de Atendimento: abrir conversa fictícia e identificar status/SLA.
12. Demonstrar mensagem, nota interna, PIX copiável e localização quando habilitados.
13. Gestão do Cliente: mostrar histórico e informações relevantes sem sair da central.
14. Entregas: acompanhar pedido de entrega e mudança de status.
15. Contas a receber/financeiro: localizar o lançamento criado pelo cenário.
16. IA ARBM: mostrar recomendação/assistência apenas em contexto permitido e revisar antes de executar.
17. Configurações: mostrar empresa, usuários, permissões e horário de atendimento.
18. Auditoria: mostrar que ações críticas deixam rastreabilidade quando aplicável.
19. Retorne ao Dashboard e mostre os efeitos do fluxo concluído.
20. Logout: encerrar a sessão e explicar separação de perfis.

## Cenário exemplar completo
Venda 2 unidades do “Produto Demonstração A” para “Cliente Demonstração”, com retirada, pagamento de teste e uma conversa posterior perguntando sobre o pedido.

## Validação
- Venda concluída sem inconsistência.
- Estoque refletido corretamente.
- Cliente e atendimento vinculados ao cenário.
- Financeiro mostra o movimento esperado.
- Usuário entende onde configurar permissões e operação.

## Erros comuns
- Demonstrar com dados da empresa vendedora: usar tenant de demo.
- Dar acesso administrador a todo usuário: demonstrar menor privilégio.
- Pular configuração e mostrar apenas telas: sempre concluir um fluxo de negócio real.

## Exercício do cliente
Pedir ao cliente para cadastrar um novo item fictício, realizar uma venda simples e localizar essa venda no painel/financeiro.
