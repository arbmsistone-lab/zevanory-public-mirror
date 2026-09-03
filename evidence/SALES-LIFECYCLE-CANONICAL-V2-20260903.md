# ZEVANORY — Sales Lifecycle Canonical v2

Data: 2026-09-03
Status: BLOQUEADO PARA VENDAS ate certificacao integral.

## Regra de desbloqueio
A venda somente pode ser habilitada quando TODAS as 39 dimensoes do ciclo canonico tiverem nota tecnica exatamente 10/10.
Nota media, maioria, compensacao entre dimensoes ou simples ativacao de variaveis de ambiente nao autorizam venda.
Tambem sao obrigatorios: auditoria Lifecycle 10X aprovada, paridade producao↔commit auditado comprovada e aprovacao explicita da release.

## Ciclo canonico
Mercado → ICP → aquisicao → captura → identidade → enriquecimento → scoring → priorizacao → primeira resposta → descoberta → qualificacao → nurturing → objecao → oferta → negociacao → checkout → recuperacao de abandono → pagamento → reconciliacao → fulfillment → onboarding → suporte → adocao → satisfacao → retencao → recompra → upsell → cross-sell → referral → win-back → churn → LTV → atribuicao → unit economics → experimento → aprendizado → previsao → proxima melhor acao → escala.

## Controle fail-closed
`src/salesLifecycleV2.mjs` e a fonte de certificacao do ciclo.
`src/salesGate.mjs` exige simultaneamente os gates historicos e a certificacao integral do ciclo.
`src/agentPolicy.mjs`, `src/channelAdapters.mjs`, `src/outboundAdapters.mjs`, checkout e politica de autonomia convergem para o gate canonico.
## Novos motores estruturais
- Customer Lifecycle Engine: onboarding, suporte, adocao, satisfacao, retencao, recompra, upsell, cross-sell, referral, win-back e churn.
- Revenue Intelligence: AOV, frequencia, retencao, churn, recompra, margem, LTV estimado, forecast baseline-gated e next-best-action.
- Attribution Engine: first-touch, last-touch, linear e position-based com conservacao integral do credito de receita.
- Persistencia: migration 012 cria perfis/eventos de lifecycle e touchpoints de atribuicao sem adicionar campos diretos de PII.

## Verdade de certificacao
A existencia de codigo nao equivale a nota 10.
A certificacao corrente nasce 0/39 de proposito: nenhuma dimensao recebe 10 sem evidencia e auditoria independentes.
Metricas dependentes de vendas reais, como churn observado, retencao, LTV e previsao, continuam sem valor inventado enquanto nao existir baseline suficiente.

## Estado de liberacao
NO-GO.
Os kill-switches comerciais devem permanecer fechados ate 39/39 em 10/10 + auditoria 10X + paridade de producao + aprovacao da release.

## Cobertura funcional adicional
As 39 dimensoes canonicas possuem ownership tecnico explicito em `src/salesLifecycleCapabilities.mjs`; cobertura estrutural nao concede nota 10 automaticamente.
Pre-venda ganhou `leadIntelligence.mjs` para identidade, enriquecimento verificado, ICP, scoring, priorizacao, discovery gaps e qualificacao baseada em fatos.
Conversa ganhou `conversationLifecycle.mjs` para descoberta, nurturing limitado, politica de objecoes, guardrails de negociacao e recuperacao de abandono com teto de tentativas e opt-out.
A bateria local apos essas camadas ficou em 296/296 testes PASS, auditoria Lifecycle 10/10 PASS e auditoria final 20/20 PASS.
A auditoria Lifecycle foi repetida em 10 ciclos finais consecutivos, todos PASS.
Isto certifica a implementacao dos controles, nao certifica ainda 39 notas 10/10 nem libera venda.
