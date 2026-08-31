# EG-0048 — ARBM SIST Organic Search Discovery

Status: APROVADO COM RESTRICOES
Data: 2026-08-31
Escopo: descoberta organica do ARBM SIST em Pesquisa Google e recursos de IA da Pesquisa, sem ativar venda, checkout, outbound ou midia paga.

## Hipotese
Pessoas que pesquisam Codex, Claude Code, Cursor, alternativa ao Codex e agentes de programacao podem descobrir o ARBM SIST se a pagina publica explicar de forma util, textual, verificavel e indexavel onde o produto entra nessa comparacao.

## Evidencias independentes
1. Google Search Central — AI features and SEO fundamentals (A, documentacao primaria):
   - https://developers.google.com/search/docs/appearance/ai-features?hl=pt-br
   - https://developers.google.com/search/docs/fundamentals/seo-starter-guide?hl=pt-br
   - SEO tradicional continua relevante para AI Overviews/Modo IA; a pagina precisa estar indexada e apta a snippet; robots, links internos, texto visivel e dados estruturados coerentes continuam centrais.
2. Schema.org — SoftwareApplication (A, vocabulario tecnico oficial):
   - https://schema.org/SoftwareApplication
   - SoftwareApplication permite descrever versao, categoria, requisitos, publisher e caracteristicas do software de forma estruturada.
3. MCPlato Research Team — pagina atual direcionada a intencao "alternativa ao Codex" (C, evidencia competitiva observavel):
   - https://mcplato.com/pt/blog/mcplato-codex-alternative-personal-agent-os/
   - Demonstra demanda editorial atual pela consulta comparativa e uso de pagina dedicada/linguagem explicita de alternativa ao Codex.
4. AI Coding Patterns — comparativo atual Claude Code vs Codex vs Cursor (C, evidencia competitiva observavel):
   - https://aicodingpatterns.com/en/patterns/claude-code-vs-codex-vs-cursor/
   - Confirma que comparacao por workflow entre esses agentes e uma intencao de busca ativa em 2026.

## Decisao
APROVADO implementar a fundacao organica na rota publica existente `/arbm-sist`:
- title e description orientados a intencao real;
- texto visivel que responda naturalmente a buscas por Codex, Claude Code, Cursor e agentes de IA;
- secao comparativa sem declarar vencedor universal e sem alegacoes nao comprovadas;
- perguntas diretas que facilitem compreensao humana e recuperacao por mecanismos de busca/IA;
- SoftwareApplication enriquecido apenas com fatos existentes no produto;
- preservacao de canonical, robots index/follow, identidade ZEVANORY e telemetria existente.

## Restricoes obrigatorias
- Nao prometer primeira posicao, indexacao ou prazo de ranking.
- Nao usar keyword stuffing, doorway pages, texto oculto, backlinks artificiais ou conteudo em massa de baixo valor.
- Nao inventar review, rating, usuarios, vendas, economia, benchmark ou superioridade.
- Nao declarar que ARBM SIST substitui universalmente Codex, Claude Code ou Cursor.
- Nao habilitar compra, checkout, WhatsApp comercial, outbound ou midia paga enquanto os gates comerciais estiverem fail-closed.
- ZEVANORY permanece marca-mae; ARBM SIST permanece produto do portfolio.

## Criterio de aceite
A pagina deve conter intencao competitiva de forma natural, manter a verdade de pre-lancamento, passar testes do projeto e preservar todos os kill-switches comerciais. A publicacao em producao continua sujeita a integracao serializada na raiz canonica e as 3 auditorias previstas pela governanca.
