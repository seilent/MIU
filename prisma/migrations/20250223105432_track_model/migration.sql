/*
  Warnings:

  - You are about to drop the column `artist` on the `AudioCache` table. All the data in the column will be lost.
  - You are about to drop the column `duration` on the `AudioCache` table. All the data in the column will be lost.
  - You are about to drop the column `title` on the `AudioCache` table. All the data in the column will be lost.
  - You are about to drop the column `youtubeId` on the `AudioCache` table. All the data in the column will be lost.
  - You are about to drop the column `artist` on the `DefaultPlaylistTrack` table. All the data in the column will be lost.
  - You are about to drop the column `duration` on the `DefaultPlaylistTrack` table. All the data in the column will be lost.
  - You are about to drop the column `thumbnail` on the `DefaultPlaylistTrack` table. All the data in the column will be lost.
  - You are about to drop the column `title` on the `DefaultPlaylistTrack` table. All the data in the column will be lost.
  - You are about to drop the column `youtubeId` on the `DefaultPlaylistTrack` table. All the data in the column will be lost.
  - You are about to drop the column `artist` on the `Request` table. All the data in the column will be lost.
  - You are about to drop the column `duration` on the `Request` table. All the data in the column will be lost.
  - You are about to drop the column `thumbnail` on the `Request` table. All the data in the column will be lost.
  - You are about to drop the column `title` on the `Request` table. All the data in the column will be lost.
  - You are about to drop the column `youtubeId` on the `Request` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[trackId]` on the table `AudioCache` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `trackId` to the `AudioCache` table without a default value. This is not possible if the table is not empty.
  - Added the required column `trackId` to the `DefaultPlaylistTrack` table without a default value. This is not possible if the table is not empty.
  - Added the required column `trackId` to the `Request` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "AudioCache_youtubeId_key";

-- AlterTable
ALTER TABLE "AudioCache" DROP COLUMN "artist",
DROP COLUMN "duration",
DROP COLUMN "title",
DROP COLUMN "youtubeId",
ADD COLUMN     "trackId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "DefaultPlaylistTrack" DROP COLUMN "artist",
DROP COLUMN "duration",
DROP COLUMN "thumbnail",
DROP COLUMN "title",
DROP COLUMN "youtubeId",
ADD COLUMN     "trackId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Request" DROP COLUMN "artist",
DROP COLUMN "duration",
DROP COLUMN "thumbnail",
DROP COLUMN "title",
DROP COLUMN "youtubeId",
ADD COLUMN     "trackId" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "Track" (
    "id" TEXT NOT NULL,
    "youtubeId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "artist" TEXT,
    "thumbnail" TEXT NOT NULL,
    "duration" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Track_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Track_youtubeId_key" ON "Track"("youtubeId");

-- CreateIndex
CREATE UNIQUE INDEX "AudioCache_trackId_key" ON "AudioCache"("trackId");

-- CreateIndex
CREATE INDEX "DefaultPlaylistTrack_trackId_idx" ON "DefaultPlaylistTrack"("trackId");

-- CreateIndex
CREATE INDEX "Request_trackId_idx" ON "Request"("trackId");

-- AddForeignKey
ALTER TABLE "Request" ADD CONSTRAINT "Request_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioCache" ADD CONSTRAINT "AudioCache_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DefaultPlaylistTrack" ADD CONSTRAINT "DefaultPlaylistTrack_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
