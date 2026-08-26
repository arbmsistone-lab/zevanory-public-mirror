# ZEVANORY ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â DOCUMENTO MESTRE CANONICO

Status: FONTE DE VERDADE PARA CONTINUIDADE.
Regra: ler este arquivo antes de qualquer pesquisa, decisao, codigo, deploy ou mudanca de escopo.

## OBJETIVO
Construir um motor digital de vendas por IA que prove venda real, atribuicao confiavel e margem antes de ganhar autonomia.
Nao construir um painel que apenas aparenta atividade.

## TRAJETO APROVADO ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â NAO PULAR
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
G1-B: OFFER-0001 ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â IA aplicada a Vendas e Atendimento no WhatsApp, como hipotese para teste.
G1-C: preco experimental R$297ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œR$797; hipotese central R$497; nao validado comercialmente.
WhatsApp oficial: +55 88 99234-0423 / E.164 5588992340423.
Infraestrutura G2: homepage institucional em /, piloto comercial em /piloto, telemetria persistente Neon e runtime auditado.
Deploy Vercel: projeto zevanory-site em producao READY.
Auditoria de referencia: 79/79 testes e 46/46 unidades 3X aprovadas antes da EG-0026. Endurecimento pre-venda consolidado no commit local imediatamente anterior, intitulado security: harden pre-sale sandbox readiness: Asaas Sandbox exige DATABASE_URL, PUBLIC_BASE_URL HTTPS e todos os cinco interruptores comerciais/financeiros desligados. EG-0020 validado formalmente. Migration 005 aplicada e verificada no Neon. EG-0022 aprovado: politica deterministica de replay de checkout centralizada e fail-closed, sem alterar gates comerciais. EG-0023 aprovado: webhook Asaas reconhece sucesso/duplicata com HTTP 200 e preserva falhas explicitas. EG-0024 aprovado: protocolo G3/G4 de EXP-0001 pre-registrado; baseline segue NAO APROVADO ate coleta real e auditoria. EG-0025 aprovado: diagnostico read-only de checkout_uncertain preparado para Asaas Sandbox, sem mutacao automatica de pedido ou evento financeiro. Auditoria operacional da release ativa RC2 segue aprovada: checkout bloqueado globalmente, webhook autenticado e fraude financeira rejeitada. Release de referencia anterior: ZEVANORY-EG0018-RC2; apos promocao auditada da EG-0026, a release oficial passa a ZEVANORY-EG0026-RC1. EG-0019 de dominio/DNS pre-venda aprovado; preflight oficial fail-closed cobre DNS em 3 resolvedores, posse Vercel, HTTPS, rotas publicas e Asaas Sandbox. O deployment final da EG-0026 deve substituir esta referencia somente apos as tres auditorias finais.

## ESTADO ATUAL
EXP-0001: PRONTO TECNICAMENTE / NAO INICIADO COMERCIALMENTE.
G2 comercial: ABERTO. Nao existe pagamento real reconciliado.
Telemetria publica em producao: ATIVA e persistente no Neon; idempotencia comprovada por event_id.
Eventos financeiros: BLOQUEADOS para venda real. Camada Asaas implementada com authToken, reconciliacao por GET /payments/{id}, idempotencia financeira, migrations 002, 003, 004 e 005 aplicadas no Neon. Estorno parcial usa reconciliacao cumulativa apenas de refunds DONE; transicao orders.status ocorre atomicamente com financial_events. SALE_GLOBALLY_ENABLED e PRE_SALE_GATES_APPROVED permanecem OFF por padrao; WhatsApp e checkout nao podem iniciar venda enquanto o gate global estiver bloqueado. Credenciais proprias e o primeiro Checkout Sandbox foram homologados pela EG-0026; isto nao autoriza producao financeira.
Dominio zevanory.api.br: APROVADO tecnicamente. Registro.br publicado; DNS A 216.198.79.1 e TXT _vercel validados em 1.1.1.1, 8.8.8.8 e 9.9.9.9; Vercel mostra Configuracao valida em Producao; HTTPS e certificado validos; /, /piloto, /api/config, /api/release e /api/status respondem HTTP 200. Gates comerciais permanecem bloqueados.
EG-0021 APROVADO em 2026-08-24: ownership Vercel, DNS 3 resolvedores, HTTPS e rotas publicas comprovados. custom_domain_unverified removido do manifest; Asaas Sandbox homologado pela EG-0026 e removido do manifest de blockers.
DNS publico atual: APROVADO e funcional; A 216.198.79.1 e TXT _vercel validados em 1.1.1.1, 8.8.8.8 e 9.9.9.9; Vercel associado a Producao e HTTPS valido.
Git ZEVANORY: sem remote/origin configurado; commits atuais ainda nao possuem sincronizacao Git remota comprovada.

