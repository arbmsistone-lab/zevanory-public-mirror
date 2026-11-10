-- ZEVANORY | Lembrete único de compra não concluída na Hotmart (plano de e-mail de abandono, Revisão 5b, seção 2.2).
-- Banco: o mesmo do diário P20 (zevanory-diario-p20, binding DIARIO), em tabelas SEPARADAS (abandono_*_v1), sem os
-- gatilhos de "somente inclusão" do diario_v1 e SEM e-mail, nome, telefone ou IP: ref = HMAC-SHA256 do e-mail
-- normalizado com chave derivada de LEAD_PRIVACY_SECRET (worker/abandono-hotmart.mjs). O e-mail em claro só existe na
-- pendência do KV (TTL de 72 h).
-- Consistência: o Worker usa o binding SEM a API de sessões do D1 (sem read replicas). Sem sessões, toda consulta vai
-- para o banco primário; a reserva é uma instrução única (INSERT ... SELECT ... WHERE ...), serializada no primário.
-- Retenção: abandono_envio_v1 e abandono_compra_v1 por 30 dias (limpeza diária isolada); abandono_supressao_v1 sem
-- prazo (oposição do titular, art. 18, §2º), protegida pelos gatilhos abaixo.

CREATE TABLE IF NOT EXISTS abandono_envio_v1 (
  ref TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  dia TEXT NOT NULL,
  estado TEXT NOT NULL CHECK (estado IN ('reservado','enviado','reconciliar','nao_confirmado','cancelado')),
  criado_ms INTEGER NOT NULL,
  lease_ms INTEGER NOT NULL,
  tentativas INTEGER NOT NULL DEFAULT 0,
  body_sha TEXT NOT NULL,
  resend_id TEXT
);

CREATE INDEX IF NOT EXISTS abandono_envio_v1_dia ON abandono_envio_v1 (dia);

-- Marcador de compra (aquecimento e ativo): HMAC do e-mail de quem comprou ou gerou boleto de um dos 5 kits.
CREATE TABLE IF NOT EXISTS abandono_compra_v1 (ref TEXT PRIMARY KEY, criado_ms INTEGER NOT NULL);

-- Supressão (descadastro): permanente. Nesta tabela só INSERT OR IGNORE. INSERT OR REPLACE e UPSERT com DO UPDATE são
-- proibidos: o REPLACE apaga e reinsere sem disparar o gatilho de DELETE quando recursive_triggers está desligado.
CREATE TABLE IF NOT EXISTS abandono_supressao_v1 (ref TEXT PRIMARY KEY, criado_ms INTEGER NOT NULL);

CREATE TRIGGER IF NOT EXISTS abandono_supressao_v1_sem_update
BEFORE UPDATE ON abandono_supressao_v1
BEGIN
  SELECT RAISE(ABORT, 'abandono_supressao_v1_permanente');
END;

CREATE TRIGGER IF NOT EXISTS abandono_supressao_v1_sem_delete
BEFORE DELETE ON abandono_supressao_v1
BEGIN
  SELECT RAISE(ABORT, 'abandono_supressao_v1_permanente');
END;
