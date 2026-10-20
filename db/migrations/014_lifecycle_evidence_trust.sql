BEGIN;

ALTER TABLE lifecycle_evidence_events
  ADD COLUMN IF NOT EXISTS source_class text NOT NULL DEFAULT 'operator_validation'
    CHECK (source_class IN ('canonical_database','provider_webhook','operator_validation','synthetic_probe')),
  ADD COLUMN IF NOT EXISTS verification_status text NOT NULL DEFAULT 'pending'
    CHECK (verification_status IN ('pending','verified','rejected')),
  ADD COLUMN IF NOT EXISTS evidence_sha256 text
    CHECK (evidence_sha256 IS NULL OR evidence_sha256 ~ '^[a-f0-9]{64}$'),
  ADD COLUMN IF NOT EXISTS verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS verified_by text;

ALTER TABLE lifecycle_evidence_events
  DROP CONSTRAINT IF EXISTS lifecycle_evidence_verified_consistency;
ALTER TABLE lifecycle_evidence_events
  ADD CONSTRAINT lifecycle_evidence_verified_consistency CHECK (
    (verification_status='verified' AND verified_at IS NOT NULL AND evidence_sha256 IS NOT NULL)
    OR verification_status<>'verified'
  );

CREATE INDEX IF NOT EXISTS lifecycle_evidence_verified_idx
  ON lifecycle_evidence_events(dimension,source_class,occurred_at DESC)
  WHERE verification_status='verified';
INSERT INTO schema_migrations (migration_id)
VALUES ('014_lifecycle_evidence_trust')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;