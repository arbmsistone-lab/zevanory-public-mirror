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
8. Nenhuma etapa pode ser encerrada com erro conhecido, pendencia tecnica aberta ou validacao parcial.
9. Todo fechamento exige 3 auditorias finais independentes: local/testes, auditoria 3X estrutural e prova operacional em producao.
10. Se qualquer uma das 3 auditorias falhar, a etapa permanece BLOQUEADA e nao pode ser declarada concluida.
## GATES
EG: 3 evidencias -> G0 Mercado -> G1 Oferta -> G2 Venda manual -> G3 Telemetria -> G4 Baseline -> G5 IA offline -> G6 IA assistida -> G7 Experimento causal -> G8 Rentabilidade -> G9 Repeticao -> G10 Generalizacao -> G11 Escala -> G12 Autonomia.

## JA APROVADO
G0: PMEs brasileiras com venda/atendimento digital e forte componente manual.
G1-A: primeiro subnicho de investigacao: educacao profissional/cursos.
G1-B: OFFER-0001 — IA aplicada a Vendas e Atendimento no WhatsApp, como hipotese para teste.
G1-C: preco experimental R$297–R$797; hipotese central R$497; nao validado comercialmente.
WhatsApp oficial: +55 88 99234-0423 / E.164 5588992340423.
Infraestrutura G2: homepage institucional em /, piloto comercial em /piloto, telemetria persistente Neon e runtime auditado.
Deploy Vercel: projeto zevanory-site em producao READY.
Auditoria atual: 40/40 testes e 31/31 unidades 3X; tres auditorias finais da camada Asaas atual aprovadas.

## ESTADO ATUAL
EXP-0001: PRONTO TECNICAMENTE / NAO INICIADO COMERCIALMENTE.
G2 comercial: ABERTO. Nao existe pagamento real reconciliado.
Telemetria publica em producao: ATIVA e persistente no Neon; idempotencia comprovada por event_id.
Eventos financeiros: BLOQUEADOS para venda real. Camada Asaas implementada com authToken, reconciliacao por GET /payments/{id}, idempotencia financeira e migration 002 aplicada; ainda faltam credenciais Asaas proprias, vinculo com pedido interno real, validacao Sandbox e cobertura de estorno parcial antes de producao financeira.
Dominio zevanory.api.br: NAO associado ao projeto Vercel neste estado; tentativa de associacao retorna 403 domain_not_owned.
TXT de verificacao anteriormente registrado: deve ser reconfirmado somente depois que a Vercel reconhecer a posse do dominio; nao tratar o valor anterior como prova atual.
DNS publico atual: nome existe sem endereco A/AAAA funcional; TXT _vercel ainda ausente.
Git ZEVANORY: sem remote/origin configurado; commits atuais ainda nao possuem sincronizacao Git remota comprovada.

## PROXIMOS PASSOS AUTORIZADOS
1. Concluir verificacao DNS e associacao funcional de zevanory.api.br.
2. Revalidar dominio em pelo menos 3 resolvedores + HTTPS + rotas publicas.
3. Persistencia Neon aprovada; manter monitoramento, idempotencia e reconciliacao.
4. Asaas selecionado pelo EG-0013; obter credenciais Sandbox proprias e validar pedido -> checkout -> webhook -> reconciliacao antes de qualquer pagamento real.
5. Iniciar EXP-0001 e buscar comportamento economico real.
6. Nao avancar para IA autonoma antes dos gates G2–G7 correspondentes.