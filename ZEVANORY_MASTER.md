# ZEVANORY - DOCUMENTO MESTRE CANONICO

Status: FONTE DE VERDADE PARA CONTINUIDADE.
Regra: ler este arquivo antes de qualquer pesquisa, decisao, codigo, deploy ou mudanca de escopo.

## OBJETIVO
Construir um motor digital de vendas por IA que prove venda real, atribuicao confiavel e margem antes de ganhar autonomia.
Nao construir um painel que apenas aparenta atividade.

## TRAJETO APROVADO - NAO PULAR
Mercado real -> Oferta -> Aquisicao -> Origem -> Intencao -> Conversa/carrinho -> Checkout -> Pagamento confirmado -> Entrega/refund -> Custos -> Margem de contribuicao -> Experimento -> Aprendizado -> Proxima acao.

## CAMADAS
Deterministica: pagamento, preco, custos, permissoes, limites, atribuicao, deduplicacao, reconciliacao e compliance.
IA: pesquisa, priorizacao, personalizacao, criacao, recomendacao e execucao reversivel dentro de limites.
Experimentos: hipotese, baseline/controle, metrica principal, diagnosticos, guardrails e criterio de parada.

## REGRAS INVIOLAVEIS
1. Minimo 3 evidencias independentes antes de qualquer implementacao relevante.
2. Minimo 3 operacoes aprovadas depois de cada codigo ou definicao critica.
3. Falha critica bloqueia avanco; nao existe maioria para ignorar blocker.
4. IA nao declara pagamento, margem ou venda sem fonte transacional autenticada.
5. Single-agent primeiro; multi-agent somente se evals comprovarem ganho.
6. Autonomia so depois de prova comercial, telemetria, baseline e experimento.
7. Nenhum dashboard pode simular trabalho, venda ou resultado.
8. Nenhuma etapa pode ser encerrada com erro conhecido, pendencia tecnica aberta ou validacao parcial.
9. Todo fechamento exige auditorias finais independentes e prova operacional em producao.
10. Se qualquer auditoria falhar, a etapa permanece BLOQUEADA.
11. Toda montagem ou alteracao de infraestrutura exige, antes de promocao ou fechamento, 3 auditorias independentes e registradas: Auditoria 1 estrutural/configuracao; Auditoria 2 funcional/seguranca/integridade; Auditoria 3 integracao/regressao/prova operacional. As 3 devem estar APROVADAS; qualquer falha, divergencia ou erro conhecido bloqueia a infraestrutura.
12. Nenhum processo de venda pode iniciar enquanto houver qualquer etapa pre-venda obrigatoria aberta ou auditoria pendente/reprovada. SALE_GLOBALLY_ENABLED e PRE_SALE_GATES_APPROVED devem ser explicitamente true, alem do gate especifico do canal; ausencia ou divergencia equivale a vendas BLOQUEADAS.

## GATES
EG: 3 evidencias -> G0 Mercado -> G1 Oferta -> G2 Venda manual -> G3 Telemetria -> G4 Baseline -> G5 IA offline -> G6 IA assistida -> G7 Experimento causal -> G8 Rentabilidade -> G9 Repeticao -> G10 Generalizacao -> G11 Escala -> G12 Autonomia.

## JA APROVADO
G0: PMEs brasileiras com venda/atendimento digital e forte componente manual.
G1-A: primeiro subnicho de investigacao: educacao profissional/cursos.
G1-B: OFFER-0001 - IA aplicada a Vendas e Atendimento no WhatsApp, como hipotese para teste.
G1-C: preco experimental com hipotese central de R$ 497; nao validado comercialmente.
WhatsApp oficial: +55 88 9234-0423 / E.164 558892340423.
Dominio zevanory.api.br: aprovado tecnicamente com HTTPS e rotas publicas.
Persistencia Neon, telemetria, checkout sandbox Asaas, reconciliacao financeira, idempotencia, DR, observabilidade e hardening de seguranca aprovados nas etapas anteriores.

## ESTADO ATUAL
EXP-0001: PRONTO TECNICAMENTE / NAO INICIADO COMERCIALMENTE.
G2 comercial: ABERTO. Nao existe pagamento real de producao reconciliado.
Telemetria publica: ativa e persistente.
Eventos financeiros reais: BLOQUEADOS.
SALE_GLOBALLY_ENABLED=false, PRE_SALE_GATES_APPROVED=false, CHECKOUT_ENABLED=false, WHATSAPP_SALES_ENABLED=false e FINANCIAL_EVENTS_ENABLED=false permanecem fail-closed.
Schema canonico atual: 15 tabelas, migrations 001-010.
Release estrutural atual: ZEVANORY-EG0039-FINAL.

