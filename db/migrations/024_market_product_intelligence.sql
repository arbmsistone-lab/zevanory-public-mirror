begin;

create table if not exists intelligence_snapshots (
  snapshot_id uuid primary key,
  snapshot_type text not null check (snapshot_type in ('market_research','product_ranking','investment_decision')),
  subject_ref text not null,
  payload jsonb not null,
  evidence_count integer not null default 0 check (evidence_count >= 0),
  organization_count integer not null default 0 check (organization_count >= 0),
  decision text,
  score numeric,
  observed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique(snapshot_type,subject_ref,observed_at)
);

create index if not exists intelligence_snapshots_latest_idx
  on intelligence_snapshots(snapshot_type,created_at desc);
create index if not exists intelligence_snapshots_subject_idx
  on intelligence_snapshots(subject_ref,created_at desc);

insert into schema_migrations(migration_id) values ('024_market_product_intelligence') on conflict do nothing;
commit;
