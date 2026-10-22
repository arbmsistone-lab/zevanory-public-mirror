-- P01 Fase A (Ordem 080 AVAL; AVAL 085): lista de espera sem cobrança e medição por PESSOA experimental.
-- Fonte única do esquema (o Worker NÃO cria estas tabelas: sem a migração aplicada ele responde 503).
-- Reversão: db/rollback/030_waitlist_fase_a.down.sql. Inventário: db/migrations/MANIFEST.
BEGIN;

-- Inscrições (dado pessoal): contato só enquanto houver finalidade; apagadas na saída e na retenção.
CREATE TABLE IF NOT EXISTS waitlist_signups (
  id bigserial PRIMARY KEY,
  window_id text NOT NULL CHECK (window_id ~ '^[a-z0-9-]{1,32}$'),
  niche text NOT NULL CHECK (niche IN ('confeitaria','loja-de-roupas','salao-e-barbearia')),
  contact_kind text NOT NULL CHECK (contact_kind IN ('email','whatsapp')),
  contact text NOT NULL CHECK (char_length(contact) BETWEEN 5 AND 254),
  contact_ref text NOT NULL CHECK (contact_ref ~ '^[0-9a-f]{64}$'),
  name text CHECK (name IS NULL OR char_length(name) <= 60),
  q_recurring boolean NOT NULL,
  q_digital boolean NOT NULL,
  interview_ok boolean NOT NULL DEFAULT false,
  consent_version text NOT NULL CHECK (char_length(consent_version) BETWEEN 1 AND 60),
  consent_at timestamptz NOT NULL,
  person_id text CHECK (person_id IS NULL OR person_id ~ '^[0-9a-f]{32}$'),
  exclusion text CHECK (exclusion IS NULL OR exclusion IN ('ua','asn')),
  src text CHECK (src IS NULL OR src ~ '^[a-z0-9_-]{1,24}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (window_id, niche, contact_ref)
);

-- Pessoa experimental por nicho e janela: identificador aleatório (cookie assinado), guardado só como
-- HMAC; conta no denominador apenas se confirmado (o navegador devolveu o cookie) e sem exclusão.
CREATE TABLE IF NOT EXISTS waitlist_persons (
  window_id text NOT NULL CHECK (window_id ~ '^[a-z0-9-]{1,32}$'),
  niche text NOT NULL,
  person_id text NOT NULL CHECK (person_id ~ '^[0-9a-f]{32}$'),
  first_day date NOT NULL,
  last_day date NOT NULL,
  days integer NOT NULL DEFAULT 1 CHECK (days >= 1),
  confirmed boolean NOT NULL DEFAULT false,
  exclusion text CHECK (exclusion IS NULL OR exclusion IN ('ua','asn')),
  PRIMARY KEY (window_id, niche, person_id)
);

-- Mesma pessoa comprovada em dois identificadores (mesmo contato inscrito de dois aparelhos).
CREATE TABLE IF NOT EXISTS waitlist_person_alias (
  window_id text NOT NULL,
  niche text NOT NULL,
  alias_id text NOT NULL CHECK (alias_id ~ '^[0-9a-f]{32}$'),
  primary_id text NOT NULL CHECK (primary_id ~ '^[0-9a-f]{32}$'),
  created_day date NOT NULL DEFAULT current_date,
  PRIMARY KEY (window_id, niche, alias_id)
);

-- Exposição pessoa-dia (HMAC diário de IP+navegador com segredo dedicado): só descritiva, nunca decide.
CREATE TABLE IF NOT EXISTS waitlist_person_days (
  day date NOT NULL,
  niche text NOT NULL,
  dhash text NOT NULL CHECK (dhash ~ '^[0-9a-f]{32}$'),
  exclusion text CHECK (exclusion IS NULL OR exclusion IN ('ua','asn')),
  PRIMARY KEY (day, niche, dhash)
);

-- Oráculo: contadores agregados por dia/nicho/métrica, sem nenhum identificador.
CREATE TABLE IF NOT EXISTS waitlist_raw_daily (
  day date NOT NULL,
  niche text NOT NULL,
  metric text NOT NULL CHECK (metric ~ '^[a-z_:]{1,48}$'),
  n integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, niche, metric)
);

INSERT INTO schema_migrations (migration_id)
VALUES ('030_waitlist_fase_a')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
