begin;
create table if not exists media_spend_events (
  spend_event_id uuid primary key,
  campaign_id text not null check (length(campaign_id) between 1 and 80),
  variant_id text not null check (length(variant_id) between 1 and 80),
  creative_id text not null check (length(creative_id) between 1 and 80),
  channel text not null check (length(channel) between 1 and 40),
  spend_brl numeric(14,2) not null check (spend_brl >= 0),
  occurred_at timestamptz not null default now(),
  source text not null default 'operator',
  unique(campaign_id,variant_id,occurred_at)
);
create index if not exists media_spend_campaign_variant_idx on media_spend_events(campaign_id,variant_id,occurred_at desc);
insert into schema_migrations(migration_id) values ('026_media_investment_telemetry') on conflict do nothing;
commit;
