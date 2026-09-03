BEGIN;

CREATE TABLE IF NOT EXISTS lifecycle_certification_artifacts (
  artifact_id uuid PRIMARY KEY,
  artifact_sha256 text NOT NULL UNIQUE CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  evidence_root_sha256 text NOT NULL CHECK (evidence_root_sha256 ~ '^[0-9a-f]{64}$'),
  lifecycle_version text NOT NULL,
  deployed_commit_sha text NOT NULL CHECK (deployed_commit_sha ~ '^[0-9a-f]{40}$'),
  required_score integer NOT NULL DEFAULT 10 CHECK (required_score = 10),
  total_dimensions integer NOT NULL CHECK (total_dimensions = 39),
  proven_dimensions integer NOT NULL CHECK (proven_dimensions BETWEEN 0 AND 39),
  certification_approved boolean NOT NULL DEFAULT false,
  artifact_payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  approved_by text,
  CHECK ((status='approved') = (approved_at IS NOT NULL AND approved_by IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS lifecycle_certification_artifacts_status_idx
  ON lifecycle_certification_artifacts(status, created_at DESC);
CREATE OR REPLACE FUNCTION lifecycle_certification_artifact_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.artifact_sha256<>OLD.artifact_sha256
     OR NEW.evidence_root_sha256<>OLD.evidence_root_sha256
     OR NEW.lifecycle_version<>OLD.lifecycle_version
     OR NEW.deployed_commit_sha<>OLD.deployed_commit_sha
     OR NEW.required_score<>OLD.required_score
     OR NEW.total_dimensions<>OLD.total_dimensions
     OR NEW.proven_dimensions<>OLD.proven_dimensions
     OR NEW.certification_approved<>OLD.certification_approved
     OR NEW.artifact_payload<>OLD.artifact_payload
     OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'lifecycle_certification_artifact_immutable';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS lifecycle_certification_artifact_immutable_trg ON lifecycle_certification_artifacts;
CREATE TRIGGER lifecycle_certification_artifact_immutable_trg
BEFORE UPDATE ON lifecycle_certification_artifacts
FOR EACH ROW EXECUTE FUNCTION lifecycle_certification_artifact_immutable();

INSERT INTO schema_migrations(migration_id) VALUES('015_lifecycle_certification_provenance')
ON CONFLICT(migration_id) DO NOTHING;

COMMIT;
