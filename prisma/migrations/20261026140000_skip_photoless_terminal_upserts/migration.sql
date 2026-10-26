ALTER TABLE "HikPersonDelivery" DROP CONSTRAINT "HikPersonDelivery_state_check";
ALTER TABLE "HikPersonDelivery" ADD CONSTRAINT "HikPersonDelivery_state_check"
 CHECK ("state" IN ('WAITING','ACTIVE','DELIVERED','ERROR','SKIPPED'));
-- Fence legacy photo-less tasks; never send a device deletion as cleanup.
UPDATE "HikPersonDelivery" SET "state"='SKIPPED',"revision"="revision"+1,
 "attempts"=0,"lastError"=NULL,"leaseOwner"=NULL,"leaseUntil"=NULL,"updatedAt"=(now() AT TIME ZONE 'UTC')
 WHERE "action"='UPSERT' AND NULLIF(btrim("photoUrl"),'') IS NULL;
CREATE OR REPLACE FUNCTION staffplus_queue_person(eid TEXT, eno TEXT, hid TEXT, fullname TEXT, photo TEXT, op TEXT, tid TEXT DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
 IF eno IS NULL OR eno = '' THEN RETURN; END IF;
 IF op='UPSERT' AND NULLIF(btrim(photo),'') IS NULL THEN
  UPDATE "HikPersonDelivery" SET "state"='SKIPPED',"photoUrl"=NULL,
   "revision"="revision"+1,"attempts"=0,"lastError"=NULL,"leaseOwner"=NULL,"leaseUntil"=NULL,
   "updatedAt"=(now() AT TIME ZONE 'UTC')
   WHERE "employeeId"=eid AND "hospitalId"=hid AND "action"='UPSERT'
    AND (tid IS NULL OR "terminalId"=tid);
  RETURN;
 END IF;
 INSERT INTO "HikPersonDelivery" ("id","terminalId","hospitalId","employeeId","employeeNo","fullName","photoUrl","action")
 SELECT md5(t."id" || ':' || eno),t."id",hid,eid,eno,fullname,photo,op
 FROM "HikTerminal" t WHERE t."hospitalId"=hid AND (tid IS NULL OR t.id=tid)
 ON CONFLICT ("terminalId","employeeNo") DO UPDATE SET
 "employeeId"=EXCLUDED."employeeId", "fullName"=EXCLUDED."fullName", "photoUrl"=EXCLUDED."photoUrl",
 "action"=EXCLUDED."action", "revision"="HikPersonDelivery"."revision"+1,
 "state"=CASE WHEN "HikPersonDelivery"."state"='ACTIVE' THEN 'ACTIVE' ELSE 'WAITING' END,
 "attempts"=0,"lastError"=NULL,"availableAt"=(now() AT TIME ZONE 'UTC'),"updatedAt"=(now() AT TIME ZONE 'UTC');
END $$;
