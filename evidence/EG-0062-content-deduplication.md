# EG-0062 — Deterministic Content Deduplication

Status: APROVADO COM RESTRICOES
Data: 2026-09-01

## Evidencias independentes
1. Unicode Standard Annex #15 — Unicode Normalization Forms: normalizacao canonica/compatibilidade antes de comparacao textual.
2. Stanford Introduction to Information Retrieval — near-duplicate detection com shingles e similaridade de Jaccard/MinHash.
3. Google/WWW 2007 — Detecting Near-Duplicates for Web Crawling: fingerprints compactos sao uma tecnica pratica para detectar copias e variacoes proximas em escala.

## Decisao
- Usar NFKC + normalizacao deterministica + SHA-256 para duplicidade exata.
- Usar shingles de 3 tokens + Jaccard para near-duplicates, sem embeddings pagos.
- Comparar contra `integration_outbox` dos ultimos 90 dias, sem nova tabela/migration.
- Bloquear duplicidade antes de approval/autonomia e novamente antes de enqueue, fail-closed.
- Exigir maior similaridade para bloquear adaptacoes entre canais do que repeticoes no mesmo canal.

## Restricoes
- Jaccard mede similaridade lexical; nao e compreensao semantica.
- Texto curto usa protecao conservadora para reduzir falso positivo.
- Reuso intencional nao ganha bypass automatico nesta versao.
- A regra nao prova qualidade, alcance, conversao ou originalidade juridica do conteudo.
