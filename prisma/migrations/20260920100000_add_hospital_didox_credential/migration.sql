-- CreateTable
CREATE TABLE "HospitalDidoxCredential" (
    "id" TEXT NOT NULL,
    "hospitalId" TEXT NOT NULL,
    "serialNumber" TEXT NOT NULL,
    "authToken" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "lastAuthId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HospitalDidoxCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HospitalDidoxCredential_hospitalId_key" ON "HospitalDidoxCredential"("hospitalId");

-- AddForeignKey
ALTER TABLE "HospitalDidoxCredential" ADD CONSTRAINT "HospitalDidoxCredential_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Hospital"("id") ON DELETE CASCADE ON UPDATE CASCADE;
