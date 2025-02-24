/*
  Warnings:

  - The primary key for the `AudioCache` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `id` on the `AudioCache` table. All the data in the column will be lost.
  - You are about to drop the column `trackId` on the `AudioCache` table. All the data in the column will be lost.
  - You are about to drop the column `trackId` on the `Request` table. All the data in the column will be lost.
  - The primary key for the `Track` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `artist` on the `Track` table. All the data in the column will be lost.
  - You are about to drop the column `id` on the `Track` table. All the data in the column will be lost.
  - Added the required column `youtubeId` to the `AudioCache` table without a default value. This is not possible if the table is not empty.
  - Added the required column `duration` to the `Request` table without a default value. This is not possible if the table is not empty.
  - Added the required column `thumbnail` to the `Request` table without a default value. This is not possible if the table is not empty.
  - Added the required column `title` to the `Request` table without a default value. This is not possible if the table is not empty.
  - Added the required column `youtubeId` to the `Request` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "ReactionType" AS ENUM ('LIKE', 'DISLIKE', 'FAVORITE');

-- DropForeignKey
ALTER TABLE "AudioCache" DROP CONSTRAINT "AudioCache_trackId_fkey";

-- DropForeignKey
ALTER TABLE "DefaultPlaylistTrack" DROP CONSTRAINT "DefaultPlaylistTrack_trackId_fkey";

-- DropForeignKey
ALTER TABLE "Request" DROP CONSTRAINT "Request_trackId_fkey";

-- DropIndex
DROP INDEX "AudioCache_trackId_key";

-- DropIndex
DROP INDEX "Request_trackId_idx";

-- DropIndex
DROP INDEX "Track_youtubeId_key";

-- AlterTable
ALTER TABLE "AudioCache" DROP CONSTRAINT "AudioCache_pkey",
DROP COLUMN "id",
DROP COLUMN "trackId",
ADD COLUMN     "youtubeId" TEXT NOT NULL,
ADD CONSTRAINT "AudioCache_pkey" PRIMARY KEY ("youtubeId");

-- AlterTable
ALTER TABLE "Request" DROP COLUMN "trackId",
ADD COLUMN     "duration" INTEGER NOT NULL,
ADD COLUMN     "thumbnail" TEXT NOT NULL,
ADD COLUMN     "title" TEXT NOT NULL,
ADD COLUMN     "youtubeId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Track" DROP CONSTRAINT "Track_pkey",
DROP COLUMN "artist",
DROP COLUMN "id",
ADD CONSTRAINT "Track_pkey" PRIMARY KEY ("youtubeId");

-- CreateTable
CREATE TABLE "RequestPlay" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),
    "listenDuration" INTEGER NOT NULL,
    "skipped" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "RequestPlay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackReaction" (
    "id" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "ReactionType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrackReaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackTag" (
    "id" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrackTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserTagPreference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserTagPreference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RequestPlay_userId_idx" ON "RequestPlay"("userId");

-- CreateIndex
CREATE INDEX "RequestPlay_requestId_idx" ON "RequestPlay"("requestId");

-- CreateIndex
CREATE INDEX "TrackReaction_userId_idx" ON "TrackReaction"("userId");

-- CreateIndex
CREATE INDEX "TrackReaction_trackId_idx" ON "TrackReaction"("trackId");

-- CreateIndex
CREATE UNIQUE INDEX "TrackReaction_trackId_userId_key" ON "TrackReaction"("trackId", "userId");

-- CreateIndex
CREATE INDEX "TrackTag_tag_idx" ON "TrackTag"("tag");

-- CreateIndex
CREATE INDEX "TrackTag_trackId_idx" ON "TrackTag"("trackId");

-- CreateIndex
CREATE UNIQUE INDEX "TrackTag_trackId_tag_key" ON "TrackTag"("trackId", "tag");

-- CreateIndex
CREATE INDEX "UserTagPreference_userId_idx" ON "UserTagPreference"("userId");

-- CreateIndex
CREATE INDEX "UserTagPreference_tag_idx" ON "UserTagPreference"("tag");

-- CreateIndex
CREATE UNIQUE INDEX "UserTagPreference_userId_tag_key" ON "UserTagPreference"("userId", "tag");

-- CreateIndex
CREATE INDEX "Request_youtubeId_idx" ON "Request"("youtubeId");

-- AddForeignKey
ALTER TABLE "Request" ADD CONSTRAINT "Request_youtubeId_fkey" FOREIGN KEY ("youtubeId") REFERENCES "Track"("youtubeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioCache" ADD CONSTRAINT "AudioCache_youtubeId_fkey" FOREIGN KEY ("youtubeId") REFERENCES "Track"("youtubeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DefaultPlaylistTrack" ADD CONSTRAINT "DefaultPlaylistTrack_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("youtubeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequestPlay" ADD CONSTRAINT "RequestPlay_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "Request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequestPlay" ADD CONSTRAINT "RequestPlay_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackReaction" ADD CONSTRAINT "TrackReaction_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("youtubeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackReaction" ADD CONSTRAINT "TrackReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackTag" ADD CONSTRAINT "TrackTag_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("youtubeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserTagPreference" ADD CONSTRAINT "UserTagPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
