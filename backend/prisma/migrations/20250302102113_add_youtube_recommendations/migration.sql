-- CreateTable
CREATE TABLE "YoutubeRecommendation" (
    "youtubeId" TEXT NOT NULL,
    "seedTrackId" TEXT NOT NULL,
    "relevanceScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "isJapanese" BOOLEAN NOT NULL DEFAULT false,
    "wasPlayed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "YoutubeRecommendation_pkey" PRIMARY KEY ("youtubeId")
);

-- CreateIndex
CREATE INDEX "YoutubeRecommendation_seedTrackId_idx" ON "YoutubeRecommendation"("seedTrackId");

-- CreateIndex
CREATE INDEX "YoutubeRecommendation_isJapanese_idx" ON "YoutubeRecommendation"("isJapanese");
