-- T4 local only. Inferred from the columns the bundle reads/writes (no DDL for these tables exists
-- in the repository): orders INSERT (recovered ~14403/14520), the webhook CTE (~14948), delivery
-- (~14830) and artifact tokens (~17546). The UNIQUE on financial_events.provider_event_id is what
-- the bare ON CONFLICT DO NOTHING relies on; the production constraint itself is NOT verified here.
drop table if exists artifact_download_tokens, service_fulfillment, financial_events, orders cascade;
create table orders (order_id uuid primary key, request_id text, session_id text, experiment_id text, offer_id text,
  amount numeric not null, currency text default 'BRL', provider text not null, external_reference text not null,
  status text not null, certification_pilot boolean not null default false, certification_pilot_invite_id text,
  provider_checkout_id text, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table financial_events (provider_event_id text primary key, provider text not null, provider_payment_id text not null,
  normalized_event text not null, provider_event_name text, provider_status text, external_reference text, amount numeric,
  order_id uuid references orders(order_id), refunded_total numeric, received_at timestamptz not null default now());
create table service_fulfillment (fulfillment_id uuid primary key, order_id uuid unique references orders(order_id), status text not null,
  delivery_mode text, evidence_ref text, delivered_at timestamptz, created_at timestamptz default now(), updated_at timestamptz default now());
create table artifact_download_tokens (token_id uuid primary key, order_id uuid references orders(order_id), token_sha256 text unique not null,
  artifact_key text, artifact_sha256 text, expires_at timestamptz not null, issued_by text, used_at timestamptz, created_at timestamptz default now());
