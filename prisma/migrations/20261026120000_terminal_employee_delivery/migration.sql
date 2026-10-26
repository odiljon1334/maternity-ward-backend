CREATE TABLE "HikPersonDelivery" (
 "id" TEXT PRIMARY KEY, "terminalId" TEXT NOT NULL, "hospitalId" TEXT NOT NULL,
 "employeeId" TEXT NOT NULL, "employeeNo" TEXT NOT NULL, "fullName" TEXT NOT NULL,
 "photoUrl" TEXT, "action" TEXT NOT NULL, "revision" INTEGER NOT NULL DEFAULT 1,
 "deliveredRevision" INTEGER NOT NULL DEFAULT 0, "state" TEXT NOT NULL DEFAULT 'WAITING',
 "attempts" INTEGER NOT NULL DEFAULT 0, "lastError" TEXT, "deliveredPhotoUrl" TEXT,
 "confirmedAt" TIMESTAMP(3), "availableAt" TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),
 "leaseOwner" TEXT, "leaseUntil" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),
 "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),
 CONSTRAINT "HikPersonDelivery_action_check" CHECK ("action" IN ('UPSERT','BLOCK','DELETE')),
 CONSTRAINT "HikPersonDelivery_state_check" CHECK ("state" IN ('WAITING','ACTIVE','DELIVERED','ERROR'))
);
CREATE UNIQUE INDEX "HikPersonDelivery_terminalId_employeeNo_key" ON "HikPersonDelivery"("terminalId","employeeNo");
CREATE INDEX "HikPersonDelivery_hospitalId_employeeId_idx" ON "HikPersonDelivery"("hospitalId","employeeId");
CREATE INDEX "HikPersonDelivery_state_availableAt_idx" ON "HikPersonDelivery"("state","availableAt");

-- Transactional outbox: all writers (including imports and bulk deletes) participate.
CREATE FUNCTION staffplus_queue_person(eid TEXT, eno TEXT, hid TEXT, fullname TEXT, photo TEXT, op TEXT, tid TEXT DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
 IF eno IS NULL OR eno = '' THEN RETURN; END IF;
 INSERT INTO "HikPersonDelivery" ("id","terminalId","hospitalId","employeeId","employeeNo","fullName","photoUrl","action")
 SELECT md5(t."id" || ':' || eno),t."id",hid,eid,eno,fullname,photo,op
 FROM "HikTerminal" t WHERE t."hospitalId"=hid AND (tid IS NULL OR t.id=tid)
 ON CONFLICT ("terminalId","employeeNo") DO UPDATE SET
 "employeeId"=EXCLUDED."employeeId", "fullName"=EXCLUDED."fullName", "photoUrl"=EXCLUDED."photoUrl",
 "action"=EXCLUDED."action", "revision"="HikPersonDelivery"."revision"+1,
 "state"=CASE WHEN "HikPersonDelivery"."state"='ACTIVE' THEN 'ACTIVE' ELSE 'WAITING' END,
 "attempts"=0,"lastError"=NULL,"availableAt"=(now() AT TIME ZONE 'UTC'),"updatedAt"=(now() AT TIME ZONE 'UTC');
END $$;
CREATE FUNCTION staffplus_employee_terminal_outbox() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE blocked BOOLEAN;
BEGIN
 IF TG_OP='DELETE' THEN
  PERFORM staffplus_queue_person(OLD.id,OLD."employeeNo",OLD."hospitalId",OLD."fullName",NULL,'DELETE'); RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF ROW(OLD."employeeNo",OLD."hospitalId",OLD."fullName",OLD."photoUrl",OLD.status,OLD."firedAt",OLD."userId")
    IS NOT DISTINCT FROM ROW(NEW."employeeNo",NEW."hospitalId",NEW."fullName",NEW."photoUrl",NEW.status,NEW."firedAt",NEW."userId") THEN RETURN NEW; END IF;
  IF ROW(OLD."employeeNo",OLD."hospitalId") IS DISTINCT FROM ROW(NEW."employeeNo",NEW."hospitalId") THEN
   PERFORM staffplus_queue_person(OLD.id,OLD."employeeNo",OLD."hospitalId",OLD."fullName",NULL,'DELETE');
  END IF;
 END IF;
 blocked := NEW."firedAt" IS NOT NULL OR NEW.status::text IN ('INACTIVE','FIRED') OR
  EXISTS(SELECT 1 FROM "User" u WHERE u.id=NEW."userId" AND u.status::text <> 'ACTIVE');
 PERFORM staffplus_queue_person(NEW.id,NEW."employeeNo",NEW."hospitalId",NEW."fullName",NEW."photoUrl",CASE WHEN blocked THEN 'BLOCK' ELSE 'UPSERT' END);
 RETURN NEW;
END $$;
CREATE TRIGGER employee_terminal_outbox AFTER INSERT OR UPDATE OR DELETE ON "Employee"
FOR EACH ROW EXECUTE FUNCTION staffplus_employee_terminal_outbox();
CREATE FUNCTION staffplus_user_terminal_outbox() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE e RECORD;
BEGIN
 IF OLD.status IS NOT DISTINCT FROM NEW.status THEN RETURN NEW; END IF;
 FOR e IN SELECT * FROM "Employee" WHERE "userId"=NEW.id ORDER BY id LOOP
  PERFORM staffplus_queue_person(e.id,e."employeeNo",e."hospitalId",e."fullName",e."photoUrl",
   CASE WHEN NEW.status::text <> 'ACTIVE' OR e."firedAt" IS NOT NULL OR e.status::text IN ('INACTIVE','FIRED') THEN 'BLOCK' ELSE 'UPSERT' END);
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER user_terminal_outbox AFTER UPDATE OF status ON "User"
FOR EACH ROW EXECUTE FUNCTION staffplus_user_terminal_outbox();
-- Terminal attachment/reenabling queues its inventory; no mass migration backfill.
CREATE FUNCTION staffplus_terminal_inventory_outbox() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE e RECORD;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NOT (NEW."isActive" AND (NOT OLD."isActive" OR NEW."devIndex"<>OLD."devIndex")) THEN RETURN NEW; END IF;
 END IF;
 IF NEW."isActive" THEN
  FOR e IN SELECT emp.*,u.status::text AS user_status FROM "Employee" emp LEFT JOIN "User" u ON u.id=emp."userId"
   WHERE emp."hospitalId"=NEW."hospitalId" ORDER BY emp.id LOOP
   PERFORM staffplus_queue_person(e.id,e."employeeNo",e."hospitalId",e."fullName",e."photoUrl",
    CASE WHEN e."firedAt" IS NOT NULL OR e.status::text IN ('INACTIVE','FIRED') OR COALESCE(e.user_status,'ACTIVE')<>'ACTIVE' THEN 'BLOCK' ELSE 'UPSERT' END);
  END LOOP;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER terminal_inventory_outbox AFTER INSERT OR UPDATE ON "HikTerminal"
FOR EACH ROW EXECUTE FUNCTION staffplus_terminal_inventory_outbox();
