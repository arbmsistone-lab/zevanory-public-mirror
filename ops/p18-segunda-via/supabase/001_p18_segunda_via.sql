-- ZEVANORY | P18 segunda via INDEPENDENTE (Roteiro v4.9, seção 5/P18, R15, VC-H controle 10, P1.4 critérios 8 e 9).
-- Monitor administrativamente separado do primeiro (GitHub Actions + ramo de evidência) e da Cloudflare: roda dentro
-- de um projeto Supabase (Postgres na AWS), agendado por pg_cron, com sondagens HTTP assíncronas por pg_net e alerta
-- por e-mail pela API do Resend (conta própria do monitor, chave no Vault do projeto). Nada aqui depende de GitHub,
-- de Cloudflare Workers/KV/Cron ou do ZPC.
--
-- NÃO APLICADO por este PR. Aplicar é passo do proprietário (docs/p18/segunda-via-supabase.md): colar no SQL Editor.
-- Pré-requisito: extensões pg_cron e pg_net habilitadas (Database > Extensions). Agendamento em 002_agendar.sql.
--
-- Ciclo (p18sv.tick, 1x por minuto pelo pg_cron):
--  1. recolhe as respostas das sondagens anteriores (net._http_response) e as avalia; sem resposta depois de
--     timeout + folga = falha "no_response" (a fila do pg_net é UNLOGGED e some numa queda do banco);
--  2. avalia cada rodada completa: disponibilidade (health + release + página de vendas) e batimento do monitor
--     primário (heartbeat.json no ramo evidence/b0-baseline), cada um com estado e incidente próprios;
--     2 rodadas seguidas com falha confirmam (sem esperar mais), 1 rodada boa recupera;
--  3. alerta: e-mail na confirmação, lembrete a cada reminder_every_s, e-mail de recuperação; mudança de sales_mode
--     gera aviso próprio (o interruptor global mudou);
--  4. dispara a próxima rodada quando já passou probe_interval_s (padrão 120 s): só GET, sem cookie, sem segredo;
--  5. grava o batimento deste monitor (p18sv.heartbeat).
-- Tempo até o alerta (pior caso, padrões): queda logo depois de uma rodada -> 1ª rodada com falha em <= 120 s,
-- recolhida no tick seguinte (+60 s); 2ª rodada +120 s, recolhida +60 s -> pedido do e-mail <= ~300 s; sem resposta
-- nenhuma (timeout) <= ~360 s. Alvo VC-H: <= 600 s. Medido em p18sv.incident_report (e no ensaio p18sv.drill_start).
-- Orçamento: 3 GET a cada 120 s na Cloudflare (2.160/dia) + 1 GET a cada 120 s no raw.githubusercontent (720/dia)
-- + 1 POST ao Resend por alerta (Free do Resend: 100/dia).

create schema if not exists p18sv;
revoke all on schema p18sv from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on schema p18sv from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on schema p18sv from authenticated'; end if;
end $$;

create table if not exists p18sv.config (
  id                    int primary key default 1 check (id = 1),
  enabled               boolean not null default false,
  health_url            text not null default 'https://zevanory.api.br/api/health',
  release_url           text not null default 'https://zevanory.api.br/api/release',
  sales_url             text not null default 'https://vendas.zevanory.api.br/',
  primary_heartbeat_url text not null default 'https://raw.githubusercontent.com/arbmsistone-lab/zevanory-public-mirror/evidence/b0-baseline/p18/heartbeat.json',
  probe_interval_s      int  not null default 120 check (probe_interval_s between 60 and 900),
  confirm_failures      int  not null default 2   check (confirm_failures between 1 and 5),
  timeout_ms            int  not null default 10000 check (timeout_ms between 1000 and 30000),
  response_grace_s      int  not null default 60  check (response_grace_s between 10 and 300),
  primary_stale_s       int  not null default 1200 check (primary_stale_s between 300 and 86400),
  reminder_every_s      int  not null default 21600 check (reminder_every_s >= 1800),
  retention_days        int  not null default 14 check (retention_days between 1 and 90),
  alert_to              text[] not null default '{}',
  alert_from            text not null default 'P18 segunda via <onboarding@resend.dev>',
  resend_secret_name    text not null default 'p18sv_resend_api_key',
  resend_url            text not null default 'https://api.resend.com/emails',
  user_agent            text not null default 'ZevanoryP18SegundaVia/1.0 (+https://zevanory.api.br; somente-leitura; bot)',
  drill_started_at      timestamptz,
  drill_until           timestamptz,
  updated_at            timestamptz not null default now()
);
insert into p18sv.config (id) values (1) on conflict (id) do nothing;

