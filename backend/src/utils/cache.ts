import Redis from 'ioredis';
import logger from './logger.js';
import { prisma } from '../db.js';

interface SettingsObject {
  [key: string]: string;
}

interface CachedSetting {
  key: string;
  value: string;
}

interface TrackStats {
  topTracks: Array<{
    youtubeId: string;
    title: string;
    artist: string | null;
    userId: string;
    _count: {
      youtubeId: number;
    };
  }>;
  totalPlays: number;
}

const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: Number(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD
});

// Default cache expiry time (1 hour)
const DEFAULT_EXPIRY = 60 * 60;

export class Cache {
  static async get<T>(key: string): Promise<T | null> {
    try {
      const data = await redis.get(key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      logger.error('Cache get error:', error);
      return null;
    }
  }

  static async set(key: string, value: any, expiry: number = DEFAULT_EXPIRY): Promise<void> {
    try {
      await redis.setex(key, expiry, JSON.stringify(value));
    } catch (error) {
      logger.error('Cache set error:', error);
    }
  }

  static async del(key: string): Promise<void> {
    try {
      await redis.del(key);
    } catch (error) {
      logger.error('Cache delete error:', error);
    }
  }

  static async getOrSet<T>(
    key: string,
    fetchFn: () => Promise<T>,
    expiry: number = DEFAULT_EXPIRY
  ): Promise<T | null> {
    try {
      const cached = await this.get<T>(key);
      if (cached) {
        return cached;
      }

      const fresh = await fetchFn();
      await this.set(key, fresh, expiry);
      return fresh;
    } catch (error) {
      logger.error('Cache getOrSet error:', error);
      return null;
    }
  }

  static async invalidatePattern(pattern: string): Promise<void> {
    try {
      const keys = await redis.keys(pattern);
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } catch (error) {
      logger.error('Cache invalidate pattern error:', error);
    }
  }

  // Specialized methods for common data types
  static async getUser(userId: string) {
    return this.getOrSet(`user:${userId}`, async () => {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        include: { roles: true }
      });
      return user;
    });
  }

  static async getRoles() {
    return this.getOrSet('roles', async () => {
      const roles = await prisma.role.findMany();
      return roles;
    }, 60 * 5); // Cache for 5 minutes
  }

  static async getSettings() {
    return this.getOrSet<SettingsObject>('settings', async () => {
      const settings = await prisma.setting.findMany();
      return settings.reduce((acc: SettingsObject, setting: CachedSetting) => ({
        ...acc,
        [setting.key]: setting.value
      }), {} as SettingsObject);
    }, 60 * 15); // Cache for 15 minutes
  }

  static async getTrackStats() {
    return this.getOrSet<TrackStats>('track:stats', async () => {
      // First get Request data with Track relations
      const requestWithTracks = await prisma.request.findMany({
        select: {
          youtubeId: true,
          userId: true,
          track: {
            select: {
              title: true,
              channelId: true
            }
          }
        },
        where: {
          status: 'COMPLETED'
        },
        take: 1000 // Limit to recent requests
      });
      
      // Count and group the requests
      const trackCounts: Record<string, {
        youtubeId: string;
        title: string;
        artist: string | null;
        userId: string;
        count: number;
      }> = {};
      
      for (const req of requestWithTracks) {
        const key = `${req.youtubeId}:${req.userId}`;
        if (!trackCounts[key]) {
          trackCounts[key] = {
            youtubeId: req.youtubeId,
            title: req.track.title,
            artist: req.track.channelId,
            userId: req.userId,
            count: 0
          };
        }
        trackCounts[key].count++;
      }
      
      // Convert to array, sort by count, and take top 10
      const topTracks = Object.values(trackCounts)
        .sort((a, b) => b.count - a.count)
        .slice(0, 10)
        .map(item => ({
          youtubeId: item.youtubeId,
          title: item.title,
          artist: item.artist,
          userId: item.userId,
          _count: {
            youtubeId: item.count
          }
        }));
      
      const totalPlays = await prisma.request.count({ 
        where: { status: 'COMPLETED' } 
      });

      return { topTracks, totalPlays };
    }, 60 * 5); // Cache for 5 minutes
  }

  // Cache invalidation methods
  static async invalidateUser(userId: string) {
    await this.del(`user:${userId}`);
  }

  static async invalidateRoles() {
    await this.del('roles');
  }

  static async invalidateSettings() {
    await this.del('settings');
  }

  static async invalidateTrackStats() {
    await this.del('track:stats');
  }
} 