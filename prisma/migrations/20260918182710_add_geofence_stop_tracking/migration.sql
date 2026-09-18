-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'GEOFENCE_ALERT';

-- AlterTable
ALTER TABLE "LiveLocation" ADD COLUMN     "isOutside" BOOLEAN;
