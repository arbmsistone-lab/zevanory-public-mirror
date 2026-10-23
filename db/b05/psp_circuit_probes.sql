-- B05/B08 (Sol AVAL 083): coordenador FORTEMENTE consistente da sondagem única na meia-abertura do disjuntor de PSP.
-- O KV do Worker é eventualmente consistente; dois isolates podem ver "meio aberto" ao mesmo tempo. A sondagem só é
-- admitida para quem conseguir o lease desta linha (INSERT ... ON CONFLICT DO UPDATE ... WHERE lease vencido),
-- uma única transação atômica no PostgreSQL. Sem esta tabela nenhuma sondagem é admitida: o provedor continua
-- tratado como aberto até o proprietário aplicar este arquivo (fail-closed). Aplicado pelo proprietário, uma vez;
-- não é migração numerada (o procedimento de restauração exige exatamente as 30 atuais). Idempotente.
BEGIN;
CREATE TABLE IF NOT EXISTS psp_circuit_probes (
  provider text PRIMARY KEY CHECK (provider IN ('mercadopago', 'asaas')),
  lease_owner text NOT NULL,
  lease_until timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;
