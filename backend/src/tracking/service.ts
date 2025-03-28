import { prisma } from '../db.js';
import type { Track, User, Request, Prisma } from '@prisma/client';

export class TrackingService {
  // Track when a user joins a voice channel during a song
  async trackUserJoin(userId: string, youtubeId: string): Promise<void> {
    try {
      // First ensure the user exists
      const user = await prisma.user.findUnique({
        where: { id: userId }
      });

      if (!user) {
        console.error(`Cannot track stats for non-existent user: ${userId}`);
        return;
      }

      // First check if track exists
      const track = await prisma.track.findUnique({
        where: { youtubeId }
      });

      if (!track) {
        console.error(`Cannot track stats for non-existent track: ${youtubeId}`);
        return;
      }

      // Update user stats only if both user and track exist
      await prisma.$executeRaw`
        INSERT INTO "UserTrackStats" ("userId", "youtubeId", "playCount", "skipCount", "totalListenTime", "personalScore", "lastPlayed")
        VALUES (${userId}, ${youtubeId}, 0, 0, 0, 0, NOW())
        ON CONFLICT ("userId", "youtubeId") DO UPDATE
        SET "lastPlayed" = NOW()
      `;
    } catch (error) {
      console.error('Error tracking user join:', error);
    }
  }

  // Track when a user leaves a song (either by skipping or natural end)
  async trackUserLeave(
    userId: string,
    youtubeId: string,
    listenDuration: number,
    trackDuration: number,
    wasSkipped: boolean
  ): Promise<void> {
    try {
      // First ensure the user exists
      const user = await prisma.user.findUnique({
        where: { id: userId }
      });

      if (!user) {
        console.error(`Cannot track stats for non-existent user: ${userId}`);
        return;
      }

      // Check if track exists
      const track = await prisma.track.findUnique({
        where: { youtubeId }
      });

      if (!track) {
        console.error(`Cannot track stats for non-existent track: ${youtubeId}`);
        return;
      }

      const listenRatio = listenDuration / trackDuration;
      
      // Calculate score updates
      let scoreUpdate = 0;
      if (wasSkipped || listenRatio < 0.3) {
        scoreUpdate = -0.1; // Penalty for skips or short listens
      } else if (listenRatio >= 0.8) {
        scoreUpdate = 0.1; // Bonus for completing songs
      } else {
        scoreUpdate = 0.05; // Small bonus for partial listens
      }

      await prisma.$transaction([
        // Update user stats
        prisma.$executeRaw`
          INSERT INTO "UserTrackStats" ("userId", "youtubeId", "playCount", "skipCount", "totalListenTime", "personalScore", "lastPlayed")
          VALUES (${userId}, ${youtubeId}, 1, ${wasSkipped ? 1 : 0}, ${listenDuration}, ${scoreUpdate}, NOW())
          ON CONFLICT ("userId", "youtubeId") DO UPDATE
          SET "playCount" = "UserTrackStats"."playCount" + 1,
              "skipCount" = "UserTrackStats"."skipCount" + ${wasSkipped ? 1 : 0},
              "totalListenTime" = "UserTrackStats"."totalListenTime" + ${listenDuration},
              "personalScore" = "UserTrackStats"."personalScore" + ${scoreUpdate},
              "lastPlayed" = NOW()
        `,
        // Update global track stats
        prisma.$executeRaw`
          UPDATE "Track"
          SET "playCount" = "Track"."playCount" + 1,
              "skipCount" = "Track"."skipCount" + ${wasSkipped ? 1 : 0},
              "globalScore" = "Track"."globalScore" + ${scoreUpdate}
          WHERE "youtubeId" = ${youtubeId}
        `
      ]);
    } catch (error) {
      console.error('Error tracking user leave:', error);
    }
  }

  // Get track stats
  async getTrackStats(youtubeId: string): Promise<{
    playCount: number;
    skipCount: number;
    globalScore: number;
    averageListenTime: number;
  }> {
    try {
      const [trackStats, avgListenTime] = await prisma.$transaction([
        prisma.$queryRaw<Array<{ playCount: number; skipCount: number; globalScore: number }>>`
          SELECT "playCount", "skipCount", "globalScore"
          FROM "Track"
          WHERE "youtubeId" = ${youtubeId}
        `,
        prisma.$queryRaw<Array<{ avg: number }>>`
          SELECT AVG("totalListenTime") as avg
          FROM "UserTrackStats"
          WHERE "youtubeId" = ${youtubeId}
        `
      ]);

      if (trackStats.length === 0) {
        return {
          playCount: 0,
          skipCount: 0,
          globalScore: 0,
          averageListenTime: 0
        };
      }

      return {
        playCount: trackStats[0].playCount,
        skipCount: trackStats[0].skipCount,
        globalScore: trackStats[0].globalScore,
        averageListenTime: avgListenTime[0]?.avg || 0
      };
    } catch (error) {
      console.error('Error getting track stats:', error);
      return {
        playCount: 0,
        skipCount: 0,
        globalScore: 0,
        averageListenTime: 0
      };
    }
  }

  // Get user's favorite tracks based on personal scores
  async getUserFavoriteTracks(userId: string): Promise<Array<{ youtubeId: string; personalScore: number }>> {
    try {
      return await prisma.$queryRaw<Array<{ youtubeId: string; personalScore: number }>>`
        SELECT "youtubeId", "personalScore"
        FROM "UserTrackStats"
        WHERE "userId" = ${userId}
          AND "personalScore" > 0
        ORDER BY "personalScore" DESC
        LIMIT 10
      `;
    } catch (error) {
      console.error('Error getting user favorite tracks:', error);
      return [];
    }
  }

  // Get global top tracks based on global scores
  async getGlobalTopTracks(): Promise<Array<Track>> {
    try {
      return await prisma.$queryRaw<Array<Track>>`
        SELECT *
        FROM "Track"
        WHERE "globalScore" > 0
        ORDER BY "globalScore" DESC
        LIMIT 10
      `;
    } catch (error) {
      console.error('Error getting global top tracks:', error);
      return [];
    }
  }
} 