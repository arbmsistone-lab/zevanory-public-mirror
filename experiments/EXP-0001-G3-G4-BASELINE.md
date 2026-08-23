# EXP-0001 — PRE-REGISTRO G3/G4

Status: PRE-REGISTRADO / NAO APROVADO.
Gate atual do projeto: G2.
Inicio da janela: somente apos todos os gates pre-venda, dominio e Asaas Sandbox estarem aprovados e EXP-0001 iniciar comercialmente.

## Unidade e populacao
Populacao: leads qualificados de EXP-0001 atendidos pelo processo manual, sem decisao autonoma de IA.
Unidade primaria: session_id de lead qualificado.
Atribuicao financeira: order_id deve ligar o pedido a session_id e o pagamento deve ser reconciliado pelo Asaas via financial_events.

## Metrica primaria
Conversao reconciliada = sessoes com payment_confirmed / sessoes com lead_qualified.
Pagamento sem order_id/session_id reconciliado nao entra no numerador e BLOQUEIA G3.

## Diagnosticos
page_view -> lead_qualified; lead_qualified -> offer_sent; offer_sent -> checkout_started; checkout_started -> payment_confirmed.
Refunds devem ser reportados separadamente e nunca ocultados da leitura do baseline.
CAC e margem nao podem ser declarados enquanto custo atribuivel confiavel nao estiver instrumentado.
## Incerteza e janela
Intervalo de confianca: Wilson 95% para a conversao primaria.
Janela minima: 14 dias consecutivos do processo manual estavel.
Fechamento: somente se a meia-largura do IC95% for <= 0,15; limite operacional de 28 dias.
Se 28 dias forem atingidos sem precisao suficiente, G4 permanece INCONCLUSIVO e exige nova janela pre-registrada.

## Guardrails e interrupcao
Qualquer pagamento nao reconciliado, conflito de atribuicao ou alteracao retroativa desta metrica invalida a janela.
IA autonoma permanece proibida durante o baseline; mudanca material de oferta, preco ou canal reinicia a janela.
G3/G4 so podem ser aprovados depois da coleta real e auditoria 3X dos dados.