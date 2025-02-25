-- AlterTable
ALTER TABLE "Track" ADD COLUMN     "isAvailable" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "lastCheckTime" TIMESTAMP(3);
