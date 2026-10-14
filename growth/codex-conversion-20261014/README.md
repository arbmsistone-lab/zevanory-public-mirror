# ZEVANORY — C4 Inteligência de Conversão

**Data de corte:** 14/10/2026  
**Base canônica auditada:** `c3717aeb325e7acc6108177426ca420e565bb575`  
**Estado:** diagnóstico e experimentos para auditoria; nenhuma implementação, publicação, compra ou acesso a dados pessoais.

## Veredito executivo

A ZEVANORY já explica preço, escopo, entrega, suporte e garantia nas páginas dos cinco produtos. O passo GET de compra também repete produto, preço, meios de pagamento, entrega e garantia antes de qualquer POST. Portanto, não existe evidência própria para declarar que “o checkout é o problema”.

O maior gargalo verificável hoje é anterior: a jornada perde contexto de atribuição nos saltos internos. O código preserva UTM para `/comprar`, `/hotmart`, `/assinar` e `/material-gratuito`, mas não para links que levam de calculadoras, guias e catálogo às páginas dos produtos. O resumo agrega receita por produto, mas não associa pagamentos a source/campaign. Assim, há números por etapa, mas não uma taxa ponta a ponta confiável por campanha.

## Jornada observada

| Etapa | Superfície | O que já é mensurável | Lacuna principal |
|---|---|---|---|
| Descoberta | busca e canais orgânicos | views por source/campaign, classe e país agregados | pago não é ligado à campanha |
| Conteúdo | guias, blog e páginas por ramo | views/visitantes das rotas rastreadas | três guias WhatsApp ainda fora do funil |
| Material gratuito | formulário e checklist | views, visitantes e leads agregados | envio não aparece por source/campaign no handler auditado |
| Interesse | calculadoras, checklist, comparação | views por página/origem | salto para produto perde UTM |
| Produto | cinco páginas comerciais | views, visitantes e intenção por origem | nenhuma variante e nenhuma jornada por sessão |
| Intenção | GET `/comprar`, Hotmart e assinatura | checkout_intent, hotmart_view, subscribe_click | POST não leva UTM; order não recebe source/campaign |
| Checkout | Mercado Pago/Hotmart e retornos | checkout, pago, reembolso, receita e erro por produto | resultado pago não é atribuível à campanha |

Todos os valores reais estão `null` neste pacote. O snapshot agregado autenticado não foi acessado, e nenhum número foi inferido do código. A ausência de baseline é uma conclusão, não um zero.

## Pontos positivos preservados

- catálogo e páginas públicas responderam na inspeção GET;
- formulário gratuito é curto, nome é opcional e consentimento é explícito;
- checklist abre após envio, enquanto e-mails continuam em double opt-in;
- páginas dos produtos exibem preço, conteúdo, adequação, entrega, garantia e suporte;
- GET de confirmação não cria order;
- POST financeiro está separado, protegido e fora desta auditoria;
- confirmação de pagamento depende do webhook, não da URL de retorno;
- métricas existentes são agregadas e o diagnóstico de checkout exclui ids e contato.

## Ranking

| # | Oportunidade | Pontos | Motivo |
|---:|---|---:|---|
| 1 | Continuidade de atribuição | 15/15 | falha diretamente comprovada no código; baixo esforço e risco |
| 2 | Catálogo orientado pelo problema | 13/15 | muitas categorias competem no mesmo nível |
| 3 | Prova prática existente | 13/15 | reduz incerteza sem criar conteúdo |
| 4 | Source/campaign até pago, agregado | 12/15 | necessário para receita atribuída; maior risco operacional |
| 5 | Baseline de desempenho de campo | 11/15 | faltam LCP, INP e CLS reais |
| 6 | Prova social real | 10/15 | deve permanecer bloqueada sem avaliações verificadas |

A ordem usa impacto, evidência, facilidade, segurança e custo zero, de 0 a 3. Empates são resolvidos apenas pelo identificador para determinismo; não provam superioridade comercial.

## Três experimentos

### C4-01 — Continuidade de UTM

Prova de prontidão em preview isolado, sem POST financeiro. Deve preservar source/campaign em pelo menos 95% da matriz válida, sem rótulo inválido, PII ou alteração do checkout. Se qualquer ordem for criada, o teste falha e para.

### C4-02 — Catálogo por problema

Comparar o catálogo atual com um topo de três caminhos: IA, vendas e caixa. O catálogo completo permanece abaixo. Métrica: visitas limpas às três páginas de produto divididas pelos visitantes limpos de `/solucoes`, por variante. Só vence com amostra mínima, intervalo de 95% totalmente acima de zero e guardrails verdes.

### C4-03 — Prova prática existente

Adicionar como CTA secundário recursos já existentes: guias por ramo, guias WhatsApp, calculadora de fluxo e checklist. Métrica: `checkout_intent / visitantes limpos` por variante. Não há novo conteúdo, desconto, urgência artificial ou formulário adicional.

Os limiares são regras de decisão futuras, não previsões de resultado. Falta de amostra em 28 dias produz “inconclusivo”, nunca sucesso.

## Fontes e limites de aplicação

- O [funil interno](https://github.com/arbmsistone-lab/zevanory-public-mirror/blob/c3717aeb325e7acc6108177426ca420e565bb575/worker/funnel.mjs) e o [router comercial](https://github.com/arbmsistone-lab/zevanory-public-mirror/blob/c3717aeb325e7acc6108177426ca420e565bb575/worker/sales-public-worker.mjs) sustentam o mapa e as lacunas.
- A pesquisa do [Baymard sobre abandono](https://baymard.com/research-articles/ecommerce-checkout-usability-report-and-benchmark) é referência geral de e-commerce, não medição ou meta da ZEVANORY.
- O [web.dev](https://web.dev/articles/vitals) recomenda LCP ≤ 2,5 s, INP ≤ 200 ms e CLS ≤ 0,1 no percentil 75; laboratório não substitui campo.
- O [Banco Central](https://www.bcb.gov.br/estabilidadefinanceira/pix-em-numeros-estatisticas) prova adoção ampla do Pix no Brasil, não conversão da ZEVANORY.
- A documentação do [Checkout Pro](https://www.mercadopago.com.br/developers/pt/docs/checkout-pro-orders/web-integration/redirect-buyer-to-checkout?scope=prod) confirma o redirecionamento ao provedor; isso não é, por si só, defeito de conversão.
- A orientação oficial sobre [direito de arrependimento](https://www.gov.br/mj/pt-br/assuntos/noticias-1/dia-dos-pais-conheca-os-direitos-do-consumidor-na-compra-de-presentes) sustenta a clareza dos sete dias, sem transformar obrigação legal em promessa promocional.

## Fronteira operacional

Codex não implementa os experimentos. Qualquer variante, evento, UTM adicional ou associação agregada até pagamento pertence a PR operacional separado do Claude, após o Marco A, autorização do proprietário e auditoria. Este pacote não altera Worker, funil, checkout, pagamento, workflow, credencial, preço ou página pública.
