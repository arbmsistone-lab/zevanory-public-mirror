# EG-0035 — Autonomous Revenue Engine World Benchmark

Status: implementação concluída para auditoria e promoção.
Release alvo: `ZEVANORY-EG0035-FINAL`.
Escopo: cérebro de IA, fallback determinístico, fila transacional, knowledge/memory, tool policy, channel adapters e evals.

## Referências oficiais usadas
- Google Gemini API: https://ai.google.dev/gemini-api/docs
- Google Gemini function calling: https://ai.google.dev/gemini-api/docs/function-calling
- Google Gemini structured output: https://ai.google.dev/gemini-api/docs/structured-output
- Google Gemini embeddings: https://ai.google.dev/gemini-api/docs/embeddings
- OpenAI Agents / tools: https://platform.openai.com/docs/guides/agents
- Anthropic tool use: https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview
- Salesforce Agentforce: https://www.salesforce.com/agentforce/
- Microsoft Dynamics 365 Sales accelerator: https://learn.microsoft.com/dynamics365/sales/sales-accelerator-intro
- HubSpot AI / Breeze: https://www.hubspot.com/products/artificial-intelligence
- Intercom Fin: https://www.intercom.com/fin
## Decisões arquiteturais
- Agente único por padrão; multiagente só após evals provarem ganho mensurável.
- Gemini 3.7 Flash como cérebro primário configurável, sem chave embutida no código.
- Fallback determinístico obrigatório para indisponibilidade, custo zero e fail-safe.
- PostgreSQL/Neon permanece como fonte transacional e memória persistente; full-text search nativo evita dependência de banco vetorial separado no baseline.
- `vector` e `pg_cron` estão disponíveis no Neon atual, mas não foram habilitados sem necessidade comprovada.
- Tool registry separa leitura, escrita interna, ação comercial e ação financeira.
- Toda decisão passa por eval local antes de executar ferramenta.
- Ações comerciais/financeiras continuam condicionadas aos kill-switches existentes.
- Channel adapters são substituíveis e não acoplam o cérebro a Meta, e-mail, TikTok, YouTube ou rede afiliada.
- Fila usa prioridade, idempotência e `FOR UPDATE SKIP LOCKED`.
- Cada run e cada tool call possuem trilha persistente e hash de entrada.
- Knowledge base usa PostgreSQL FTS + GIN no baseline; embeddings podem ser adicionados posteriormente sem quebrar o contrato.

## Limite externo atual
`GEMINI_API_KEY` não existe no ambiente. Portanto, a release opera em fallback determinístico até que uma chave externa válida seja fornecida. Nenhuma credencial foi inventada e nenhum serviço pago foi ativado.