## PROXIMOS PASSOS AUTORIZADOS
1. Manter monitoramento de DNS, HTTPS, banco, observabilidade e rollback.
2. Nao ativar venda, checkout comercial, WhatsApp comercial ou eventos financeiros reais sem aprovacao integral pre-venda.
3. Nao declarar forecast ou scoring preditivo sem baseline real suficiente.
4. Manter Gemini opcional e fail-closed; ausencia de chave deve degradar para modo deterministico seguro.
5. Manter adapters e infraestrutura provider-agnostic e composable.
6. Promover somente releases que passem testes, auditorias, build, CI, producao, observabilidade e rollback.

## FASE EG-0033 - NO-INVENTORY COMMERCE READY
Release: ZEVANORY-EG0033-FINAL.
Modelo comercial sem estoque proprio: servicos proprios digitais/remotos e produtos fisicos apenas como afiliados.
Receita afiliada somente apos comissao confirmada pela rede/plataforma.
Schema de referencia da fase: 9 tabelas e migrations 001-007.

## FASE EG-0034 - COMMAND CENTER READY
Release: ZEVANORY-EG0034-FINAL.
Central operacional com prioridades, pipeline health, next-best-action por regras, readiness e ausencia explicita de forecast inventado.

## FASE EG-0035 - AUTONOMOUS REVENUE ENGINE READY
Motor central single-agent com provider de IA desacoplado, fallback deterministico, tool registry, policy por risco, eval gate, memoria, knowledge base, fila transacional, auditoria de runs e adapters de canais.
Migration 008 adiciona agent_jobs, agent_runs, knowledge_documents, agent_memory e agent_tool_audit.
Execucao comercial permanece bloqueada; Gemini e opcional e nunca e requisito para manter o motor seguro.

## FASE EG-0036 - COMPOSABLE COMMERCE INFRASTRUCTURE
Release estrutural: ZEVANORY-EG0036-FINAL.
Benchmark confronta Shopify Hydrogen/Oxygen, commercetools MACH, Salesforce Composable Storefront, Adobe Commerce Cloud e BigCommerce Catalyst.
Decisao aprovada: monolito modular composable, API-first, headless-ready, cloud-native, portas/adaptadores e migracao incremental por strangler pattern.
Microservicos distribuidos nao sao obrigatorios nesta escala e nao foram introduzidos sem necessidade comprovada.
Migration 009 adiciona transactional outbox PostgreSQL/Neon com idempotencia, retry exponencial limitado, concorrencia por SKIP LOCKED e dead-letter.
Schema canonico: 15 tabelas e migrations 001-010.
Infraestrutura sem dependencia obrigatoria de novo provedor pago.
Todos os kill-switches comerciais/financeiros permanecem false; esta fase nao autoriza vendas, checkout comercial, WhatsApp comercial, eventos financeiros reais ou autonomia comercial.
Fechamento exige auditorias legadas, engine 20X, composable 10X repetido, auditoria 3X, DR, prova de producao e auditoria final 20X.

## FASE EG-0037 - ENTERPRISE OPERATIONAL ASSURANCE
Release estrutural: ZEVANORY-EG0037-FINAL.
Formaliza SLOs sem declarar historico inexistente, health de outbox e IA, contratos de fornecedores, carga read-only, secret scan e monitor recorrente de producao.
Runbook canonico passa a exigir schema 15x10, /api/assurance e verificacao de dead-letter/idade de backlog.
Git remoto e origin estao configurados e a release so e promovida apos commit, push, deploy e prova operacional no dominio oficial.
Nenhuma melhoria da EG-0037 habilita venda, checkout comercial, WhatsApp comercial, evento financeiro real ou autonomia comercial.

## FASE EG-0038 - COMMERCIAL ACTIVATION + PREMIUM SINGLE-SCREEN
Release estrutural: ZEVANORY-EG0038-FINAL.
A infraestrutura expoe readiness comercial sem valores secretos e sem habilitar vendas automaticamente.
GET /api/activation/readiness informa fase, blockers, ordem de cutover e rollback; inputs externos nunca podem ser fabricados para obter PASS.
A pagina principal e um control room premium de tela unica, sem rolagem vertical ou horizontal no desktop homologado, preservando dados e IDs operacionais reais.
O cutover comercial permanece fail-closed: inputs externos validados, depois pre-sale/channel gates e somente por ultimo SALE_GLOBALLY_ENABLED=true.
Nenhuma regra visual habilita vendas, checkout, WhatsApp, eventos financeiros ou autonomia.


