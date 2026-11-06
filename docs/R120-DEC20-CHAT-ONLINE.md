# R120 | DEC-20 | Chat Online (candidato, NO-GO)
Data: 2026-11-05. Branch isolada. Sem merge, deploy, alteração de produção, conta nova ou custo autorizado.

## Voto
APROVO COM CONDIÇÕES. Reutilizar o sistema existente `worker/site-chat.mjs`, widget `sales-overlay/site-chat.js`, base `data/site-chat-policy.json` + `worker/support-knowledge.mjs`, PostgreSQL de protocolos e controle canônico de vendas. Não criar outro chat nem outro banco.
WhatsApp permanece fora do fluxo.

## Evidências anteriores ao R120
- O chat anterior já existia em código, mas `SITE_CHAT_ENABLED` era OFF por padrão.
- O proxy de vendas usava `/api/chat` no domínio de vendas e service binding privado para o Core. O módulo do Core somente atendia `chat.internal`.
- O widget de vendas cobria uma lista restrita de páginas; a frente R120 estendeu elegibilidade às rotas HTML informativas do Worker de vendas.
- Base catalogada, bloqueio de checkout, política de retenção, moderação, protocolos idempotentes e testes de IA já existiam. Não equivale a sistema operacional publicado.
- O chat possui tickets próprios (`zevanory_site_chat_tickets`) e link ao formulário `/atendimento`; não demonstramos unificação transacional com a base do formulário. A integração precisa de gate de identidade do protocolo.

## Alterações neste PR
1. Fallback humano em erro explícito de cota de IA; nunca usar outro provedor pago nem checkout.
2. Siteverify do Turnstile (token single-use, action `zevanory_chat`, hostname permitido, fail-closed). Teste local pode injetar resposta mock; sandbox explicitamente separado.
3. Widget próprio de vendas solicita desafio na abertura, usa Siteverify no backend; CSP acrescenta exclusivamente origem Cloudflare para script/frame de segurança.
4. Rota pública canônica `https://zevanory.api.br/api/chat` que reusa o backend existente, com CORS restrito aos dois domínios, sem liberar wildcard.
5. Elegibilidade do widget nas rotas HTML de vendas; produção mantém `SITE_CHAT_ENABLED` OFF.
6. Testes R120 em Node manifest: base ausente, preço/checkout, vendas fechadas, cota, Turnstile e CORS.

## Divergências e bloqueios
- **NO-GO A:** o widget ainda precisa ser integrado e testado em todas as páginas públicas `zevanory.api.br`; a rota pública do Core NÃO injeta automaticamente o widget nem serve seus arquivos estáticos. A página de vendas apenas ganha elegibilidade na branch. Não afirmar que há chat operacional em ambos os domínios.
- **NO-GO B:** a criação de protocolo do chat usa sua própria tabela e não foi comprovada como a mesma fila do formulário `/atendimento`. Exigir transcrição correta, idempotência entre canais, alerta no painel e readback real em ambiente controlado.
- **NO-GO C:** formalizar finalidade e aceite informado antes de colher e-mail no fluxo humano, distinguindo consentimento de outras bases legais LGPD; revisão jurídica do texto.
- **NO-GO D:** sem sitekey/secret Turnstile existentes e homologados, o sistema permanece indisponível, nunca ignorar a validação. Não criar conta nem provisionar credenciais neste PR.
- **NO-GO E:** franquia Workers AI gratuita publicada de 10.000 neurons/dia, mas o orçamento por chamada é variável; `ai_daily_budget=300` chamadas NÃO comprova que 300 cabem na franquia. Medir com telemetria oficial antes de ativar, limitar preventivamente e confirmar fail-closed de erros HTTP/429 do provedor. Nenhuma migração automática para plano pago.
- **NO-GO F:** gates CI, testes de tela móvel/teclado, segurança, autenticação, relatórios de privacidade, políticas e contra-auditoria ainda exigem conclusão no SHA exato.
- **NO-GO G:** o teste do fallback por quota protege erros explicitos do modelo; a fila de protocolos não foi exercitada com queda real do provedor.
- **NO-GO H:** revisar texto de garantia de sete dias, 192 horas e reembolso com a política jurídica canônica, evitando confusão entre arrependimento e prazo de download.

## Matriz de aceite antes de merge
- Duas origens, todas páginas, widget acessível (320 CSS px, zoom 200%, foco, Escape, aria-live), scripts próprios exceto Turnstile.
- `/api/chat` same backend, origem restrita, sem CORS wildcard; Turnstile validado servidor (ação/hostname/replay).
- Zero resposta inventada ou preço fora da Tabela C; vendas fechadas sem link de compra; perguntas sem fonte -> escalonamento.
- Protocolo idempotente na fila oficial, transcrição ligada sem vazar em e-mail/log, confirmação em tela/e-mail, alerta no painel.
- Limites em PostgreSQL, logs sem PII, exclusão/retensão 30/180 dias, e-mail só após informação e escolha.
- Quota diária medida; quando indisponível, link/formulário sem custo, sem compra, sem resposta especulativa.
- CI completo PASS no SHA; revisão independente de Claude; autorização humana distinta para merge e deploy.

## Governança
PR Draft apenas. `SITE_CHAT_ENABLED` continua desligado por padrão nos dois Workers. A presença deste código não significa ativação, custo, credenciais ou publicação. Os PRs #216/#219 não pertencem a esta frente.
