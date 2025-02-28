-- CreateEnum
CREATE TYPE "RequestStatus" AS ENUM ('PENDING', 'PLAYING', 'QUEUED', 'COMPLETED', 'DOWNLOADING', 'SKIPPED', 'EXPIRED', 'READY');

-- CreateEnum
CREATE TYPE "PlaylistMode" AS ENUM ('LINEAR', 'POOL');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "discriminator" TEXT NOT NULL,
    "avatar" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "permissions" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Track" (
    "youtubeId" TEXT NOT NULL,
    "isMusicUrl" BOOLEAN NOT NULL DEFAULT false,
    "resolvedYtId" TEXT,
    "title" TEXT NOT NULL,
    "thumbnail" TEXT NOT NULL,
    "duration" INTEGER NOT NULL,
    "globalScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "playCount" INTEGER NOT NULL DEFAULT 0,
    "skipCount" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Track_pkey" PRIMARY KEY ("youtubeId")
);

-- CreateTable
CREATE TABLE "TrackState" (
    "youtubeId" TEXT NOT NULL,
    "status" "RequestStatus" NOT NULL DEFAULT 'PENDING',
    "lastUpdated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "queuedAt" TIMESTAMP(3),
    "playedAt" TIMESTAMP(3),

    CONSTRAINT "TrackState_pkey" PRIMARY KEY ("youtubeId")
);

-- CreateTable
CREATE TABLE "Request" (
    "youtubeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "playedAt" TIMESTAMP(3),
    "isAutoplay" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Request_pkey" PRIMARY KEY ("youtubeId","requestedAt")
);

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

-- CreateTable
CREATE TABLE "AudioCache" (
    "youtubeId" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AudioCache_pkey" PRIMARY KEY ("youtubeId")
);

-- CreateTable
CREATE TABLE "ThumbnailCache" (
    "youtubeId" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "width" INTEGER NOT NULL DEFAULT 0,
    "height" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ThumbnailCache_pkey" PRIMARY KEY ("youtubeId")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "DefaultPlaylist" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "mode" "PlaylistMode" NOT NULL DEFAULT 'LINEAR',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DefaultPlaylist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DefaultPlaylistTrack" (
    "playlistId" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DefaultPlaylistTrack_pkey" PRIMARY KEY ("playlistId","position")
);

-- CreateTable
CREATE TABLE "WebPresence" (
    "userId" TEXT NOT NULL,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebPresence_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "_UserRoles" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Role_name_key" ON "Role"("name");

-- CreateIndex
CREATE INDEX "Request_youtubeId_idx" ON "Request"("youtubeId");

-- CreateIndex
CREATE INDEX "UserTrackStats_userId_idx" ON "UserTrackStats"("userId");

-- CreateIndex
CREATE INDEX "UserTrackStats_youtubeId_idx" ON "UserTrackStats"("youtubeId");

-- CreateIndex
CREATE UNIQUE INDEX "DefaultPlaylist_name_key" ON "DefaultPlaylist"("name");

-- CreateIndex
CREATE INDEX "DefaultPlaylistTrack_trackId_idx" ON "DefaultPlaylistTrack"("trackId");

-- CreateIndex
CREATE UNIQUE INDEX "_UserRoles_AB_unique" ON "_UserRoles"("A", "B");

-- CreateIndex
CREATE INDEX "_UserRoles_B_index" ON "_UserRoles"("B");

-- AddForeignKey
ALTER TABLE "TrackState" ADD CONSTRAINT "TrackState_youtubeId_fkey" FOREIGN KEY ("youtubeId") REFERENCES "Track"("youtubeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Request" ADD CONSTRAINT "Request_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Request" ADD CONSTRAINT "Request_youtubeId_fkey" FOREIGN KEY ("youtubeId") REFERENCES "Track"("youtubeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserTrackStats" ADD CONSTRAINT "UserTrackStats_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserTrackStats" ADD CONSTRAINT "UserTrackStats_youtubeId_fkey" FOREIGN KEY ("youtubeId") REFERENCES "Track"("youtubeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioCache" ADD CONSTRAINT "AudioCache_youtubeId_fkey" FOREIGN KEY ("youtubeId") REFERENCES "Track"("youtubeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DefaultPlaylistTrack" ADD CONSTRAINT "DefaultPlaylistTrack_playlistId_fkey" FOREIGN KEY ("playlistId") REFERENCES "DefaultPlaylist"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DefaultPlaylistTrack" ADD CONSTRAINT "DefaultPlaylistTrack_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("youtubeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebPresence" ADD CONSTRAINT "WebPresence_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_UserRoles" ADD CONSTRAINT "_UserRoles_A_fkey" FOREIGN KEY ("A") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_UserRoles" ADD CONSTRAINT "_UserRoles_B_fkey" FOREIGN KEY ("B") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
