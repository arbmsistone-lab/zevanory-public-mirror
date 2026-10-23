-- P01 Fase A (Ordem 080 AVAL; AVAL 085/101): lista de espera sem cobrança e medição por NAVEGADOR/DISPOSITIVO
-- PSEUDÔNIMO (o identificador não representa uma pessoa). Nenhum derivado de IP+UA é persistido (AVAL 101).
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
  -- 'optout': inscrição de navegador que recusou a medição (Sec-GPC ou zvfa_optout): sem vínculo de medição.
  exclusion text CHECK (exclusion IS NULL OR exclusion IN ('ua','asn','optout')),
  src text CHECK (src IS NULL OR src ~ '^[a-z0-9_]{1,32}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (window_id, niche, contact_ref)
);

-- Navegador/dispositivo pseudônimo por nicho e janela (nomes de tabela/coluna "person" são históricos: a unidade
-- NÃO é uma pessoa). Identificador aleatório (cookie assinado), guardado só como HMAC; conta no denominador
-- apenas se confirmado (o navegador devolveu o cookie) e sem exclusão. window_end: fim da janela (retenção:
-- apagado 60 dias depois, no máximo). dsr_ref: código opaco de atendimento (HMAC), mostrado só a esse navegador.
CREATE TABLE IF NOT EXISTS waitlist_persons (
  window_id text NOT NULL CHECK (window_id ~ '^[a-z0-9-]{1,32}$'),
  niche text NOT NULL,
  person_id text NOT NULL CHECK (person_id ~ '^[0-9a-f]{32}$'),
  first_day date NOT NULL,
  last_day date NOT NULL,
  days integer NOT NULL DEFAULT 1 CHECK (days >= 1),
  confirmed boolean NOT NULL DEFAULT false,
  exclusion text CHECK (exclusion IS NULL OR exclusion IN ('ua','asn')),
  -- Origem do link na primeira visita (rótulo de lista fechada, sem dado pessoal; protocolo v3).
  src text NOT NULL DEFAULT 'sem_tag' CHECK (src ~ '^[a-z0-9_]{1,32}$'),
  window_end date NOT NULL,
  dsr_ref text NOT NULL CHECK (dsr_ref ~ '^[0-9a-f]{32}$'),
  PRIMARY KEY (window_id, niche, person_id)
);

-- Identidade consentida: o mesmo contato inscrito a partir de dois identificadores (dois aparelhos).
CREATE TABLE IF NOT EXISTS waitlist_person_alias (
  window_id text NOT NULL,
  niche text NOT NULL,
  alias_id text NOT NULL CHECK (alias_id ~ '^[0-9a-f]{32}$'),
  primary_id text NOT NULL CHECK (primary_id ~ '^[0-9a-f]{32}$'),
  created_day date NOT NULL DEFAULT current_date,
  window_end date NOT NULL,
  PRIMARY KEY (window_id, niche, alias_id)
);

-- Oráculo: contadores agregados por dia/nicho/métrica, sem nenhum identificador.
CREATE TABLE IF NOT EXISTS waitlist_raw_daily (
  day date NOT NULL,
  niche text NOT NULL,
  metric text NOT NULL CHECK (metric ~ '^[a-z_:]{1,48}$'),
  n integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, niche, metric)
);

-- Registro de exclusões (AVAL 101 §5): sem dado pessoal; data, escopo, gatilho, quantidade e resultado.
CREATE TABLE IF NOT EXISTS waitlist_deletion_log (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  scope text NOT NULL CHECK (scope IN ('inscricoes','medicao','agregados','optout','saida','pedido')),
  trigger text NOT NULL CHECK (trigger ~ '^[a-z0-9_]{1,40}$'),
  n integer NOT NULL CHECK (n >= 0),
  result text NOT NULL CHECK (result IN ('ok'))
);

INSERT INTO schema_migrations (migration_id)
VALUES ('030_waitlist_fase_a')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