create table if not exists p18sv.round (
  id           bigserial primary key,
  sent_at      timestamptz not null,
  drill        boolean not null default false,
  evaluated_at timestamptz
);
create table if not exists p18sv.probe (
  id           bigserial primary key,
  round_id     bigint not null references p18sv.round(id) on delete cascade,
  target       text not null check (target in ('health', 'release', 'sales', 'primary')),
  url          text not null,
  request_id   bigint,
  sent_at      timestamptz not null,
  collected_at timestamptz,
  response_at  timestamptz,
  status_code  int,
  timed_out    boolean,
  error        text,
  ok           boolean,
  reason       text,
  detail       jsonb
);
create index if not exists probe_pending on p18sv.probe (sent_at) where collected_at is null;
create table if not exists p18sv.state (
  check_name       text primary key check (check_name in ('availability', 'primary', 'sales_mode')),
  consecutive_fail int not null default 0,
  consecutive_ok   int not null default 0,
  open_incident    bigint,
  last_value       text,
  updated_at       timestamptz
);
insert into p18sv.state (check_name) values ('availability'), ('primary'), ('sales_mode') on conflict do nothing;
create table if not exists p18sv.incident (
  id                         bigserial primary key,
  check_name                 text not null,
  drill                      boolean not null default false,
  drill_started_at           timestamptz,
  first_fail_at              timestamptz not null,
  confirmed_at               timestamptz,
  alert_requested_at         timestamptz,
  alert_accepted_at          timestamptz,
  last_alert_at              timestamptz,
  recovered_at               timestamptz,
  recovery_alert_requested_at timestamptz,
  recovery_alert_accepted_at timestamptz,
  reasons                    jsonb not null default '[]'
);
create table if not exists p18sv.alert (
  id           bigserial primary key,
  incident_id  bigint,
  kind         text not null check (kind in ('down', 'reminder', 'recovery', 'info', 'test')),
  subject      text not null,
  requested_at timestamptz not null,
  request_id   bigint,
  status_code  int,
  accepted_at  timestamptz,
  error        text
);
create table if not exists p18sv.heartbeat (
  id           int primary key default 1 check (id = 1),
  last_tick_at timestamptz,
  ticks        bigint not null default 0,
  last_result  jsonb
);
insert into p18sv.heartbeat (id) values (1) on conflict do nothing;

-- RLS ligada sem política: nada é legível pela API pública (anon/authenticated); o proprietário lê no SQL Editor.
alter table p18sv.config enable row level security;
alter table p18sv.round enable row level security;
alter table p18sv.probe enable row level security;
alter table p18sv.state enable row level security;
alter table p18sv.incident enable row level security;
alter table p18sv.alert enable row level security;
alter table p18sv.heartbeat enable row level security;

create or replace function p18sv.try_jsonb(t text) returns jsonb language plpgsql immutable as $$
begin
  return t::jsonb;
exception when others then
  return null;
end $$;

-- Avaliação de uma resposta. HTTP 200 sozinho não basta: health precisa de JSON com ready != false; release precisa de
-- sales_mode conhecido; a página de vendas precisa mostrar a marca; o batimento do primário precisa do esquema e de
-- last_success_at fresco.
create or replace function p18sv.evaluate(p_target text, p_status int, p_content text, p_timed_out boolean, p_error text,
                                          p_now timestamptz, p_stale_s int, out ok boolean, out reason text, out detail jsonb)
