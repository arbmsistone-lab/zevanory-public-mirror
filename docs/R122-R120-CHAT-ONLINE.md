# R122 | R120 Chat Online | contra-auditoria de integração e cota
Data: 05/11/2026. Branch candidata Draft #973. NÃO ativa o chat em produção.
## Protocolo oficial
- Histórico: chat independente criava ZC-/SBX- em zevanory_site_chat_tickets; /atendimento registrava ZEV- em zevanory_atendimento_outbox. Não era o mesmo protocolo.
- Candidato R122: SITE_CHAT_OFFICIAL_PROTOCOLS=true (desligado por padrão) exige privacy_ack antes de registrar; obtém as mensagens recentes por sessão, aplica redaction, mapeia categoria e chama registerRequest do módulo oficial atendimento.mjs. Somente o módulo oficial envia confirmação e notificação do dono; não existe segundo e-mail do chat. O consumidor recebe apenas o ZEV definitivo. Falha da admissão/outbox -> 503 com fallback /atendimento.
- O ZC interno continua sendo usado para correlacionar a conversa, não como protocolo final do consumidor.
- Testes: tests/r122-official-chat-handoff.test.mjs (fakes), tests/integration/r122-official-chat-postgres.test.mjs (PostgreSQL efêmero e sink Resend; execução opt-in a comprovar). Não reivindicar E2E verde enquanto o teste PostgreSQL separado não rodar.
## Base oficial
- data/products.json + worker/support-knowledge.mjs + data/politica-unica.json, versão de fonte e fingerprint em worker/site-chat.mjs.
- Tabela C: R$ 97 / 97 / 147 / 157 / 247 para os cinco guias/kits. Não substituir valores por estimativas.
- Garantia de sete dias, condições oficiais de reembolso e entrega dependem de política canônica, jamais texto livre.
- Pergunta sem base -> escalonamento; preço incorreto/inventado -> guarda bloqueia; vendas fechadas -> sem checkout.
## Interface
- Widget primeiro-party no site e vendas, OFF por padrão; somente exceção de segurança Cloudflare Turnstile.
- Aviso explícito de assistente virtual antes de começar; checkbox de ciência do aviso LGPD ANTES do POST com e-mail, campo obrigatório, encaminhamento voluntário.
- Acessibilidade anterior: role=dialog/log, aria-live, ESC/Tab/foco, CSS móvel 320/256; 360px e leitor de tela real precisam evidência Playwright/axe + avaliação humana. Não certificar WCAG AA só com regex.
- Turnstile tem Siteverify no servidor, tokens válidos por 300s e uma utilização; chave e secret existentes devem ser comprovados; zero novas contas.
- CORS allowlist literal: https://zevanory.api.br e https://vendas.zevanory.api.br. IP do usuário não pode vir do cabeçalho x-zev-client-ip enviado pelo cliente.
## Workers AI: cota e estimativas
Documentação oficial Cloudflare verificada em 05/11/2026: 10.000 neurons/dia gratuitos por conta, reset às 00:00 UTC; excedente no Free falha e não pode cobrar. Fonte: https://developers.cloudflare.com/workers-ai/platform/pricing/
R122 remove fallback para 70B e usa SOMENTE @cf/meta/llama-3.1-8b-instruct-fp8-fast, modelo com 4.119 neurons por milhão de tokens de entrada e 34.868 neurons por milhão de saída.
Estimativa de planejamento, NÃO medição real: 1.000 tokens de prompt + 200 tokens de resposta = 4,119 + 6,9736 = 11,093 neurons/chamada. Conversa de 3 respostas = 33,28 neurons. Com 3.000 entrada + 220 saída = 12,357 + 7,67096 = 20,028 neurons/chamada; 3 respostas ~60,08. Limite teórico 10.000/33,28 ~300 conversas ou 10.000/60,08 ~166 conversas, somente SE toda a conta usasse exclusivamente este chat. Orçamento software de até 300 invocações AI por dia, compatível com ~3.328 ou ~6.009 neurons nesses cenários, mas consumo total da conta inclui outros Workers; NÃO comprova disponibilidade ou custo para um volume desconhecido. Medir dashboard de neurons antes de ativar e reduzir orçamento conforme uso da conta.
Falha por quota/429 leva ao formulário /atendimento e e-mail, sem cobrança, sem modelo alternativo pago ou erro silencioso. Modelos podem retornar erro em formato diverso: teste integrado do provider permanece necessário.
## Bloqueios
- Ainda falta E2E PostgreSQL + outbox oficial executado em runner isolado para o teste opt-in; widget 360px com navegador + axe e leitor de tela, confirmação de email e painel, validação de Turnstile em integração e medição real de neurons.
- CI completo do HEAD exato necessário (o cron do Github Actions pode atrasar); mutantes e guards de Worker de vendas precisam PASS real.
- Desligado por padrão: SITE_CHAT_ENABLED e SITE_CHAT_OFFICIAL_PROTOCOLS não devem ser ativados sem GO/autorizações.
- Vendas fechadas, nenhuma alteração em produção, sem merge, deploy, conta ou custo.
