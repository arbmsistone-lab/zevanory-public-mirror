-- B05 (Sol, bloqueio #879-1): livro-razão FORTEMENTE consistente do alerta da fila morta (DLQ) do webhook Asaas.
-- A pendência do alerta fica no KV (marcador asaas:webhook:dlq-alert:v1:<id>) até a entrega; esta tabela garante que,
-- com drenagens concorrentes, só UMA reivindica cada envio (UPDATE ... WHERE pending AND vencido AND sem reivindicação
-- viva) e que um alerta entregue ("sent") nunca é reenviado. Sem esta tabela a reivindicação falha => nada é enviado
-- pela reivindicação, erro contado e a pendência continua (o Worker sem DATABASE_URL usa só o KV + Idempotency-Key).
-- NÃO é migração numerada (o procedimento de restauração exige exatamente as 30 atuais); aplicada pelo proprietário,
-- uma vez. Idempotente.
BEGIN;
CREATE TABLE IF NOT EXISTS asaas_dlq_alerts (
  idempotency_key text PRIMARY KEY CHECK (idempotency_key ~ '^asaas-dlq-alert-v1-[A-Za-z0-9_&.-]{1,140}$'),
  event_id text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sent', 'exhausted')),
  attempts int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claim_owner text,
  claim_until timestamptz,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'sent') = (sent_at IS NOT NULL))
);
COMMIT;