language plpgsql stable as $$
declare j jsonb; age_s numeric;
begin
  detail := '{}'::jsonb;
  if coalesce(p_timed_out, false) then ok := false; reason := 'timeout'; return; end if;
  if p_error is not null and p_error <> '' then ok := false; reason := 'network:' || left(p_error, 80); return; end if;
  if p_status is distinct from 200 then ok := false; reason := 'http_' || coalesce(p_status::text, 'null'); return; end if;
  if p_target = 'sales' then
    ok := position('zevanory' in lower(coalesce(p_content, ''))) > 0;
    reason := case when ok then 'ok' else 'sales_page_without_brand' end;
    return;
  end if;
  j := p18sv.try_jsonb(p_content);
  if j is null or jsonb_typeof(j) <> 'object' then ok := false; reason := 'not_json'; return; end if;
  if p_target = 'health' then
    ok := coalesce(j->>'ready', 'true') = 'true';
    reason := case when ok then 'ok' else 'not_ready' end;
  elsif p_target = 'release' then
    ok := (j->>'sales_mode') in ('globally-blocked', 'enabled');
    reason := case when ok then 'ok' else 'sales_mode_unknown' end;
    detail := jsonb_build_object('sales_mode', j->>'sales_mode');
  elsif p_target = 'primary' then
    if j->>'schema' is distinct from 'zevanory.p18.heartbeat.v1' then ok := false; reason := 'primary_malformed'; return; end if;
    begin
      age_s := extract(epoch from (p_now - (j->>'last_success_at')::timestamptz));
    exception when others then ok := false; reason := 'primary_malformed'; return;
    end;
    detail := jsonb_build_object('age_s', round(age_s), 'last_success_at', j->>'last_success_at');
    if age_s < -120 then ok := false; reason := 'primary_future';
    elsif age_s > p_stale_s then ok := false; reason := 'primary_stale';
    else ok := true; reason := 'ok'; end if;
  else
    ok := false; reason := 'unknown_target';
  end if;
end $$;

-- Pede um e-mail ao Resend (POST assíncrono pelo pg_net). A chave fica no Vault e nunca é gravada em p18sv.
create or replace function p18sv.send_alert(p_incident bigint, p_kind text, p_subject text, p_text text, p_now timestamptz)
returns bigint language plpgsql as $$
declare c p18sv.config; k text; rid bigint; aid bigint;
begin
  select * into c from p18sv.config where id = 1;
  begin
    execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 limit 1' into k using c.resend_secret_name;
  exception when others then k := null;
  end;
  if k is null or k = '' or cardinality(c.alert_to) = 0 then
    insert into p18sv.alert (incident_id, kind, subject, requested_at, error)
      values (p_incident, p_kind, p_subject, p_now, 'not_configured:' || case when k is null or k = '' then 'secret' else 'alert_to' end)
      returning id into aid;
    return aid;
  end if;
  rid := net.http_post(
    url := c.resend_url,
    body := jsonb_build_object('from', c.alert_from, 'to', to_jsonb(c.alert_to), 'subject', p_subject, 'text', p_text),
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || k, 'User-Agent', c.user_agent),
    timeout_milliseconds := c.timeout_ms);
  insert into p18sv.alert (incident_id, kind, subject, requested_at, request_id) values (p_incident, p_kind, p_subject, p_now, rid) returning id into aid;
  return aid;
end $$;

create or replace function p18sv.label(p_check text) returns text language sql immutable as $$
  select case p_check when 'availability' then 'Vendas/API fora do ar' when 'primary' then 'Monitor primário (GitHub) parado'
                      else 'Trava de vendas' end
$$;

