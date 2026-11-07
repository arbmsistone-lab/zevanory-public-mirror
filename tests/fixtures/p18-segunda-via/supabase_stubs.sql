-- SÓ PARA TESTE LOCAL: imitação mínima de pg_net, pg_cron e Vault do Supabase num PostgreSQL comum, com as mesmas
-- assinaturas usadas por ops/p18-segunda-via/supabase/*.sql. Nenhuma rede: os pedidos ficam em net._stub_requests e
-- o teste escreve as respostas em net._http_response (mesmas colunas da tabela real do pg_net).
create schema if not exists net;
create table net._stub_requests (id bigserial primary key, method text not null, url text not null, headers jsonb, body jsonb,
                                 timeout_milliseconds int, created timestamptz not null default clock_timestamp());
create unlogged table net._http_response (id bigint, status_code int, content_type text, headers jsonb, content text,
                                          timed_out boolean, error_msg text, created timestamptz not null default now());
create function net.http_get(url text, params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds int default 2000)
returns bigint language sql as $$
  insert into net._stub_requests (method, url, headers, timeout_milliseconds) values ('GET', url, headers, timeout_milliseconds) returning id
$$;
create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{"Content-Type": "application/json"}', timeout_milliseconds int default 2000)
returns bigint language sql as $$
  insert into net._stub_requests (method, url, headers, body, timeout_milliseconds) values ('POST', url, headers, body, timeout_milliseconds) returning id
$$;
create schema if not exists vault;
create table vault.decrypted_secrets (name text primary key, decrypted_secret text);
create schema if not exists cron;
create table cron.job (jobid bigserial primary key, jobname text unique, schedule text, command text);
create function cron.schedule(job_name text, schedule text, command text) returns bigint language sql as $$
  insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning jobid
$$;
create function cron.unschedule(job_name text) returns boolean language sql as $$
  with d as (delete from cron.job where jobname = job_name returning 1) select exists (select 1 from d)
$$;
