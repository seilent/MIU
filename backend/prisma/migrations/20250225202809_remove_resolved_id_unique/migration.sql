/*
  Warnings:

  - You are about to drop the column `oembedAuthor` on the `Track` table. All the data in the column will be lost.
  - You are about to drop the column `oembedChannelId` on the `Track` table. All the data in the column will be lost.
  - You are about to drop the column `oembedTitle` on the `Track` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "Track_resolvedYtId_key";

-- AlterTable
ALTER TABLE "Track" DROP COLUMN "oembedAuthor",
DROP COLUMN "oembedChannelId",
DROP COLUMN "oembedTitle";
