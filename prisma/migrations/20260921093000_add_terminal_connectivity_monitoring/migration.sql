-- Terminal monitoring holati. Barcha maydonlar nullable va additive:
-- mavjud terminallar hamda webhook/davomat oqimiga ta'sir qilmaydi.
ALTER TABLE "HikTerminal"
ADD COLUMN "lastSeenAt" TIMESTAMP(3),
ADD COLUMN "offlineSince" TIMESTAMP(3),
ADD COLUMN "lastOfflineAlertAt" TIMESTAMP(3);