## FASE EG-0039 - ARBM SIST OFFER LAUNCH READY
Release: ZEVANORY-EG0039-FINAL.
OFFER-0001 passa a usar ARBM SIST 10.0.0 como artefato canonico de pre-lancamento, produto digital proprio sem estoque, com preco piloto de R$ 497 ainda nao validado comercialmente.
Landing /arbm-sist rastreia origem por canal e opera em pre-lancamento enquanto vendas estiverem bloqueadas.
Canais primarios: ZEVANORY, YouTube, Instagram e WhatsApp. Metricool existe, mas redes ainda precisam estar conectadas antes de publicacao automatica.
Entrega exige pedido paid, payment_confirmed reconciliado e referencia segura do artefato; download publico e proibido.
Artefato tecnico canonico: ARBM-SIST-v10.0.0.zip, SHA-256 70F233FA2AD84B66468CCB4789E3628A171ABA97A6C5C188C01A1EF56659B4E0. V10 permanece unsigned/not public e exige gates EG-0063 antes de liberacao comercial.
Todos os kill-switches comerciais e financeiros permanecem fail-closed ate meio de pagamento PF valido e cutover explicito.

## FASE EG-0040 - IDENTIDADE OFICIAL + PARIDADE LOCAL
Marca oficial ZEVANORY versionada em `brand/official/` e publicada por cópia controlada em `public/brand/`.
Logo e favicon são self-hosted e exigidos pelo identity guard; CDN externo para identidade é proibido.
Servidor local passa a servir HTML, CSS, JavaScript e SVG de `public/` com MIME explícito, `nosniff`, CSP e bloqueio de path traversal.
A identidade oficial deve permanecer consistente em `/`, `/arbm-sist`, `/piloto`, `/termos`, `/privacidade`, `/reembolso` e `/afiliados`.
Nenhuma mudança desta fase altera gates comerciais, financeiros, jurídicos ou de autonomia.

## FASE EG-0041 - WORLD-CLASS EXECUTIVE DASHBOARD
A pagina principal prioriza leitura em relance, hierarquia executiva e densidade controlada com Evidence Gate baseado em AWS Cloudscape, IBM Carbon e Atlassian Design System.
Sete KPIs de primeira ordem permanecem no topo; oferta segue representada no funil e runtime sem competir como KPI primario.
Garantias aparecem resumidas na visao executiva, mantendo a lista completa como evidencia de interface.
Estados comerciais false nunca usam semantica visual de sucesso; true comercial seria estado de risco ate cutover formal.
Single-screen, identidade oficial, verdade comercial e todos os kill-switches fail-closed permanecem obrigatorios.

## EG-0042 — FINAL VISUAL CERTIFICATION
Dashboard executivo final: zero scroll global, zero truncamento detectado, coluna operacional sem overflow interno em 1280x720 e estados comerciais fail-closed preservados. Gate obrigatorio: `npm run audit:visual:10x`.

## EG-0044 — CANONICAL EXECUTIVE VISUAL SYSTEM
A pagina principal passa a usar uma unica arquitetura visual canonica, substituindo a pilha acumulada de overrides EG-0041/0042/0043.x.
O contrato visual exige zero scroll, zero truncamento, zero overflow interno e nenhum campo operacional oculto para fazer caber.
Piso tipografico homologado: 9 px no viewport efetivo de 1280x720 e 10 px em desktop alto/1600x900.
O rodape identifica dinamicamente o host acessado e labels visiveis de governanca/assurance sao apresentados em portugues, sem alterar chaves tecnicas internas.
Nenhuma mudanca EG-0044 altera backend, schema, oferta, pagamentos, canais ou kill-switches; todos permanecem fail-closed.