-- Aplica o resultado de uma rodada a uma verificação (máquina de estados com incidente).
create or replace function p18sv.apply_result(p_check text, p_ok boolean, p_at timestamptz, p_reasons jsonb, p_now timestamptz, p_drill boolean)
returns void language plpgsql as $$
declare c p18sv.config; s p18sv.state; i p18sv.incident; pre text; body text;
begin
  select * into c from p18sv.config where id = 1;
  select * into s from p18sv.state where check_name = p_check for update;
  if s.open_incident is not null then select * into i from p18sv.incident where id = s.open_incident; end if;
  if not p_ok then
    s.consecutive_fail := s.consecutive_fail + 1; s.consecutive_ok := 0;
    if s.open_incident is null then
      insert into p18sv.incident (check_name, drill, drill_started_at, first_fail_at, reasons)
        values (p_check, p_drill, case when p_drill then c.drill_started_at end, p_at, p_reasons) returning * into i;
      s.open_incident := i.id;
    else
      update p18sv.incident set reasons = (reasons || p_reasons) where id = i.id;
    end if;
    pre := case when i.drill then '[ENSAIO] ' else '' end;
    if i.confirmed_at is null and s.consecutive_fail >= c.confirm_failures then
      body := format(E'%s\nVerificação: %s\nPrimeira falha: %s\nConfirmado: %s (%s rodadas seguidas)\nMotivos: %s\nIncidente: %s\nOrigem: segunda via P18 (Supabase pg_cron + pg_net), independente do GitHub e da Cloudflare.\nAção: conferir https://vendas.zevanory.api.br/ e o monitor primário; a trava de vendas continua valendo.',
        p18sv.label(p_check), p_check, i.first_fail_at, p_now, s.consecutive_fail, p_reasons::text, i.id);
      perform p18sv.send_alert(i.id, 'down', pre || '[P18-2ª via] ' || p18sv.label(p_check), body, p_now);
      update p18sv.incident set confirmed_at = p_now, alert_requested_at = p_now, last_alert_at = p_now where id = i.id;
    elsif i.confirmed_at is not null and p_now - coalesce(i.last_alert_at, i.confirmed_at) >= make_interval(secs => c.reminder_every_s) then
      perform p18sv.send_alert(i.id, 'reminder', pre || '[P18-2ª via] Continua: ' || p18sv.label(p_check),
        format(E'Incidente %s aberto desde %s. Motivos recentes: %s', i.id, i.first_fail_at, p_reasons::text), p_now);
      update p18sv.incident set last_alert_at = p_now where id = i.id;
    end if;
  else
    s.consecutive_ok := s.consecutive_ok + 1; s.consecutive_fail := 0;
    if s.open_incident is not null then
      update p18sv.incident set recovered_at = p_now where id = i.id;
      if i.confirmed_at is not null then
        pre := case when i.drill then '[ENSAIO] ' else '' end;
        perform p18sv.send_alert(i.id, 'recovery', pre || '[P18-2ª via] Recuperado: ' || p18sv.label(p_check),
          format(E'Incidente %s: primeira falha %s, confirmado %s, recuperado %s.', i.id, i.first_fail_at, i.confirmed_at, p_now), p_now);
        update p18sv.incident set recovery_alert_requested_at = p_now where id = i.id;
      end if;
      s.open_incident := null;
    end if;
  end if;
  update p18sv.state set consecutive_fail = s.consecutive_fail, consecutive_ok = s.consecutive_ok, open_incident = s.open_incident, updated_at = p_now
    where check_name = p_check;
end $$;

-- Um ciclo. p_now só é passado nos testes; em produção é o relógio do banco.
create or replace function p18sv.tick(p_now timestamptz default clock_timestamp()) returns jsonb language plpgsql as $$
declare c p18sv.config; r record; avail_ok boolean; prim_ok boolean; reasons jsonb; mode text; last_sent timestamptz;
        rid bigint; nround bigint; drill boolean; dispatched boolean := false; evaluated int := 0; hdr jsonb; t record; st p18sv.state;
