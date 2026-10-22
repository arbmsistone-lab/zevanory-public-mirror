CREATE TABLE fence(id int PRIMARY KEY CHECK(id=1), epoch bigint NOT NULL CHECK(epoch>=1), owner text NOT NULL);
INSERT INTO fence VALUES(1,1,'W1');
CREATE TABLE ledger(op_id text PRIMARY KEY, writer text NOT NULL, epoch bigint NOT NULL, amount int NOT NULL);
CREATE FUNCTION ledger_fence() RETURNS trigger LANGUAGE plpgsql AS $f$
DECLARE f fence%ROWTYPE;
BEGIN
  SELECT * INTO f FROM fence WHERE id=1 FOR SHARE;
  IF NEW.epoch IS NULL OR NEW.epoch <> f.epoch OR NEW.writer IS DISTINCT FROM f.owner THEN
    RAISE EXCEPTION 'FENCED: writer=% epoch=% (atual owner=% epoch=%)', NEW.writer, NEW.epoch, f.owner, f.epoch
      USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $f$;
CREATE TRIGGER ledger_fence BEFORE INSERT OR UPDATE ON ledger FOR EACH ROW EXECUTE FUNCTION ledger_fence();
CREATE FUNCTION promote_writer(p_expected bigint, p_new_owner text) RETURNS bigint LANGUAGE sql AS
 'UPDATE fence SET epoch=epoch+1, owner=p_new_owner WHERE id=1 AND epoch=p_expected RETURNING epoch';
