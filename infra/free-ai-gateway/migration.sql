create table if not exists public.zevanory_ai_gateway_nonces (
  nonce text primary key,
  key_id text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists zevanory_ai_gateway_nonces_expires_idx
  on public.zevanory_ai_gateway_nonces(expires_at);
alter table public.zevanory_ai_gateway_nonces enable row level security;
revoke all on public.zevanory_ai_gateway_nonces from anon, authenticated;
grant insert, select, delete on table public.zevanory_ai_gateway_nonces to service_role;
