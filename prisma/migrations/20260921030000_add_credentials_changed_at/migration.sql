-- Password changes revoke every JWT issued before this timestamp.
ALTER TABLE "User" ADD COLUMN "credentialsChangedAt" TIMESTAMP(3);
