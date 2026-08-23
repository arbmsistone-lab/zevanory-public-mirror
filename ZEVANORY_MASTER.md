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
11. Toda montagem ou alteracao de infraestrutura exige, antes de promocao ou fechamento, 3 auditorias independentes e registradas: Auditoria 1 estrutural/configuracao; Auditoria 2 funcional/seguranca/integridade; Auditoria 3 integracao/regressao/prova operacional. As 3 devem estar APROVADAS; qualquer falha, divergencia ou erro conhecido bloqueia a infraestrutura.
12. Nenhum processo de venda pode iniciar enquanto houver qualquer etapa pre-venda obrigatoria aberta ou auditoria pendente/reprovada. SALE_GLOBALLY_ENABLED e PRE_SALE_GATES_APPROVED devem ser explicitamente true, alem do gate especifico do canal; ausencia ou divergencia equivale a vendas BLOQUEADAS.
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
Auditoria atual: 66/66 testes e 44/44 unidades 3X aprovadas no estado atual. Migration 005 aplicada e verificada no Neon. Release candidata: ZEVANORY-EG0018-RC2, com vendas globalmente bloqueadas. Deploy de producao exige promocao serializada e verificacao do alias antes do fechamento.

## ESTADO ATUAL
EXP-0001: PRONTO TECNICAMENTE / NAO INICIADO COMERCIALMENTE.
G2 comercial: ABERTO. Nao existe pagamento real reconciliado.
Telemetria publica em producao: ATIVA e persistente no Neon; idempotencia comprovada por event_id.
Eventos financeiros: BLOQUEADOS para venda real. Camada Asaas implementada com authToken, reconciliacao por GET /payments/{id}, idempotencia financeira, migrations 002, 003, 004 e 005 aplicadas no Neon. Estorno parcial usa reconciliacao cumulativa apenas de refunds DONE; transicao orders.status ocorre atomicamente com financial_events. SALE_GLOBALLY_ENABLED e PRE_SALE_GATES_APPROVED permanecem OFF por padrao; WhatsApp e checkout nao podem iniciar venda enquanto o gate global estiver bloqueado. Ainda faltam credenciais Asaas proprias e primeiro checkout Sandbox real, somente apos aprovacao integral pre-venda.
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