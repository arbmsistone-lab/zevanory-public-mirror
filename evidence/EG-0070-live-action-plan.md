# EG-0070 — Plano de Ação Vivo / Transparência Pré-Execução

Status: APROVADO COM RESTRIÇÕES
Data: 2026-09-08
Decisão proposta: persistir um manifesto inspecionável antes de cada ferramenta do agente e atualizar o mesmo manifesto após o desfecho.
Problema: a observabilidade atual registra decisão/efeito, mas não garante uma superfície universal de intenção antes da execução.

## Evidência 1 — HashiCorp Terraform
Fonte: https://developer.hashicorp.com/terraform/cli/commands/plan
Classe: A — documentação técnica oficial.
Constatação: `terraform plan` cria um plano de execução, mostra as mudanças propostas e não as aplica; o fluxo permite revisar antes de `apply`.
Limite: padrão de infraestrutura, não de agente comercial.

## Evidência 2 — Kubernetes
Fonte: https://kubernetes.io/docs/reference/using-api/api-concepts/#dry-run
Classe: A — documentação técnica oficial.
Constatação: dry-run permite validar/observar uma requisição sem persistir o efeito pretendido.
Limite: não define conteúdo de um manifesto operacional para agentes.

## Evidência 3 — OpenAI Agents SDK
Fonte: https://openai.github.io/openai-agents-js/guides/human-in-the-loop/
Classe: A — documentação técnica oficial.
Constatação: chamadas sensíveis podem pausar antes da execução, expor a interrupção e somente continuar após aprovação/rejeição; argumentos malformados falham fechados.
Limite: a ZEVANORY não depende do SDK e deve manter sua própria trilha persistente.

## Convergência e contradições
As três fontes convergem em separar intenção/validação da aplicação do efeito e em tornar ações sensíveis revisáveis antes da execução.
Não há exigência universal de um formato único; portanto o contrato ZEVANORY é próprio, PII-minimizado e fail-closed.

## Contrato aprovado
Antes de executar qualquer ferramenta escolhida, persistir: o que, onde, por quê, objetivo, canal, conta/referência não sensível, conteúdo/oferta resumido, risco, custo estimado, necessidade de aprovação e resultado esperado.
O manifesto deve existir antes de `executeTool` e possuir `manifest_id`, `job_id`, `run_id`, `trace_id`, `created_at`, `updated_at` e `state`.
Estados canônicos: `planned`, `awaiting_approval`, `executed`, `failed`, `blocked`, `canceled`.
Após o desfecho, atualizar o mesmo `manifest_id`, sem apagar o plano original, adicionando resultado/prova e horário.

## Restrições
- Nenhuma credencial, PII, `contact_ref`, `session_id`, corpo integral sensível ou token entra na superfície do operador.
- Esta frente não abre vendas, checkout, canais ou autonomia.
- Aprovação humana existente permanece soberana.
- Se a persistência prévia do manifesto falhar, a ferramenta não executa.
- Ações externas continuam sem ser tratadas como efeito confirmado até reconciliação do provedor.

## Veredito
APROVADO COM RESTRIÇÕES.
Critério pós-implementação: testes focados + suíte integral + auditoria 3X + prova de que `persistLiveActionPlan` ocorre antes de `executeTool`.
Rollback: remover integração do worker/API/UI; nenhum schema novo é necessário.

## Validação da implementação — 2026-09-08
- Testes focados da cadeia: 16/16 PASS, incluindo manifesto pré-execução, aprovação, estados, Control Room e confirmação WhatsApp/Resend.
- Auditoria 1 — estrutura/configuração: APPROVED 8/8.
- Auditoria 2 — função/segurança/integridade: APPROVED 7/7.
- Auditoria 3 — integração/regressão: APPROVED 6/6.
- Gate automatizado: `npm run audit:live-plan:3x`; obrigatório em GitHub Quality Gate, GitHub Quality Control Plane e GitLab quality_core.
- Identity Guard: PASS. Nenhum gate comercial/financeiro foi alterado.
- Vercel Preview: deployment check PASS; conteúdo protegido por Vercel Authentication, portanto fetch anônimo não é prova visual.
- GitHub Actions: infraestrutura indisponível para os runs observados (`runner_id=0`, `steps=[]`); isso não constitui falha de teste, mas impede certificação integral remota enquanto não houver execução real das etapas.

Status desta frente: IMPLEMENTAÇÃO E 3X LOCAL APROVADOS / PROMOÇÃO AINDA FAIL-CLOSED ATÉ CI REMOTO EXECUTAR E PASSAR.

## Certificação remota — diagnóstico de 2026-09-08
- SHA avaliado: `d47b81f45172f6ee631b59f6b57d6c1642d7e8ac`.
- GitHub Actions: jobs encerram antes de qualquer step, com `runner_id=0`, `runner_name=""` e `steps=[]`.
- A anotação oficial do check-run informa: o job não iniciou porque houve falha recente de pagamento ou porque o spending limit precisa ser aumentado.
- Decisão ZEVANORY: **não aumentar spending limit e não autorizar cobrança**. A exigência de custo zero prevalece.
- Vercel Preview: deployment do SHA concluiu com PASS, porém isso prova deploy/preview, não substitui a suíte integral de CI.
- Netlify backup: deployment atual foi acionado por upload/API, com `commit_ref=null` e `branch=null`; portanto não é evidência válida do SHA desta frente.
- GitLab: branch foi enviada com sucesso, mas a API de pipelines não está acessível pela credencial disponível nesta sessão; nenhuma conclusão de pipeline é inventada.
- Resultado: implementação + testes focados + auditoria 3X permanecem PASS; promoção/merge continua fail-closed até uma suíte remota integral executar de fato.