begin
  select * into c from p18sv.config where id = 1 for update;   -- serializa ticks concorrentes
  if not c.enabled then
    update p18sv.heartbeat set last_tick_at = p_now, ticks = ticks + 1, last_result = '{"state":"disabled"}' where id = 1;
    return '{"state":"disabled"}'::jsonb;
  end if;
  -- 1. recolher sondagens
  update p18sv.probe p set collected_at = p_now, response_at = q.created, status_code = q.status_code, timed_out = q.timed_out,
         error = q.error_msg, ok = (q.e).ok, reason = (q.e).reason, detail = (q.e).detail
    from (select p2.id, x.created, x.status_code, x.timed_out, x.error_msg,
                 p18sv.evaluate(p2.target, x.status_code, x.content, x.timed_out, x.error_msg, p_now, c.primary_stale_s) as e
            from p18sv.probe p2 join net._http_response x on x.id = p2.request_id
           where p2.collected_at is null) q
   where q.id = p.id;
  update p18sv.probe set collected_at = p_now, ok = false, reason = 'no_response'
   where collected_at is null and sent_at < p_now - make_interval(secs => c.timeout_ms / 1000.0 + c.response_grace_s);
  -- 1b. recolher alertas (aceito = 2xx do Resend)
  update p18sv.alert a set status_code = x.status_code,
         accepted_at = case when x.status_code between 200 and 299 then x.created end,
         error = case when x.status_code between 200 and 299 then null else coalesce('http_' || x.status_code, left(x.error_msg, 80), 'timeout') end
    from net._http_response x where x.id = a.request_id and a.status_code is null and a.error is null;
  update p18sv.alert set error = 'no_response'
   where request_id is not null and status_code is null and error is null and requested_at < p_now - make_interval(secs => c.timeout_ms / 1000.0 + c.response_grace_s);
  update p18sv.incident i set alert_accepted_at = a.accepted_at from p18sv.alert a
   where a.incident_id = i.id and a.kind = 'down' and a.accepted_at is not null and i.alert_accepted_at is null;
  update p18sv.incident i set recovery_alert_accepted_at = a.accepted_at from p18sv.alert a
   where a.incident_id = i.id and a.kind = 'recovery' and a.accepted_at is not null and i.recovery_alert_accepted_at is null;
  -- 2. avaliar rodadas completas, em ordem
  for r in select * from p18sv.round where evaluated_at is null
             and not exists (select 1 from p18sv.probe p where p.round_id = round.id and p.collected_at is null) order by sent_at loop
    select coalesce(bool_and(ok), false), coalesce(jsonb_agg(jsonb_build_object('target', target, 'reason', reason, 'http', status_code)) filter (where not ok), '[]')
      into avail_ok, reasons from p18sv.probe where round_id = r.id and target in ('health', 'release', 'sales');
    if r.drill then avail_ok := false; reasons := reasons || '[{"target":"drill","reason":"ensaio"}]'::jsonb; end if;
    perform p18sv.apply_result('availability', avail_ok, r.sent_at, reasons, p_now, r.drill);
    select ok, jsonb_build_array(jsonb_build_object('target', 'primary', 'reason', reason, 'http', status_code, 'detail', detail))
      into prim_ok, reasons from p18sv.probe where round_id = r.id and target = 'primary';
    if prim_ok is not null then perform p18sv.apply_result('primary', prim_ok, r.sent_at, reasons, p_now, false); end if;
    -- mudança do interruptor global (aviso informativo, nunca silenciosa)
    select detail->>'sales_mode' into mode from p18sv.probe where round_id = r.id and target = 'release' and ok;
    if mode is not null then
      select * into st from p18sv.state where check_name = 'sales_mode' for update;
      if st.last_value is not null and st.last_value <> mode then
        perform p18sv.send_alert(null, 'info', '[P18-2ª via] Trava de vendas mudou: ' || st.last_value || ' -> ' || mode,
          format(E'sales_mode em %s passou de %s para %s (rodada %s). Se ninguém autorizou ("LIBERAR VENDAS"), fechar a trava.', c.release_url, st.last_value, mode, r.id), p_now);
      end if;
      update p18sv.state set last_value = mode, updated_at = p_now where check_name = 'sales_mode';
    end if;
    update p18sv.round set evaluated_at = p_now where id = r.id;
    evaluated := evaluated + 1;
  end loop;
  -- 3. disparar a próxima rodada
  select max(sent_at) into last_sent from p18sv.round;
  if last_sent is null or p_now - last_sent >= make_interval(secs => c.probe_interval_s - 5) then
    drill := c.drill_until is not null and p_now < c.drill_until;
    insert into p18sv.round (sent_at, drill) values (p_now, drill) returning id into nround;
    hdr := jsonb_build_object('User-Agent', c.user_agent, 'Accept', 'application/json,text/html;q=0.9', 'Cache-Control', 'no-cache');
    for t in select * from (values ('health', c.health_url), ('release', c.release_url), ('sales', c.sales_url), ('primary', c.primary_heartbeat_url)) v(target, url) loop
      rid := net.http_get(url := t.url, headers := hdr, timeout_milliseconds := c.timeout_ms);
      insert into p18sv.probe (round_id, target, url, request_id, sent_at) values (nround, t.target, t.url, rid, p_now);
    end loop;
    dispatched := true;
  end if;
  -- 4. retenção (incidentes e alertas ficam; sondagens e rodadas antigas saem)
  delete from p18sv.round where sent_at < p_now - make_interval(days => c.retention_days) and evaluated_at is not null;
  -- 5. batimento deste monitor
  update p18sv.heartbeat set last_tick_at = p_now, ticks = ticks + 1,
         last_result = jsonb_build_object('evaluated_rounds', evaluated, 'dispatched', dispatched,
           'open_incidents', (select count(*) from p18sv.incident where recovered_at is null),
           'alert_errors_24h', (select count(*) from p18sv.alert where error is not null and requested_at > p_now - interval '24 hours'))
   where id = 1;
  return (select last_result from p18sv.heartbeat where id = 1);
