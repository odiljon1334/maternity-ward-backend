-- AlterTable
ALTER TABLE "AttendanceRecord" ADD COLUMN     "faceVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "gpsVerified" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "LiveLocation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "accuracy" DOUBLE PRECISION NOT NULL,
    "speed" DOUBLE PRECISION,
    "battery" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LiveLocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LiveLocation_userId_createdAt_idx" ON "LiveLocation"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "LiveLocation" ADD CONSTRAINT "LiveLocation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
