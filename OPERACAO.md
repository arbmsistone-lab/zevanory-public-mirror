# ZEVANORY · Manual de operação (o que a empresa sabe e faz sozinha)

Este é o conhecimento operacional da ZEVANORY. Tudo que está aqui roda sozinho ou é
gerado pronto pela própria ZEVANORY. Só sobe para o dono o que é ato dele (login, 2FA,
contrato, gasto) e só vai para o executor de navegador o que a plataforma não permite
fazer por API.

## 1. Regras do dono (sempre valem)

- Sem ordem escrita do dono: nada de gasto, cobrança/reembolso real, mudança em pagamentos,
  pedidos, banco, secrets, gates/checks/pins ou regras do interruptor de vendas (fechar é permitido).
- Nunca expor credenciais ou dados de cliente. Repositório é público.
- Mensagem só para quem pediu (opt-in). Sem spam, sem depoimento inventado, sem prova inventada.
- Aceitar contrato em nome da empresa é ato do dono.
- **Tráfego pago só depois da 7ª venda real**, com o relatório de qual criativo/canal vendeu.
- **Custo zero (cláusula permanente):** só planos e cotas gratuitas. Cada motor confere a cota antes de agir
  (`scripts/channels/usage.mjs`, KV `zpc:usage:v1:<dia>`); sem alternativa gratuita a função para e aparece
  na Central de Comando. Proibido migrar para plano pago. Registro de provedores: `data/providers.json`.
- **Vendas liberadas** (decisão do dono em 12/10/2026): site (Mercado Pago) e Hotmart vendendo.

## 2. O que roda sozinho (horário de Brasília)

| Quando | O quê | Onde |
|---|---|---|
| A cada hora (:00) | Rotina principal: funil, alertas, saúde | worker `zevanory` (cron) |
| :05 de cada hora | Perfis das redes no padrão da marca; fila do Conteúdo Pronto | worker `zevanory` |
| 00:00 | Artigo novo do blog | worker `zevanory` |
| 09:35 | Divulgação do blog | worker `zevanory` |
| 09:40 | IndexNow (Bing e outros) com os sitemaps | `indexnow-submit.yml` |
| 12:00 | Vídeo do dia no TikTok (agendado no TikTok Studio pelo pacote) | TikTok |
| 12:35 | Post no Telegram | worker `zevanory` |
| 10:00 · 15:00 · 19:00 (+20:30 reserva) | 3 Shorts/dia: dica por ramo, produto do dia, calculadora (YouTube + cross-post); voz Gemini com reserva local gratuita (Piper) | `youtube-autonomous-short.yml` |
| A cada hora (:17) | Central de Comando: vendas, funil, alcance, autonomia certificável, experimentos, custos | `command-center-snapshot.yml` |
| Segunda 06:20 | Inteligência de mercado (buscas reais por ramo, pontuação) | `market-weekly.yml` |
| 19:35 | Post no Bluesky com hashtags | worker `zevanory` |
| Dias 1, 11 e 21 (06:00, reserva 07:30) | Pacote de 10 vídeos com voz + **comando pronto do executor enviado por e-mail ao dono** | `short-pack.yml` |
| Segunda 07:48 | Auditoria semanal com números reais | tarefa agendada |

## 3. Canais e como cada um é ativado

| Canal | Estado | Como ativa / mantém |
|---|---|---|
| Site, guias (40), calculadoras (7) | Ativo | Deploy central; sitemaps + IndexNow |
| Google Search Console | Ativo | Sitemaps enviados; pedidos de indexação pelo executor quando há páginas novas |
| Bing Webmaster | Ativo | Sitemaps cadastrados; IndexNow diário |
| YouTube | Ativo, público | OAuth do dono (painel → Conectar canais) |
| Telegram | Ativo | Bot no canal |
| Bluesky | Ativo | Senha de app no bundle de credenciais |
| TikTok | Ativo por agendamento | API proibida para conta própria (diretrizes do TikTok); pacote a cada 10 dias + executor |
| Instagram / Facebook | Aguardando Meta | Ao aprovar: secrets `META_ACCESS_TOKEN`, `INSTAGRAM_BUSINESS_ACCOUNT_ID`, `META_PAGE_ID` → Reels e vídeo diários entram sozinhos |
| Pinterest | Aguardando aprovação | Ao aprovar: `PINTEREST_CLIENT_ID/SECRET`, conectar no painel, `PINTEREST_BOARD_ID` |
| Hotmart | 1 vendendo, 5 em análise | Webhook ativo; afiliados 50%; links com `src` de origem |

## 4. Tarefas recorrentes do executor (geradas prontas pela ZEVANORY)

1. **TikTok, a cada 10 dias:** uma tarefa agendada roda no computador do dono (dias 1, 11 e 21,
   08:00) e agenda sozinha os vídeos no TikTok Studio pelo Chrome. O mesmo comando também chega
   por e-mail como reserva. Requisito físico: computador ligado, app Claude aberto e Chrome logado.
2. **Search Console:** quando muitas páginas novas entram, pedir indexação das principais
   (limite diário do Google; se responder "tente mais tarde", parar e retomar no dia seguinte).
3. **Nome de exibição do TikTok:** trocar para "ZEVANORY" quando liberar (a partir de 18/10/2026).

## 5. Metas e decisões automáticas

- Diária: 3 publicações, ≥1 conversa, ≥1 checkout a partir da 2ª semana.
- 1ª venda até 18/10/2026; quinzena (até 25/10) R$ 800; mês (até 10/11) R$ 2.000.
- Se a quinzena fechar abaixo de R$ 400: trocar oferta ou preço (proposta ao dono com dados).
- Na 7ª venda: relatório por origem (`sources` e `topCampaigns` no resumo do funil + relatório
  de vendas da Hotmart por `src`) → proposta de teste pago ao dono.

## 6. Onde ver os números

- Painel: https://controle.zevanory.api.br → Central de Comando (7 abas: Agora, IA, Desempenho, Funciona?, Operação, Financeiro, Rumo). Todo número mostra fonte, horário e selo de integridade.
- Resumo do funil (KV `zpc-funnel:v1:summary`): visitas, intenção de compra e origem por canal.
- Hotmart → Relatórios → Vendas, coluna de origem (`src`).

## 7. Incidentes comuns e resposta

| Sintoma | Resposta |
|---|---|
| Short sem voz | Chave Gemini do GitHub inválida → dono gera nova em aistudio.google.com (conta zevanory@gmail.com, projeto ZEVANORY Automation) e cola em `GEMINI_API_KEY` |
| Deploy do painel falha com TRUST_CORE_BLOCKED | Esperar o reconciliador do SHA de produção e redisparar |
| certify(*) falha durante deploy | Reexecutar só os jobs falhos |
| Limite de crons da Cloudflare (5) | Nunca remover os crons do worker `zevanory`; novos projetos usam Durable Object com alarme ou GitHub Actions |
| Executor não consegue enviar vídeo ao TikTok | A aba precisa estar visível; recarregar a página |

## 8. Autocorreção

- Toda rotina de publicação é idempotente por dia: rodar de novo nunca duplica, só completa o que faltou.
- Short diário tem execução de reserva às 16:30; o pacote do TikTok, às 07:30 dos dias 1, 11 e 21.
- Falha em workflow gera e-mail automático do GitHub ao dono; a auditoria de segunda consolida tudo.
