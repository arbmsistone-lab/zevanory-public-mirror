-- Reversão da migração 030 (P01 Fase A). Apaga as 5 tabelas e o registro em schema_migrations.
-- Fora de db/migrations de propósito (a restauração aplica só as migrações listadas em db/migrations/MANIFEST).
BEGIN;
DROP TABLE IF EXISTS waitlist_raw_daily;
DROP TABLE IF EXISTS waitlist_deletion_log;
DROP TABLE IF EXISTS waitlist_person_alias;
DROP TABLE IF EXISTS waitlist_persons;
DROP TABLE IF EXISTS waitlist_signups;
DELETE FROM schema_migrations WHERE migration_id = '030_waitlist_fase_a';
COMMIT;
