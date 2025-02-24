/*
  Warnings:

  - The primary key for the `DefaultPlaylistTrack` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `id` on the `DefaultPlaylistTrack` table. All the data in the column will be lost.
  - The primary key for the `Request` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `createdAt` on the `Request` table. All the data in the column will be lost.
  - You are about to drop the column `duration` on the `Request` table. All the data in the column will be lost.
  - You are about to drop the column `id` on the `Request` table. All the data in the column will be lost.
  - You are about to drop the column `thumbnail` on the `Request` table. All the data in the column will be lost.
  - You are about to drop the column `title` on the `Request` table. All the data in the column will be lost.
  - You are about to drop the column `updatedAt` on the `Request` table. All the data in the column will be lost.
  - The primary key for the `Setting` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `id` on the `Setting` table. All the data in the column will be lost.
  - The primary key for the `ThumbnailCache` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `id` on the `ThumbnailCache` table. All the data in the column will be lost.
  - The primary key for the `_UserRoles` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the `RequestPlay` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `TrackReaction` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `TrackTag` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `UserTagPreference` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[A,B]` on the table `_UserRoles` will be added. If there are existing duplicate values, this will fail.

*/
-- DropForeignKey
ALTER TABLE "RequestPlay" DROP CONSTRAINT "RequestPlay_requestId_fkey";

-- DropForeignKey
ALTER TABLE "RequestPlay" DROP CONSTRAINT "RequestPlay_userId_fkey";

-- DropForeignKey
ALTER TABLE "TrackReaction" DROP CONSTRAINT "TrackReaction_trackId_fkey";

-- DropForeignKey
ALTER TABLE "TrackReaction" DROP CONSTRAINT "TrackReaction_userId_fkey";

-- DropForeignKey
ALTER TABLE "TrackTag" DROP CONSTRAINT "TrackTag_trackId_fkey";

-- DropForeignKey
ALTER TABLE "UserTagPreference" DROP CONSTRAINT "UserTagPreference_userId_fkey";

-- DropIndex
DROP INDEX "DefaultPlaylistTrack_playlistId_position_key";

-- DropIndex
DROP INDEX "Request_isAutoplay_status_playedAt_idx";

-- DropIndex
DROP INDEX "Setting_key_key";

-- DropIndex
DROP INDEX "ThumbnailCache_youtubeId_key";

-- AlterTable
ALTER TABLE "DefaultPlaylistTrack" DROP CONSTRAINT "DefaultPlaylistTrack_pkey",
DROP COLUMN "id",
ADD CONSTRAINT "DefaultPlaylistTrack_pkey" PRIMARY KEY ("playlistId", "position");

-- AlterTable
ALTER TABLE "Request" DROP CONSTRAINT "Request_pkey",
DROP COLUMN "createdAt",
DROP COLUMN "duration",
DROP COLUMN "id",
DROP COLUMN "thumbnail",
DROP COLUMN "title",
DROP COLUMN "updatedAt",
ADD CONSTRAINT "Request_pkey" PRIMARY KEY ("youtubeId", "requestedAt");

-- AlterTable
ALTER TABLE "Setting" DROP CONSTRAINT "Setting_pkey",
DROP COLUMN "id",
ADD CONSTRAINT "Setting_pkey" PRIMARY KEY ("key");

-- AlterTable
ALTER TABLE "ThumbnailCache" DROP CONSTRAINT "ThumbnailCache_pkey",
DROP COLUMN "id",
ADD CONSTRAINT "ThumbnailCache_pkey" PRIMARY KEY ("youtubeId");

-- AlterTable
ALTER TABLE "Track" ADD COLUMN     "globalScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "playCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "skipCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "_UserRoles" DROP CONSTRAINT "_UserRoles_AB_pkey";

-- DropTable
DROP TABLE "RequestPlay";

-- DropTable
DROP TABLE "TrackReaction";

-- DropTable
DROP TABLE "TrackTag";

-- DropTable
DROP TABLE "UserTagPreference";

-- DropEnum
DROP TYPE "ReactionType";

-- CreateTable
CREATE TABLE "UserTrackStats" (
    "userId" TEXT NOT NULL,
    "youtubeId" TEXT NOT NULL,
    "playCount" INTEGER NOT NULL DEFAULT 0,
    "skipCount" INTEGER NOT NULL DEFAULT 0,
    "totalListenTime" INTEGER NOT NULL DEFAULT 0,
    "lastPlayed" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "personalScore" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "UserTrackStats_pkey" PRIMARY KEY ("userId","youtubeId")
);

-- CreateIndex
CREATE INDEX "UserTrackStats_userId_idx" ON "UserTrackStats"("userId");

-- CreateIndex
CREATE INDEX "UserTrackStats_youtubeId_idx" ON "UserTrackStats"("youtubeId");

-- CreateIndex
CREATE INDEX "Request_status_requestedAt_idx" ON "Request"("status", "requestedAt");

-- CreateIndex
CREATE UNIQUE INDEX "_UserRoles_AB_unique" ON "_UserRoles"("A", "B");

-- AddForeignKey
ALTER TABLE "UserTrackStats" ADD CONSTRAINT "UserTrackStats_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserTrackStats" ADD CONSTRAINT "UserTrackStats_youtubeId_fkey" FOREIGN KEY ("youtubeId") REFERENCES "Track"("youtubeId") ON DELETE RESTRICT ON UPDATE CASCADE;
