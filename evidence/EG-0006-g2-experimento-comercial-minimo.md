# EVIDENCE GATE

ID da implementacao: EG-0006 / G2 Experimento Comercial Minimo
Decisao proposta: validar a oferta por uma jornada curta e instrumentada: pagina -> WhatsApp -> qualificacao -> oferta -> pagamento real.
Problema que resolve: medir comportamento comercial real antes de construir plataforma, agente autonomo ou escala de aquisicao.

## Evidencia 1
Fonte: Microsoft Experimentation Platform - https://www.microsoft.com/en-us/research/articles/alerting-in-microsofts-experimentation-platform-exp/
Classe: B
Constatacao: experimentos confiaveis exigem proporcao esperada, monitoramento de qualidade, metricas previamente definidas e alertas para desvios como SRM e metricas fora de faixa.
Limites: metodologia criada para experimentacao digital em escala; no piloto pequeno teremos evidencia preliminar ate atingir amostra suficiente.

## Evidencia 2
Fonte: Stripe - experimento de metodos de pagamento - https://stripe.com/blog/testing-the-conversion-impact-of-50-plus-global-payment-methods
Classe: A
Constatacao: experimento holdback estatisticamente significativo mostrou que a experiencia de pagamento altera conversao e receita; pagamento precisa ser evento observado, nao inferido por clique.
Limites: efeito medio global da Stripe nao define nosso meio de pagamento nem nossa taxa de conversao.

## Evidencia 3
Fonte: Baymard Institute - Checkout UX 2026 - https://baymard.com/blog/ecommerce-checkout-usability-report-and-benchmark
Classe: B
Constatacao: 17% dos compradores pesquisados relataram abandono por checkout longo/complicado; friccao de formulario e custo inesperado sao causas recorrentes de abandono.
Limites: pesquisa focada em ecommerce; nossa oferta e um servico/piloto e tera jornada mais curta.

## Evidencia 4
Fonte: WhatsApp Business - Politecnico de Suramerica - https://whatsappbusiness.com/pt-br/resources/success-stories/politecnico-de-suramerica/
Classe: C
Constatacao: case de educacao profissional mostra jornada conversacional com IA, CRM e handoff humano associada a aumento de leads e matriculas.
Limites: case de fornecedor e auto-relatado; serve como viabilidade operacional, nao como prova causal universal.

## Convergencia e contradicoes
O que as fontes concordam: o primeiro teste deve ser curto, instrumentado, com evento financeiro real e poucos pontos de friccao; WhatsApp pode operar como etapa comercial, mas nao substitui reconciliacao de pagamento.
O que diverge: nenhuma fonte determina nossa taxa de conversao, volume minimo ou melhor criativo.
O que permanece nao comprovado: disposicao real a pagar, conversao, CAC, margem e efeito incremental da IA.

## Veredito
Veredito: APROVADO
Criterio de teste apos implementacao: jornada publica funcional, eventos page_view, cta_whatsapp, lead_qualified, offer_sent, checkout_started, payment_confirmed e refund_confirmed; pagamento deve ser reconciliado com provedor.
Kill-switch / rollback: se tracking quebrar, pagamento nao reconciliar ou qualquer promessa nao comprovada aparecer na pagina, interromper o teste e nao contar seus resultados.
