/*
  Warnings:

  - A unique constraint covering the columns `[resolvedYtId]` on the table `Track` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Track" ADD COLUMN     "isMusicUrl" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "resolvedYtId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Track_resolvedYtId_key" ON "Track"("resolvedYtId");
