-- ZEVANORY | P20 diário D1, PR 4 (reconciliação diária, docs/p20/diario-d1.md).
-- Índice por ts_ms: a reconciliação acha os limites da janela (min/max seq por ts_ms) sem varrer a tabela, o que
-- mantém as linhas lidas do D1 proporcionais à janela (cota do D1 Free, seção 11). Só DDL aditiva: nenhuma linha muda.
CREATE INDEX IF NOT EXISTS diario_v1_ts ON diario_v1 (ts_ms);
