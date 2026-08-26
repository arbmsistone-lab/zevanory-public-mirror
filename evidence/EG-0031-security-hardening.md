# EG-0031 — Security hardening

Status: candidato estrutural; não autoriza vendas.

## Escopo
- dependências e segredos;
- CSP e headers de navegador;
- origem, tipo e tamanho da API pública;
- limite de abuso por sessão;
- autenticação de operador em tempo constante;
- ausência de superfície administrativa pública.

## Evidências
- `npm audit --omit=dev`: 0 vulnerabilidades conhecidas no momento da auditoria.
- `npm outdated --json`: nenhum pacote desatualizado reportado.
- scan de padrões sensíveis encontrou somente nomes de cabeçalho/variável, sem valor secreto versionado.
- HTML principal e piloto sem CSS/JS inline.
- CSP: `script-src 'self'`, `style-src 'self'`, sem `unsafe-inline` ou `unsafe-eval`.
- API pública exige JSON, limita payload a 4096 bytes e rejeita Origin divergente do domínio oficial.
- telemetria pública limita 60 eventos/minuto por `session_id` e retorna HTTP 429.
- operador local usa `timingSafeEqual` e token mínimo de 24 bytes.

## Critério de aprovação
Suíte completa + auditoria 3X + segurança 10X + observabilidade 10X + DR 10X + auditoria 30X + probe de produção, todos verdes.

## Restrições
Todos os kill-switches comerciais/financeiros permanecem desligados. Esta evidência não autoriza venda, checkout comercial, WhatsApp comercial, evento financeiro real ou autonomia.
