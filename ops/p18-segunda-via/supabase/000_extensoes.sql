-- ZEVANORY | P18 segunda via: extensões exigidas (Supabase). Equivale a Database > Extensions > pg_cron e pg_net
-- (ligar as duas). Não aplicado por PR; passo do proprietário (docs/p18/segunda-via-supabase.md, passo 3).
create extension if not exists pg_cron;
create extension if not exists pg_net;
