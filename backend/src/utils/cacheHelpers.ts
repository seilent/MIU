import { prisma } from '../prisma.js';
import fs from 'fs';
import path from 'path';
import logger from './logger.js';

/**
 * Centralized cache operations for thumbnails and audio
 */

/**
 * Upsert thumbnail cache with error handling
 */
export async function upsertThumbnailCache(youtubeId: string, filePath: string, width: number = 0, height: number = 0) {
  try {
    return await prisma.thumbnailCache.upsert({
      where: { youtubeId },
      create: {
        youtubeId,
        filePath,
        width,
        height
      },
      update: {
        filePath,
        width,
        height,
        updatedAt: new Date()
      }
    });
  } catch (error) {
    logger.error(`Failed to upsert thumbnail cache for ${youtubeId}:`, error);
    throw error;
  }
}

/**
 * Upsert audio cache with error handling
 */
export async function upsertAudioCache(youtubeId: string, filePath: string) {
  try {
    return await prisma.audioCache.upsert({
      where: { youtubeId },
      create: {
        youtubeId,
        filePath
      },
      update: {
        filePath,
        updatedAt: new Date()
      }
    });
  } catch (error) {
    logger.error(`Failed to upsert audio cache for ${youtubeId}:`, error);
    throw error;
  }
}

/**
 * Get thumbnail cache with existence check
 */
export async function getThumbnailCache(youtubeId: string) {
  try {
    const cache = await prisma.thumbnailCache.findUnique({
      where: { youtubeId }
    });

    // Check if file still exists
    if (cache && !fs.existsSync(cache.filePath)) {
      logger.warn(`Cached thumbnail file missing for ${youtubeId}, removing from cache`);
      await prisma.thumbnailCache.delete({
        where: { youtubeId }
      });
      return null;
    }

    return cache;
  } catch (error) {
    logger.error(`Failed to get thumbnail cache for ${youtubeId}:`, error);
    return null;
  }
}

/**
 * Get audio cache with existence check
 */
export async function getAudioCacheWithCheck(youtubeId: string) {
  try {
    const cache = await prisma.audioCache.findUnique({
      where: { youtubeId }
    });

    // Check if file still exists
    if (cache && !fs.existsSync(cache.filePath)) {
      logger.warn(`Cached audio file missing for ${youtubeId}, removing from cache`);
      await prisma.audioCache.delete({
        where: { youtubeId }
      });
      return null;
    }

    return cache;
  } catch (error) {
    logger.error(`Failed to get audio cache for ${youtubeId}:`, error);
    return null;
  }
}

/**
 * Clean up expired cache entries
 */
export async function cleanupExpiredCache(maxAge: number = 7 * 24 * 60 * 60 * 1000) { // 7 days
  try {
    const cutoffDate = new Date(Date.now() - maxAge);

    // Clean up thumbnail cache
    const expiredThumbnails = await prisma.thumbnailCache.findMany({
      where: {
        createdAt: {
          lt: cutoffDate
        }
      }
    });

    for (const thumbnail of expiredThumbnails) {
      try {
        if (fs.existsSync(thumbnail.filePath)) {
          fs.unlinkSync(thumbnail.filePath);
        }
      } catch (error) {
        logger.warn(`Failed to delete thumbnail file ${thumbnail.filePath}:`, error);
      }
    }

    const thumbnailsDeleted = await prisma.thumbnailCache.deleteMany({
      where: {
        createdAt: {
          lt: cutoffDate
        }
      }
    });

    // Clean up audio cache
    const expiredAudio = await prisma.audioCache.findMany({
      where: {
        createdAt: {
          lt: cutoffDate
        }
      }
    });

    for (const audio of expiredAudio) {
      try {
        if (fs.existsSync(audio.filePath)) {
          fs.unlinkSync(audio.filePath);
        }
      } catch (error) {
        logger.warn(`Failed to delete audio file ${audio.filePath}:`, error);
      }
    }

    const audioDeleted = await prisma.audioCache.deleteMany({
      where: {
        createdAt: {
          lt: cutoffDate
        }
      }
    });

    logger.info(`Cleaned up ${thumbnailsDeleted.count} thumbnail cache entries and ${audioDeleted.count} audio cache entries`);
    return {
      thumbnailsDeleted: thumbnailsDeleted.count,
      audioDeleted: audioDeleted.count
    };
  } catch (error) {
    logger.error('Failed to cleanup expired cache:', error);
    throw error;
  }
}

/**
 * Helper to get file size safely
 */
export function getFileSize(filePath: string): number {
  try {
    const stats = fs.statSync(filePath);
    return stats.size;
  } catch (error) {
    logger.warn(`Could not get file size for ${filePath}:`, error);
    return 0;
  }
}