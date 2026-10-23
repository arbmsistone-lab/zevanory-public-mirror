-- B05 (Ordem 076-7): intenções de estorno Pix Asaas aprovadas pelo sistema/proprietário.
-- NÃO é uma migração numerada de db/migrations (o procedimento de restauração exige exatamente as 30 atuais);
-- é aplicada pelo proprietário, uma vez, no banco do Worker. Sem esta tabela o webhook de validação de saque
-- responde REFUSED para tudo (fail-closed). Idempotente.
BEGIN;
CREATE TABLE IF NOT EXISTS asaas_refund_intents (
  nonce text PRIMARY KEY CHECK (nonce ~ '^[a-f0-9]{64}$'),
  order_id uuid NOT NULL REFERENCES orders(order_id),
  payment_id text NOT NULL CHECK (payment_id ~ '^pay_[A-Za-z0-9_-]{6,120}$'),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  provider text NOT NULL CHECK (provider = 'asaas'),
  approved_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  used_refund_id text UNIQUE,
  revoked_at timestamptz,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '30 minutes'),
  CHECK ((used_at IS NULL) = (used_refund_id IS NULL))
);
-- No máximo UMA intenção aberta (não usada, não revogada) por pagamento. Intenção vencida é revogada pelo
-- próprio fluxo de criação antes de gravar a nova (createAsaasRefundIntent).
CREATE UNIQUE INDEX IF NOT EXISTS asaas_refund_intents_one_open_per_payment
  ON asaas_refund_intents (payment_id) WHERE used_at IS NULL AND revoked_at IS NULL;
COMMIT;