## FASE EG-0045 - PREMIUM EXECUTIVE CONTROL ROOM
A pagina principal adota uma arquitetura executiva premium com menos contornos, mais hierarquia por superficie/espacamento e maior area util para leitura.
O layout permanece single-screen, sem rolagem, sem truncamento e sem esconder campos operacionais para caber.
Piso tipografico homologado: 9 px em 1280x720 e 10 px em 1600x900.
A coluna de decisao ocupa menos area, o centro executivo domina a leitura e a coluna operacional recebe largura suficiente para os dados reais.
Nenhuma mudanca desta fase altera backend, schema, checkout, vendas, WhatsApp comercial, eventos financeiros ou autonomia; todos os kill-switches permanecem fail-closed.
## EG-0046 — Progressive Executive Disclosure
- Status: APPROVED.
- Superficie primaria: 5 KPIs executivos, decisao, funil, prontidao, risco e governanca.
- Evidencia tecnica completa permanece acessivel pelo dialogo `Detalhes operacionais`.
- 1280x720 homologado com fonte primaria minima de 11 px, zero scroll, zero truncamento e zero overflow interno.
- 1600x900 homologado com fonte primaria minima de 12 px, zero scroll, zero truncamento e zero overflow interno.
- Scroll interno permitido exclusivamente no dialogo tecnico explicitamente aberto pelo usuario.
- Nenhum gate comercial ou financeiro foi alterado; todos permanecem fail-closed.

## REGRA INSTITUCIONAL - MARCA-MAE E PORTFOLIO
ZEVANORY e a marca-mae, operacao comercial e infraestrutura institucional.
ARBM SIST e apenas um produto do portfolio ZEVANORY, assim como futuras ofertas proprias, afiliadas ou de parceiros.
Contas sociais, WhatsApp, e-mail, CRM, Metricool, canais e identidade publica devem representar ZEVANORY, nunca um produto isolado.
Produtos podem ter landing pages, campanhas, criativos, UTMs e metricas proprias sem substituir a identidade institucional da ZEVANORY.
Esta separacao e estrutural e nao altera gates comerciais, financeiros ou de autonomia.
## EG-0047 — PAYMENT PROVIDER ABSTRACTION
- Status tecnico: IMPLEMENTADO / vendas continuam fail-closed.
- ZEVANORY deixa de depender estruturalmente de um unico provedor de pagamento.
- Provedores suportados: Asaas e Mercado Pago, selecionados explicitamente por PAYMENT_PROVIDER.
- Mercado Pago usa checkout hospedado, external_reference, webhook autenticado e reconciliacao server-side antes de reconhecer receita.
- Migration 010 amplia orders e financial_events para `asaas` e `mercadopago` sem reescrever migrations historicas.
- Schema canonico: 15 tabelas / 10 migrations.
- Nenhuma conta, token, KYC ou credencial externa e fabricada; ausencia de configuracao mantem vendas bloqueadas.
## EG-0063 — ARBM SIST V10 OFFER RECONCILIATION
ARBM SIST 10.0.0 substitui 8.1.0 como artefato canonico de pre-lancamento da OFFER-0001. O ZIP V10 foi verificado contra manifest e VERIFY-RELEASE-V10_PASS, mas publicCommercialRelease=false e code signing confiavel permanecem bloqueantes. Nenhum gate comercial foi aberto.

## SALES LIFECYCLE CANONICAL V2 — LOCK 39x10
Status: CANONICO / NO-GO COMERCIAL ATE CERTIFICACAO INTEGRAL.

Ciclo obrigatorio: Mercado → ICP → aquisicao → captura → identidade → enriquecimento → scoring → priorizacao → primeira resposta → descoberta → qualificacao → nurturing → objecao → oferta → negociacao → checkout → recuperacao de abandono → pagamento → reconciliacao → fulfillment → onboarding → suporte → adocao → satisfacao → retencao → recompra → upsell → cross-sell → referral → win-back → churn → LTV → atribuicao → unit economics → experimento → aprendizado → previsao → proxima melhor acao → escala.

Regra absoluta de desbloqueio: cada uma das 39 dimensoes deve possuir nota tecnica exatamente 10/10, sem media compensatoria. Alem disso, `audit:lifecycle:10x` deve passar, a paridade producao↔commit auditado deve estar comprovada e a release do lifecycle deve estar explicitamente aprovada.

