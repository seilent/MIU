/*
  Warnings:

  - You are about to drop the column `url` on the `ThumbnailCache` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "ThumbnailCache" DROP COLUMN "url",
ADD COLUMN     "height" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "width" INTEGER NOT NULL DEFAULT 0;
