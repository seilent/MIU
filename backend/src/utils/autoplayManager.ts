import { prisma } from '../db.js';
import { getMusicFilterManager } from './musicFilterManager.js';
import { getYouTubeAPIManager } from './youtubeApiManager.js';
import type { TrackInfo } from './youtube.js';
import logger from './logger.js';

/**
 * Centralized Autoplay Manager
 * Handles autoplay track selection, recommendation pool management,
 * cooldown tracking, and prefetching logic
 */

export interface QueueItem {
  youtubeId: string;
  title: string;
  thumbnail: string;
  duration: number;
  requestedBy: {
    userId: string;
    username: string;
    avatar?: string;
  };
  requestedAt: Date;
  isAutoplay: boolean;
  channelId?: string;
  channelTitle?: string;
  tags?: string[];
  autoplaySource?: 'Pool: Playlist' | 'Pool: History' | 'Pool: Popular' | 'Pool: YouTube Mix' | 'Pool: Random';
}

export interface AutoplayOptions {
  bufferSize?: number;
  maxCooldownHours?: number;
  minRecommendations?: number;
  enablePlaylistMode?: boolean;
}

export interface AutoplayStats {
  queueSize: number;
  poolSize: number;
  cooldownCount: number;
  prefetchNeeded: number;
}

export class AutoplayManager {
  private static readonly DEFAULT_BUFFER_SIZE = 10;
  private static readonly DEFAULT_COOLDOWN_HOURS = 6;
  private static readonly MIN_RECOMMENDATIONS = 5;
  
  private musicFilterManager = getMusicFilterManager();
  private youtubeAPIManager = getYouTubeAPIManager();
  
  private cooldownCache = new Set<string>();
  private lastCooldownRefresh = 0;
  private readonly COOLDOWN_REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes

  /**
   * Get autoplay tracks for the queue
   */
  async getAutoplayTracks(
    count: number,
    currentTrackId?: string,
    queuedTrackIds: string[] = [],
    options: AutoplayOptions = {}
  ): Promise<QueueItem[]> {
    const {
      maxCooldownHours = AutoplayManager.DEFAULT_COOLDOWN_HOURS,
      enablePlaylistMode = false
    } = options;

    try {
      await this.refreshCooldownCacheIfNeeded();

      // Collect IDs to exclude
      const excludeIds = new Set([
        ...queuedTrackIds,
        ...this.cooldownCache,
        ...(currentTrackId ? [currentTrackId] : [])
      ]);

      logger.info(`Getting ${count} autoplay tracks, excluding ${excludeIds.size} tracks`);

      let tracks: QueueItem[] = [];

      // Try playlist mode first if enabled
      if (enablePlaylistMode) {
        tracks = await this.getPlaylistTracks(count, excludeIds);
      }

      // Fill remaining slots with recommendations
      if (tracks.length < count) {
        const recommendationTracks = await this.getRecommendationTracks(
          count - tracks.length,
          excludeIds,
          maxCooldownHours
        );
        tracks.push(...recommendationTracks);
      }

      logger.info(`✓ Selected ${tracks.length} autoplay tracks`);
      return tracks.slice(0, count);

    } catch (error) {
      logger.error('Error getting autoplay tracks:', error);
      return [];
    }
  }

  /**
   * Get tracks from active playlist
   */
  private async getPlaylistTracks(count: number, excludeIds: Set<string>): Promise<QueueItem[]> {
    try {
      const activePlaylist = await prisma.defaultPlaylist.findFirst({
        where: { active: true },
        include: {
          tracks: {
            include: { 
              track: {
                include: {
                  channel: true
                }
              }
            },
            orderBy: [
              { position: 'asc' }
            ]
          }
        }
      });

      if (!activePlaylist || !activePlaylist.tracks.length) {
        logger.info('No active playlist or playlist is empty');
        return [];
      }

      const availableTracks = activePlaylist.tracks
        .filter(pt => !excludeIds.has(pt.track.youtubeId))
        .map(pt => ({
          youtubeId: pt.track.youtubeId,
          title: pt.track.title,
          thumbnail: `https://miu.gacha.boo/api/albumart/${pt.track.youtubeId}`,
          duration: pt.track.duration,
          requestedBy: {
            userId: 'system',
            username: 'Autoplay',
            avatar: undefined
          },
          requestedAt: new Date(),
          isAutoplay: true,
          channelId: pt.track.channelId || undefined,
          channelTitle: pt.track.channel?.title || undefined,
          tags: [], // Tags are not stored in the current schema
          autoplaySource: 'Pool: Playlist' as const
        }));

      const selectedTracks = availableTracks.slice(0, count);
      logger.info(`Selected ${selectedTracks.length} tracks from active playlist`);
      
      return selectedTracks;

    } catch (error) {
      logger.error('Error getting playlist tracks:', error);
      return [];
    }
  }

