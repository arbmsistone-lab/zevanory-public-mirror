# ZEVANORY | NC-007 N4 | HOTMART CLUB H0 | CHECKLIST DE LEITURA
Data-base: 03/11/2026. DEC-01 no R26 recebeu CONTESTO do GPT-6 pela diferença compra × aprovação. **Este roteiro não autoriza mudança de oferta, produto, dia de liberação, venda ou compra de teste.**
Objetivo: ler o painel, reunir prints e preparar uma decisão coerente sobre o 9º dia.

## 1. Identidade e entrega atual (um registro por produto)
| Produto | Hotmart product_id (proposta) | Formato lido no painel | Mesmo ID ao migrar para Club? | Link/offer no checkout | Evidência (print/data/hora) |
| IA na Prática | 8704733 | [a preencher] | [a preencher] | [a preencher] | [a preencher] |
| Vendas na Prática | 8704826 | [a preencher] | [a preencher] | [a preencher] | [a preencher] |
| Lucro & Caixa | 8704851 | [a preencher] | [a preencher] | [a preencher] | [a preencher] |
| Combo IA + Vendas | 8704861 | [a preencher] | [a preencher] | [a preencher] | [a preencher] |
| Negócio Completo | 8704871 | [a preencher] | [a preencher] | [a preencher] | [a preencher] |
Conteúdo Pronto 8704905 é outro fluxo, **não** deve virar kit.

## 2. O mecanismo de agendamento da Hotmart Club (somente observar)
- Data/hora da captura: [___] e conta/área de membros: [___].
- Em `Liberação programada`, lista das opções visíveis: [___]. Print: [___].
- Âncora do prazo indicada pela UI: [data de tentativa da compra / pagamento aprovado / matrícula / outra / NÃO INFORMA].
- Valor de `9 dias` disponível? [sim/não] e o primeiro dia de contagem (D ou D+1): [___].
- Fuso usado e horário real no qual o módulo abre (ex.: 00:00 America/Sao_Paulo): [___].
- A UI permite horas exatas desde a aprovação? [sim/não/não informa].
- Se compra inicia no dia D mas o pagamento é aprovado em D+1 ou D+2, qual data governa o módulo? [___]. Prova de documentação: [___].
- Garantia configurada na Hotmart para cada produto e condições de reembolso: [___].
- PDFs, ZIP e links de download podem ser bloqueados **também por URL direta**? [___].
- A área informa prazo de liberação no checkout e no e-mail? [___].

## 3. Matriz de horários para uma futura prova AUTORIZADA (não executar agora)
| Caso | Compra iniciada | Aprovação | Verificar acesso em | Resultado/recibo |
| A: instantâneo tarde | D, 23:55 BRT | D, 23:55 | D+8 23:59 / D+9 00:00 | [___] |
| B: instantâneo cedo | D, 00:05 | D, 00:05 | D+8 23:59 / D+9 00:00 | [___] |
| C: meio-dia | D, 12:00 | D, 12:00 | D+8 23:59 / D+9 00:00 | [___] |
| D: aprovação tardia | D, 23:55 | D+2, 10:00 | D+9 00:00 / (aprovação+192 h) | [___] |
| E: pagamento em análise | D, 23:55 | NÃO APROVADO | qualquer data | [bloqueado, evidência] |
Obter timestamps oficiais `purchase.approved_date` e, se possível, `purchase.order_date`; não substituir por relógio do cliente. Registrar `America/Sao_Paulo` e UTC.

## 4. Critérios de aprovação
- Documentar se 9 dias de calendário após a compra entregam 192 horas APÓS APROVAÇÃO também em atraso de Pix/boleto. Se não, a afirmação “nunca antes” é falsa.
- O termo "a partir do 9º dia" é ambíguo: escreva uma data-exemplo e a regra do sistema de maneira inequívoca, após a avaliação jurídica.
- Fazer readback de acesso Day1 aos módulos online e XLSX/DOCX/TXT; PDF/ZIP ficam inacessíveis via UI e URL direta até o prazo real.
- Validar prazo de garantia/reembolso e revogação de acesso após estorno, usando procedimentos Hotmart autorizados.
- Se o Club não garantir o prazo, NÃO escolher automaticamente 10 dias: uma aprovação ainda mais tardia também pode quebrar a regra. Requer decisão de meio de pagamento, entrega ou redação, sem diminuir direitos do consumidor.

## 5. Preenchimento pelo proprietário e auditoria
Execução H0: [nome do operador], data: [___]. Evidências com hash/URL: [___].
Voto Claude: [___]. Voto GPT-6: CONTESTO DEC-01 como redigida. Dissenso pendente: [___].
Nenhuma edição no painel nesta etapa; não preencher as caixas como concluídas sem print.
**Estado:** RASCUNHO DE PROVA, VENDAS FECHADAS, NO-GO, PR #963 sem merge/deploy, garantia de 192h NÃO CERTIFICADA.
