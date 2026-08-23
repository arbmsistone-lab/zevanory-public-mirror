# EVIDENCE GATE

ID da implementacao: EG-0024
Decisao proposta: pre-registrar protocolo G3/G4 antes de qualquer venda real, sem aprovar G3 ou G4 antecipadamente.
Problema que resolve: impedir escolha retroativa de metrica, janela ou criterio de sucesso depois de observar resultados.

## Evidencia 1
Fonte: specs/GATES.md
Classe: A
Constatacao: G3 exige telemetria origem->pagamento reconciliado e G4 exige baseline sem decisao de IA; criterio deve ser definido antes do teste.
Limites: o arquivo nao define a metrica especifica de EXP-0001.

## Evidencia 2
Fonte: src/telemetry.mjs + src/operationalStatus.mjs
Classe: A
Constatacao: ZEVANORY ja separa page_view, lead_qualified, offer_sent, checkout_started, payment_confirmed e refund_confirmed.
Limites: contagens atuais nao constituem baseline comercial porque EXP-0001 ainda nao iniciou.

## Evidencia 3
Fonte: evidence/EG-0007-validacao-operacional-3x.md + experiments/TEMPLATE.md
Classe: B
Constatacao: metodologia aprovada exige metrica primaria, diagnosticos, guardrails, incerteza, criterio de parada e fonte financeira definidos antes da leitura do resultado.
Limites: baseline real depende de dados comerciais futuros.

## Convergencia e contradicoes
O que as fontes concordam: baseline deve ser pre-registrado, rastreavel e financeiramente reconciliado antes de IA.
O que diverge: nenhuma fonte prova hoje qual sera a taxa de conversao real de EXP-0001.
O que permanece nao comprovado: desempenho comercial, CAC, margem e efeito causal.
## Veredito
Veredito: APROVADO
Criterio de teste apos implementacao: protocolo deve declarar status PRE-REGISTRADO/NAO APROVADO, metrica primaria, diagnosticos, fonte financeira, incerteza e regra de interrupcao antes de EXP-0001 comercial.
Kill-switch / rollback: qualquer alteracao retroativa de metrica/criterio apos inicio comercial invalida a janela e exige nova pre-registracao.