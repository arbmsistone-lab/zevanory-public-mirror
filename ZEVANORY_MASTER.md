# ZEVANORY — DOCUMENTO MESTRE CANONICO

Status: FONTE DE VERDADE PARA CONTINUIDADE.
Regra: ler este arquivo antes de qualquer pesquisa, decisao, codigo, deploy ou mudanca de escopo.

## OBJETIVO
Construir um motor digital de vendas por IA que prove venda real, atribuicao confiavel e margem antes de ganhar autonomia.
Nao construir um painel que apenas aparenta atividade.

## TRAJETO APROVADO — NAO PULAR
Mercado real -> Oferta -> Aquisicao -> Origem -> Intencao -> Conversa/carrinho -> Checkout -> Pagamento confirmado -> Entrega/refund -> Custos -> Margem de contribuicao -> Experimento -> Aprendizado -> Proxima acao.

## CAMADAS
Deterministica: pagamento, estoque, preco, custos, permissoes, limites, atribuicao, deduplicacao e reconciliacao.
IA: pesquisa, priorizacao, personalizacao, criacao, recomendacao e depois execucao reversivel dentro de limites.
Experimentos: hipotese, baseline/controle, metrica principal, diagnosticos, guardrails e criterio de parada.

## REGRAS INVIOLAVEIS
1. Minimo 3 evidencias independentes antes de qualquer implementacao.
2. Minimo 3 operacoes aprovadas depois de cada codigo/definicao.
3. Falha critica bloqueia avanco; nao existe maioria para ignorar blocker.
4. IA nao declara pagamento, margem ou venda sem fonte transacional autenticada.
5. Single-agent primeiro; multi-agent somente se evals comprovarem ganho.
6. Autonomia so depois de prova comercial, telemetria, baseline e experimento.
7. Nenhum dashboard pode simular trabalho, venda ou resultado.
## GATES
EG: 3 evidencias -> G0 Mercado -> G1 Oferta -> G2 Venda manual -> G3 Telemetria -> G4 Baseline -> G5 IA offline -> G6 IA assistida -> G7 Experimento causal -> G8 Rentabilidade -> G9 Repeticao -> G10 Generalizacao -> G11 Escala -> G12 Autonomia.

## JA APROVADO
G0: PMEs brasileiras com venda/atendimento digital e forte componente manual.
G1-A: primeiro subnicho de investigacao: educacao profissional/cursos.
G1-B: OFFER-0001 — IA aplicada a Vendas e Atendimento no WhatsApp, como hipotese para teste.
G1-C: preco experimental R$297–R$797; hipotese central R$497; nao validado comercialmente.
WhatsApp oficial: +55 88 99234-0423 / E.164 5588992340423.
Infraestrutura G2: landing, telemetria fail-closed, separacao de eventos e runtime auditado.
Deploy Vercel: projeto zevanory-site em producao READY.
Auditoria atual: 20/20 unidades, 3 operacoes por unidade; 22/22 testes antes das mudancas de governanca atuais.

## ESTADO ATUAL
EXP-0001: PRONTO TECNICAMENTE / NAO INICIADO COMERCIALMENTE.
G2 comercial: ABERTO. Nao existe pagamento real reconciliado.
Telemetria publica em producao: bloqueada intencionalmente ate persistencia confiavel.
Eventos financeiros: bloqueados ate provedor de pagamento autenticado.
Dominio zevanory.api.br: associado ao projeto Vercel correto, mas verified=false.
TXT exigido pela Vercel: _vercel.zevanory.api.br = vc-domain-verify=zevanory.api.br,a32ddbb728c60849ecbe.
DNS publico atual: NXDOMAIN para o host ate a configuracao ser concluida.

## PROXIMOS PASSOS AUTORIZADOS
1. Concluir verificacao DNS e associacao funcional de zevanory.api.br.
2. Revalidar dominio em pelo menos 3 resolvedores + HTTPS + rotas publicas.
3. Escolher e integrar persistencia de telemetria somente apos Evidence Gate proprio.
4. Escolher e integrar provedor de pagamento somente apos Evidence Gate proprio.
5. Iniciar EXP-0001 e buscar comportamento economico real.
6. Nao avancar para IA autonoma antes dos gates G2–G7 correspondentes.