  /**
   * Get tracks from recommendation pool
   */
  private async getRecommendationTracks(
    count: number,
    excludeIds: Set<string>,
    maxCooldownHours: number
  ): Promise<QueueItem[]> {
    try {
      const cutoffTime = new Date(Date.now() - (maxCooldownHours * 60 * 60 * 1000));

      const recommendations = await prisma.$queryRaw<Array<{
        youtubeId: string;
        title: string;
        duration: number;
        channelId: string | null;
        channelTitle: string | null;
        wasPlayed: boolean;
      }>>`
        SELECT yr."youtubeId", t."title", t."duration", t."channelId", c."title" as "channelTitle", yr."wasPlayed"
        FROM "YoutubeRecommendation" yr
        JOIN "Track" t ON yr."youtubeId" = t."youtubeId"
        LEFT JOIN "Channel" c ON t."channelId" = c."id"
        LEFT JOIN "Request" r ON t."youtubeId" = r."youtubeId" AND r."playedAt" > ${cutoffTime}
        WHERE t."isActive" = true
        AND t."status" != 'BLOCKED'
        AND (c."id" IS NULL OR c."isBlocked" = false)
        AND t."duration" >= 30
        AND t."duration" <= 600
        AND r."youtubeId" IS NULL
        ORDER BY yr."wasPlayed" ASC, RANDOM()
        LIMIT ${count * 3}
      `;

      const availableTracks = recommendations
        .filter(rec => !excludeIds.has(rec.youtubeId))
        .slice(0, count)
        .map(rec => ({
          youtubeId: rec.youtubeId,
          title: rec.title,
          thumbnail: `https://miu.gacha.boo/api/albumart/${rec.youtubeId}`,
          duration: rec.duration,
          requestedBy: {
            userId: 'system',
            username: 'Autoplay',
            avatar: undefined
          },
          requestedAt: new Date(),
          isAutoplay: true,
          channelId: rec.channelId || undefined,
          channelTitle: rec.channelTitle || undefined,
          tags: [], // Tags not available in current schema
          autoplaySource: 'Pool: YouTube Mix' as const
        }));

      logger.info(`Selected ${availableTracks.length} tracks from recommendations`);
      return availableTracks;

    } catch (error) {
      logger.error('Error getting recommendation tracks:', error);
      return [];
    }
  }

  /**
   * Update cooldown cache for recently played tracks
   */
  async updateTrackCooldown(youtubeId: string): Promise<void> {
    try {
      this.cooldownCache.add(youtubeId);
      
      // Note: No database persistence needed for autoplay cooldown tracking
      // The cooldown is handled in-memory and refreshed from actual user requests
      logger.debug(`Updated autoplay cooldown for track: ${youtubeId}`);

    } catch (error) {
      logger.error(`Error updating cooldown for ${youtubeId}:`, error);
    }
  }

  /**
   * Refresh cooldown cache from database
   */
  private async refreshCooldownCacheIfNeeded(): Promise<void> {
    const now = Date.now();
    if (now - this.lastCooldownRefresh < this.COOLDOWN_REFRESH_INTERVAL) {
      return;
    }

    try {
      const cutoffTime = new Date(Date.now() - (AutoplayManager.DEFAULT_COOLDOWN_HOURS * 60 * 60 * 1000));
      
      const recentPlays = await prisma.request.findMany({
        where: {
          playedAt: { gte: cutoffTime },
          isAutoplay: false // Only include manual requests for cooldown
        },
        select: { youtubeId: true },
        distinct: ['youtubeId']
      });

      this.cooldownCache = new Set(recentPlays.map(p => p.youtubeId));
      this.lastCooldownRefresh = now;

      logger.debug(`Refreshed cooldown cache: ${this.cooldownCache.size} tracks on cooldown`);

    } catch (error) {
      logger.error('Error refreshing cooldown cache:', error);
    }
  }

  /**
   * Get autoplay statistics
   */
  async getStats(): Promise<AutoplayStats> {
    try {
      const [poolSize, cooldownCount] = await Promise.all([
        prisma.youtubeRecommendation.count(),
        prisma.request.count({
          where: {
            playedAt: {
              gte: new Date(Date.now() - (AutoplayManager.DEFAULT_COOLDOWN_HOURS * 60 * 60 * 1000)),
              not: null
            }
          }
        })
      ]);

      return {
        queueSize: 0, // Will be provided by caller
        poolSize,
        cooldownCount,
        prefetchNeeded: Math.max(0, AutoplayManager.DEFAULT_BUFFER_SIZE - 0)
      };

    } catch (error) {
      logger.error('Error getting autoplay stats:', error);
      return {
        queueSize: 0,
        poolSize: 0,
        cooldownCount: 0,
        prefetchNeeded: 0
      };
    }
  }

  /**
   * Reset played status for recommendations
   */
  async resetRecommendationsPlayedStatus(): Promise<number> {
    try {
      const result = await prisma.youtubeRecommendation.updateMany({
        where: { wasPlayed: true },
        data: { wasPlayed: false }
      });

      logger.info(`Reset played status for ${result.count} recommendations`);
      return result.count;

    } catch (error) {
      logger.error('Error resetting recommendations played status:', error);
      return 0;
    }
  }

  /**
   * Clean up old play records
   */
  async cleanupOldPlays(maxAge: number = 24 * 60 * 60 * 1000): Promise<number> {
    try {
      const cutoffTime = new Date(Date.now() - maxAge);
      
      const result = await prisma.request.deleteMany({
        where: {
          playedAt: { lt: cutoffTime },
          isAutoplay: true
        }
      });

      if (result.count > 0) {
        logger.info(`Cleaned up ${result.count} old play records`);
      }

      return result.count;

    } catch (error) {
      logger.error('Error cleaning up old plays:', error);
      return 0;
    }
  }
}

/**
 * Singleton instance
 */
let autoplayManagerInstance: AutoplayManager | null = null;

export function getAutoplayManager(): AutoplayManager {
  if (!autoplayManagerInstance) {
    autoplayManagerInstance = new AutoplayManager();
  }
  return autoplayManagerInstance;
}