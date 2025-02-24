import { prisma } from '../db.js';
import { User, Track, Prisma, Request, UserTrackStats } from '@prisma/client';

interface ScoredTrack {
  track: Track;
  score: number;
}

interface UserStats {
  userId: string;
  youtubeId: string;
  personalScore: number;
}

export class RecommendationEngine {
  private readonly RECENT_HISTORY_HOURS = 72; // Consider last 72 hours
  private readonly MIN_SCORE = -0.5; // Minimum score to consider a track
  private readonly RECENCY_PENALTY_HOURS = 3; // How recent a song needs to be to get penalized
  private readonly USER_WEIGHT = 0.6; // Weight for user preferences vs global score
  private readonly GLOBAL_WEIGHT = 0.4; // Weight for global score

  async getRecommendationsForUsers(
    userIds: string[],
    count: number = 10
  ): Promise<ScoredTrack[]> {
    try {
      // Get recently played tracks to avoid repeats
      const recentCutoff = new Date(Date.now() - this.RECENT_HISTORY_HOURS * 60 * 60 * 1000);
      const recentRequests = await prisma.request.findMany({
        where: {
          userId: { in: userIds },
          requestedAt: { gt: recentCutoff }
        },
        select: {
          youtubeId: true,
          requestedAt: true
        }
      });

      const recentTrackIds = new Set(recentRequests.map(r => r.youtubeId));

      // Get user preferences
      const userStats = await prisma.$queryRaw<UserStats[]>`
        SELECT "userId", "youtubeId", "personalScore"
        FROM "UserTrackStats"
        WHERE "userId" = ANY(${userIds})
        AND "personalScore" > ${this.MIN_SCORE}
      `;

      // Get all tracks with positive global scores
      const tracks = await prisma.$queryRaw<Track[]>`
        SELECT *
        FROM "Track"
        WHERE "globalScore" > ${this.MIN_SCORE}
        AND "youtubeId" NOT IN (${recentTrackIds.size > 0 ? Array.from(recentTrackIds).map(id => `'${id}'`).join(',') : ['']})
      `;

      // Score tracks based on both user preferences and global scores
      const scoredTracks = tracks.map((track: Track) => {
        let score = (track as any).globalScore * this.GLOBAL_WEIGHT;

        // Add weighted average of user scores
        const trackUserStats = userStats.filter(stat => stat.youtubeId === track.youtubeId);
        if (trackUserStats.length > 0) {
          const avgUserScore = trackUserStats.reduce((sum: number, stat: UserStats) => sum + stat.personalScore, 0) / trackUserStats.length;
          score += avgUserScore * this.USER_WEIGHT;
        }

        // Apply recency penalty if needed
        const recentPlay = recentRequests.find(r => r.youtubeId === track.youtubeId);
        if (recentPlay) {
          const hoursAgo = (Date.now() - recentPlay.requestedAt.getTime()) / (60 * 60 * 1000);
          if (hoursAgo < this.RECENCY_PENALTY_HOURS) {
            score *= (hoursAgo / this.RECENCY_PENALTY_HOURS);
          }
        }

        return {
          track,
          score
        };
      });

      // Sort by score and return top N
      return scoredTracks
        .sort((a: ScoredTrack, b: ScoredTrack) => b.score - a.score)
        .slice(0, count);
    } catch (error) {
      console.error('Error getting recommendations:', error);
      return [];
    }
  }

  // Helper method to get recommendations for a single user
  async getRecommendationsForUser(
    userId: string,
    count: number = 10
  ): Promise<ScoredTrack[]> {
    return this.getRecommendationsForUsers([userId], count);
  }
} 