`SALE_GLOBALLY_ENABLED=true` e `PRE_SALE_GATES_APPROVED=true` isoladamente nunca autorizam venda. O `salesGate` canonico exige a certificacao Lifecycle v2 e todos os gates historicos simultaneamente. Agente, canais, outbound, checkout e autonomia devem convergir para esse mesmo gate, sem bypass por variavel de ambiente.
A certificacao inicial e deliberadamente 0/39: codigo existente nao recebe nota 10 por presuncao. Cada nota deve ser promovida somente por evidencia, testes e auditoria independente.
Customer Lifecycle Engine, Revenue Intelligence e Attribution Engine passam a existir como camadas estruturais; migration 012 adiciona persistencia de lifecycle e atribuicao sem novos campos diretos de PII.
Metricas que dependem de comportamento comercial real permanecem baseline-gated e nunca podem ser inventadas para completar nota.
Enquanto qualquer dimensao estiver abaixo de 10, o estado obrigatorio e NO-GO e os kill-switches permanecem fechados.

## 2026-09-05 — ARBM SIST modelo comercial canônico
O modelo anterior de R$ 497 foi superado. Novo modelo: ZERO R$ 0; PRO R$ 1.197 com licença Stable permanente + 12 meses Continuity; Continuity R$ 79,90/mês a partir do 13º mês; BOOST +R$ 19,90/mês opcional; BYOK; V10 Sovereign Fallback; Zero Cost Firewall e Provider Independence. Nenhuma venda pública é aberta por esta decisão; gates continuam fail-closed.


## REGRA INSTITUCIONAL — UNIVERSAL EXECUTION FABRIC
Status: CANONICA / INVIOLAVEL.
Nenhum fornecedor, cloud, runner, CI, modelo de IA, canal, meio de pagamento, observabilidade ou SaaS pode ser dependencia nominal obrigatoria do nucleo.
O nucleo solicita capacidades e provas; adapters isolam detalhes de fornecedores substituiveis.
Falha ou indisponibilidade de um fornecedor deve rerotear para outro provedor qualificado quando o efeito externo anterior for comprovadamente inexistente.
Se nenhum provedor estiver disponivel, a operacao valida deve permanecer preservada em fila duravel, com idempotencia, evidencia e retry; dependencia externa isolada nao pode causar perda da operacao.
Efeito externo ambiguo exige reconciliacao antes de rerotear para impedir duplicidade.
Gates criticos exigem quorum por dominios de independencia, nunca o nome de um fornecedor especifico.
Provedores pagos nao podem ser requisito quando a politica vigente exigir custo obrigatorio zero.
Workloads pesados permanecem remotos; computador local e apenas control plane e validacao leve.
Novos provedores podem entrar no pool apos qualificacao por capacidade, health, seguranca, custo e evidencia sem reescrever o nucleo.

## 2026-09-08 — Universal Channel Fabric
- Canais outbound passam a ser capacidades substituiveis (`channel:<nome>`), nunca dependencias nominais de um unico fornecedor.
- Um canal conhecido pode preservar/enfileirar operacao mesmo quando o provider nominal estiver indisponivel; disponibilidade de infraestrutura e responsabilidade do Universal Execution Fabric.
- Adapters independentes adicionais podem entrar por registro de providers sem alterar o nucleo do agente ou do outbox.
- Falha comprovadamente anterior ao efeito externo permite reroteamento; efeito ambiguo exige reconciliacao antes de qualquer segundo provider.
- Gates comerciais, identidade, consentimento e compliance continuam fail-closed e nao podem ser contornados pela redundancia.

## 2026-09-08 — Universal Storage Fabric
- Persistencia transacional deixa de ser tratada como simples URL substituivel; failover cego entre bancos e proibido.
- Operacao idempotente cuja indisponibilidade e conhecida antes da primeira tentativa pode ser preservada em Durable Operation Journal e marcada para replay posterior.
- Qualquer falha depois de iniciar tentativa de mutacao e estado ambiguo e exige reconciliacao antes de replay.
- Telemetria publica e intents autenticadas do operador usam `storageOperation` + `executeStorageMutation`; preservacao nao equivale a efeito de negocio executado.
- Aprovar lifecycle, criar/revogar convite de piloto, reconciliar pagamento e demais efeitos dependentes do estado atual continuam fail-closed quando o banco canonico nao pode ser consultado.
- Journal deve ser criptografado, idempotente e provider-neutral; quorum critico conta apenas dominios independentes.
- Esta regra melhora continuidade sem criar multi-master inseguro, sem alterar gates comerciais e sem autorizar vendas.