Homologacao Asaas Sandbox EG-0026 APROVADA em 2026-08-25: Checkout hospedado de R$ 497 confirmado, Webhook real capturado no runtime Vercel, reconciliacao por payment.id/checkoutSession endurecida, replay e recovery idempotentes e reembolso integral de R$ 497 confirmado. Harness, Webhook, schema e deployments Preview temporarios removidos ao fechamento. O blocker asaas_sandbox_unconfigured foi removido, mas PRE_SALE_APPROVAL permanece false; os quatro kill-switches comerciais continuam false e venda real/autonomia permanecem bloqueadas.

## PROXIMOS PASSOS AUTORIZADOS
1. Manter verificacao continua de DNS, HTTPS e associacao funcional de zevanory.api.br; EG-0021 permanece APROVADO.
2. Manter monitoramento de regressao do dominio; gate EG-0021 aprovado e revalidado em 3 resolvedores + HTTPS + rotas publicas.
3. Persistencia Neon aprovada; manter monitoramento, idempotencia e reconciliacao.
4. Asaas selecionado pelo EG-0013 e homologado no Sandbox pelo EG-0026; manter monitoramento e nao usar producao financeira antes da aprovacao integral pre-venda.
5. Nao iniciar EXP-0001 comercialmente enquanto qualquer requisito pre-venda, dominio, Asaas Sandbox ou auditoria obrigatoria estiver aberto; somente depois da aprovacao integral, iniciar a prova economica real conforme os gates.
6. Nao avancar para IA autonoma antes dos gates G2ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œG7 correspondentes.

## FASE ESTRUTURAL ATUAL — 2026-08-26
Diretriz do proprietário: vendas ficam fora de escopo até a estrutura técnica estar concluída.
EG-0027: hardening e saúde estrutural aprovados para validação final.
Release candidata: `ZEVANORY-EG0027-RC1`.
Fonte canônica local: `C:\Sistemas\ZEVANORY`, reconciliada com a release oficial anterior antes desta evolução.
Endpoint estrutural: `GET /api/health`, separado de métricas e gates comerciais.
Readiness exige banco acessível, `PUBLIC_BASE_URL=https://zevanory.api.br` e os cinco kill-switches comerciais/financeiros desligados.
Runbook operacional cobre incidente, recuperação e rollback.
Auditoria final desta fase exige, cumulativamente: suíte completa, auditoria 3X, auditoria 30X e prova operacional em produção.
Nenhuma aprovação da EG-0027 autoriza venda, checkout comercial, WhatsApp comercial, evento financeiro real ou autonomia.

## FASE ESTRUTURAL EG-0028 — INTEGRIDADE DE DADOS
Diretriz vigente: vendas permanecem fora de escopo; foco exclusivo na completude estrutural.
EG-0028 adiciona validacao fail-closed de schema no `/api/health`.
Readiness estrutural exige banco alcancavel, quatro tabelas obrigatorias e ledger de migrations 001-005 completo.
A checagem e somente leitura e nao aplica migration automaticamente.
Release candidata: ZEVANORY-EG0028-RC1.

## FASE ESTRUTURAL EG-0029 — DISASTER RECOVERY
Vendas permanecem fora de escopo.
EG-0029 implementa ensaio real de recuperação não destrutivo.
O ensaio usa schema isolado, migrations 001–005 e ROLLBACK obrigatório.
Prova Neon: 4/4 tabelas, 5/5 migrations, nenhuma ausência e persistent_changes=false.
Credencial temporária local removida após a prova.
Rota de desastre: Neon PITR/Branch Restore dentro da retenção configurada.
Release candidata: ZEVANORY-EG0029-RC1.

## FASE ESTRUTURAL EG-0030 — OBSERVABILIDADE
Vendas permanecem fora de escopo e todos os kill-switches seguem bloqueados.
EG-0030 separa liveness (`/api/live`) de readiness (`/api/health`).
Health e status passam a emitir correlação por `x-request-id` e logs JSON estruturados.
O probe operacional valida `/api/live`, `/api/health`, `/api/release` e `/api/status` com timeout fail-closed.
Release candidata: ZEVANORY-EG0030-RC1.
Aprovação exige suíte completa, 3X, DR 10X, observabilidade 10X, 30X e prova de produção.