end $$;

-- Ensaio (P1.4 critérios 8 e 9): durante p_minutes as rodadas contam como falha de disponibilidade (as sondagens reais
-- continuam e ficam registradas). Mede, com o relógio do banco, drill_start -> confirmação -> e-mail aceito pelo Resend
-- -> recuperação -> e-mail de recuperação. O e-mail sai com "[ENSAIO]" no assunto.
create or replace function p18sv.drill_start(p_minutes int default 6, p_now timestamptz default clock_timestamp()) returns text
language plpgsql as $$
declare c p18sv.config;
begin
  select * into c from p18sv.config where id = 1 for update;
  if not c.enabled then raise exception 'P18SV_DISABLED: habilite o monitor antes do ensaio'; end if;
  if p_minutes < 4 or p_minutes > 30 then raise exception 'P18SV_DRILL_MINUTES entre 4 e 30'; end if;
  update p18sv.config set drill_started_at = p_now, drill_until = p_now + make_interval(mins => p_minutes), updated_at = p_now where id = 1;
  return format('ensaio de %s min iniciado em %s; acompanhe: select * from p18sv.incident_report order by id desc limit 3;', p_minutes, p_now);
end $$;

create or replace function p18sv.send_test_email(p_now timestamptz default clock_timestamp()) returns bigint language plpgsql as $$
begin
  return p18sv.send_alert(null, 'test', '[P18-2ª via] E-mail de teste', format('Teste do canal de alerta da segunda via P18 em %s.', p_now), p_now);
end $$;

-- Relatório com os tempos medidos. "inicio" = início do ensaio (drill) ou a 1ª rodada com falha; para queda real o
-- início verdadeiro pode ser até probe_interval_s antes (coluna pior_caso_s soma essa folga).
create or replace view p18sv.incident_report as
select i.id, i.check_name, i.drill,
       coalesce(i.drill_started_at, i.first_fail_at) as inicio,
       i.first_fail_at, i.confirmed_at, i.alert_requested_at, i.alert_accepted_at, i.recovered_at, i.recovery_alert_accepted_at,
       round(extract(epoch from i.confirmed_at - coalesce(i.drill_started_at, i.first_fail_at)))::int       as deteccao_s,
       round(extract(epoch from i.alert_accepted_at - coalesce(i.drill_started_at, i.first_fail_at)))::int  as alerta_aceito_s,
       round(extract(epoch from i.alert_accepted_at - coalesce(i.drill_started_at, i.first_fail_at)))::int
         + case when i.drill then 0 else (select probe_interval_s from p18sv.config where id = 1) end          as pior_caso_s,
       (i.alert_accepted_at is not null and
        extract(epoch from i.alert_accepted_at - coalesce(i.drill_started_at, i.first_fail_at))
          + case when i.drill then 0 else (select probe_interval_s from p18sv.config where id = 1) end <= 600) as dentro_de_10_min
  from p18sv.incident i;

create or replace function p18sv.status(p_now timestamptz default clock_timestamp()) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'enabled', (select enabled from p18sv.config where id = 1),
    'last_tick_at', h.last_tick_at, 'tick_age_s', round(extract(epoch from p_now - h.last_tick_at)), 'ticks', h.ticks, 'last_result', h.last_result,
    'states', (select jsonb_object_agg(check_name, jsonb_build_object('fail', consecutive_fail, 'ok', consecutive_ok, 'open_incident', open_incident, 'value', last_value)) from p18sv.state),
    'last_alert', (select to_jsonb(a) - 'request_id' from p18sv.alert a order by id desc limit 1))
  from p18sv.heartbeat h where h.id = 1
$$;

revoke all on all tables in schema p18sv from public;
revoke all on all functions in schema p18sv from public;