## 2026-09-08 — Verified Read Fabric
- Leituras operacionais podem rerotear por endpoints Postgres read-only verificados para o mesmo dataset canonico.
- Replica alternativa so entra no pool com `VERIFIED=true`, `READ_ONLY=true` e `DATASET_ID` igual ao dataset canonico.
- Replication lag e tratado como risco real; replica de leitura nao pode virar fonte de verdade para pagamento, reconciliacao financeira ou aprovacao dependente de estado atual.
- `/api/status`, `/api/assurance` e `/api/agent/status` usam o Read Fabric; detalhes de rota nao sao expostos publicamente.
- Ausencia de rota verificada continua fail-closed; nenhum endpoint alternativo e presumido por nome de fornecedor.

## 2026-09-08 — Financial Reconciliation Fabric
- Checkout sem banco canônico não chama provedor; a intenção idempotente pode ser preservada e fica `pending_storage`.
- Resposta de checkout aceita pelo provedor mas não persistida no banco gera evidência criptografada de reconciliação; nunca há segunda criação automática.
- Webhook financeiro autenticado pode ser preservado quando o banco está indisponível, porém journal/snapshot nunca constitui verdade de pagamento.
- Webhooks Asaas/Mercado Pago reconciliam pelo provider do pedido; não existe dependência nominal de `PAYMENT_PROVIDER` para aceitar Mercado Pago.
- Escrita financeira nunca usa read replica; falha após tentativa de mutação exige reconciliação canônica.
- Fulfillment preservado no journal é somente intenção pendente de validação; nunca gera token/link/download.
- Download continua exigindo pedido `paid` + `payment_confirmed` reconciliado no banco canônico e claim transacional de uso único.

## 2026-09-08 — Operational Continuity Fabric
- `agent-run` autenticado preserva o trigger quando o banco está indisponível antes da execução; nenhum trabalho é marcado como executado.
- Falha depois que o agente começou gera registro de reconciliação e proíbe replay cego de efeitos externos.
- `robot-control` valida e preserva comandos autenticados antes da escrita canônica quando o banco está indisponível.
- Falha de comando após tentativa de escrita gera `reconciliation_required`; aprovação/estado nunca é presumido pelo journal.
- Leituras do Robot Control passam pelo Verified Read Fabric; escrita de controle continua canônica.

## 2026-09-08 — OAuth + Confirmation + Provider-Neutral Pre-Sale
- Authorization code OAuth e de uso unico: a troca acontece uma vez; falha de persistencia posterior preserva a credencial somente no journal criptografado e exige reconciliacao.
- Journal OAuth nunca declara conta `connected`; somente persistencia canonica confirmada pode marcar conexao.
- Callback cookie e invalidado depois de troca de codigo mesmo em recuperacao, evitando tentativa de resgate duplicado.
- Confirmacao de provider e atualizacao do Live Action Plan ocorrem em uma unica mutacao SQL atomica; confirmacao journalizada nunca equivale a confirmacao canonica.
- Gate pre-sale exige prova de dominio, HTTPS/rotas e capacidade sandbox de pagamento, nunca Vercel ou um `PAYMENT_PROVIDER` nominal.
- Diagnosticos podem citar adapters especificos, mas blocker critico e sempre por capacidade (`payment_provider_pool_unavailable` / `payment_sandbox_capacity_unavailable`).

## EG-0070 — MARKET + PRODUCT + INVESTMENT INTELLIGENCE
- Status tecnico: IMPLEMENTADO / vendas continuam fail-closed.
- Nova camada separa evidencia de mercado, score de oportunidade, ranking de produtos e decisao `INVESTIR | TESTAR | AGUARDAR | DESCARTAR | EVIDENCIA_INSUFICIENTE`.
- Regra fail-closed: minimo 3 fontes verificadas de 3 organizacoes independentes antes de qualquer conclusao de oportunidade.
- Sinais ausentes nunca recebem valor sintetico; dimensoes incompletas mantem `EVIDENCIA_INSUFICIENTE`.
- `MARKET_RESEARCH_FEEDS` permite malha multi-provedor HTTPS sem dependencia obrigatoria de um fornecedor; menos de 3 provedores independentes mantem pesquisa nao pronta.
- `intelligence_snapshots` persiste pesquisa, ranking e decisoes auditaveis sem PII; migration 024.
- Robot Control Room recebe painel Mercado / Produtos / Vale investir? e telemetria via SSE com reconexao e fallback de leitura.
- Nenhum score de inteligencia substitui o `salesGate`, abre checkout, ativa midia paga ou autoriza publicacao comercial.
