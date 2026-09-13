# ARBM ONE Recovery Posture

Updated: 2026-08-29

## Current verified state

- Supabase organization plan: Free.
- Native PITR is not enabled and is not part of the Free recovery posture.
- Supabase documentation recommends regular logical off-site exports for Free projects.
- Database size observed during Wave 11: 48,237,715 bytes.
- Public tables observed: 116.
- Storage observed: 2 buckets, 74 objects, about 22,183,881 bytes by metadata.
- Local repository contains more than 200 SQL migration files. The exact count is recorded by the current recovery evidence instead of being frozen in this overview.
- Remote migration history must not be treated as exact file-count parity with local SQL files; historical drift is tracked by the Migration Drift Guard workflow.
- Source rebuild from Git was independently proven in Wave 10.

## Recovery objectives

### Source and application

Source reconstruction is proven by the Source Recovery Build workflow. This does not prove database restore time.

### Database and Storage data

Encrypted off-site backup creation and artifact integrity have been proven by successful Data Recovery Backup runs.
Target RPO: 24 hours, matching the daily workflow cadence. Meeting that objective continuously still depends on the scheduled workflow remaining green; one successful artifact is proof of recoverability, not proof of a long-term RPO history.

Database plus Storage recovery has been proven in an isolated ephemeral PostgreSQL environment, including manifest hashes, required platform roles, schema/data restore and Storage metadata invariants. The measured data-and-Storage restore RTO is recorded in `docs/recovery-runbook-v1.md` (49.874 seconds for the verified drill).

End-to-end service RTO remains unproven because a full failover into a separate hosted Supabase project, including secrets, Edge Functions, Auth behavior, DNS and application cutover, has not been executed. Do not present the isolated restore time as the complete service RTO.
## Backup prerequisites

The workflow requires these GitHub Actions secrets and never prints their values:

- `SUPABASE_DB_URL`: production Postgres connection string suitable for logical dumps.
- `SUPABASE_SERVICE_ROLE_KEY`: used only to enumerate and download Storage objects.
- `BACKUP_PASSPHRASE`: encrypts the combined database and Storage archive with GPG AES-256.

If any prerequisite is missing, the workflow fails closed and exports no plaintext production data.

## Backup contents

When enabled, each successful run contains encrypted copies of:

- database roles dump;
- database schema dump;
- database data dump using COPY;
- all accessible Storage bucket objects;
- bucket configuration metadata;
- SHA-256 manifests for database and Storage payloads.

Only the encrypted archive and its SHA-256 are uploaded as GitHub artifacts. Plaintext recovery data is removed before upload.

## Important exclusions

Supabase database dumps alone do not restore Storage object bytes, which is why Storage is exported separately.
Secret values for Edge Functions and external providers are not recoverable from Git and require a separately controlled secret-management process.
