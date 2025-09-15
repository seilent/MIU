import { prisma } from '../db.js';
import { TrackStatus } from '../types/enums.js';
import { TrackingService } from '../tracking/service.js';
import { cleanupBlockedSong } from '../routes/music.js';
import { getTrackWithChannel, updateTrackStats } from './trackHelpers.js';
import { blockChannelById } from './channelBlocking.js';
import { getYoutubeInfo } from './youtube.js';
import logger from './logger.js';

/**
 * Centralized ban management system
 * Handles all ban-related operations including track banning, channel blocking, and penalty application
 */

export interface BanResult {
  success: boolean;
  message: string;
  details?: {
    tracksBlocked?: number;
    channelBlocked?: boolean;
    channelTitle?: string;
    seedRecommendationsBlocked?: number;
  };
}

export interface BanOptions {
  reason?: string;
  blockChannel?: boolean;
  blockSeedRecommendations?: boolean;
  banPenalty?: number; // Default -10
  userPenalty?: number; // Default -5
}

/**
 * Apply ban penalty to a track (affects global and user scores)
 */
export async function applyBanPenalty(
  youtubeId: string,
  trackingService?: TrackingService,
  banPenalty: number = -10,
  userPenalty: number = -5
): Promise<void> {
  try {
    logger.info(`Applying ban penalty to track: ${youtubeId}`);

    await prisma.$transaction([
      // Update track status to BLOCKED and apply penalty
      prisma.track.update({
        where: { youtubeId },
        data: {
          status: TrackStatus.BLOCKED,
          globalScore: {
            increment: banPenalty // Negative value decreases score
          }
        }
      }),
      // Apply penalty to all user stats for this track
      prisma.$executeRaw`
        UPDATE "UserTrackStats"
        SET "personalScore" = "UserTrackStats"."personalScore" + ${userPenalty}
        WHERE "youtubeId" = ${youtubeId}
      `
    ]);

    // Clean up blocked song from playlists and recommendations
    await cleanupBlockedSong(youtubeId);

    // Update tracking service if provided
    if (trackingService) {
      // Note: TrackingService may not have recordTrackBan method, skip for now
      // await trackingService.recordTrackBan(youtubeId);
    }

    logger.info(`Successfully applied ban penalty to track: ${youtubeId}`);
  } catch (error) {
    logger.error(`Error applying ban penalty to track ${youtubeId}:`, error);
    throw error;
  }
}

/**
 * Ban a single track by YouTube ID
 */
export async function banTrack(
  youtubeId: string,
  options: BanOptions = {},
  trackingService?: TrackingService
): Promise<BanResult> {
  try {
    const {
      reason = 'Manual ban',
      blockChannel = false,
      blockSeedRecommendations = false,
      banPenalty = -10,
      userPenalty = -5
    } = options;

    logger.info(`Banning track: ${youtubeId}, options:`, options);

    // Get track info first
    const track = await getTrackWithChannel(youtubeId);
    if (!track) {
      return {
        success: false,
        message: `Track not found: ${youtubeId}`
      };
    }

    const result: BanResult = {
      success: true,
      message: `Banned track: ${track.title}`,
      details: {
        tracksBlocked: 1,
        channelBlocked: false
      }
    };

    // Apply ban penalty to the track
    await applyBanPenalty(youtubeId, trackingService, banPenalty, userPenalty);

    // Block channel if requested and channel exists
    if (blockChannel && track.channelId) {
      try {
        const channelResult = await blockChannelById(track.channelId, `Banned along with track: ${reason}`);
        result.details!.channelBlocked = true;
        result.details!.channelTitle = channelResult.channelTitle;
        result.details!.tracksBlocked = channelResult.tracksBlocked;
        result.message += `\nBlocked channel "${channelResult.channelTitle}" with ${channelResult.tracksBlocked} tracks.`;
      } catch (error) {
        logger.error(`Error blocking channel ${track.channelId}:`, error);
        result.message += `\nFailed to block channel: ${error instanceof Error ? error.message : 'Unknown error'}`;
      }
    }

    // Block seed recommendations if requested
    if (blockSeedRecommendations) {
      try {
        const seedResult = await blockSeedRecommendationsFunc(youtubeId);
        if (seedResult.count > 0) {
          result.details!.seedRecommendationsBlocked = seedResult.count;
          result.message += `\nBlocked ${seedResult.count} recommendations seeded from "${seedResult.seedTrack}".`;
        }
      } catch (error) {
        logger.error(`Error blocking seed recommendations for ${youtubeId}:`, error);
        result.message += `\nFailed to block seed recommendations: ${error instanceof Error ? error.message : 'Unknown error'}`;
      }
    }

    logger.info(`Successfully banned track: ${youtubeId}`);
    return result;

  } catch (error) {
    logger.error(`Error banning track ${youtubeId}:`, error);
    return {
      success: false,
      message: `Failed to ban track: ${error instanceof Error ? error.message : 'Unknown error'}`
    };
  }
}

/**
 * Block all tracks that were seeded from a specific track in recommendations
 */
export async function blockSeedRecommendationsFunc(youtubeId: string): Promise<{ count: number; seedTrack: string | null }> {
  try {
    // Get all tracks from YoutubeRecommendation with this seedTrackId
    const recommendations = await prisma.youtubeRecommendation.findMany({
      where: {
        seedTrackId: youtubeId
      },
      select: {
        youtubeId: true
      }
    });

    if (recommendations.length === 0) {
      return { count: 0, seedTrack: null };
    }

    // Get seed track info
    const seedTrack = await prisma.track.findUnique({
      where: { youtubeId },
      select: { title: true }
    });

    // Get all youtubeIds from recommendations
    const youtubeIds = recommendations.map(rec => rec.youtubeId);

    // Update all tracks to BLOCKED status and apply ban penalty
    await prisma.$transaction([
      // Update tracks to BLOCKED status
      prisma.track.updateMany({
        where: {
          youtubeId: {
            in: youtubeIds
          }
        },
        data: {
          status: TrackStatus.BLOCKED,
          globalScore: {
            decrement: 10 // Apply the same penalty as regular bans
          }
        }
      }),
      // Apply penalty to user stats
      prisma.$executeRaw`
        UPDATE "UserTrackStats"
        SET "personalScore" = "UserTrackStats"."personalScore" - 5
        WHERE "youtubeId" = ANY(${youtubeIds})
      `
    ]);

    // Clean up blocked songs from playlists and recommendations
    for (const id of youtubeIds) {
      await cleanupBlockedSong(id);
    }

    return { 
      count: youtubeIds.length, 
      seedTrack: seedTrack?.title || 'Unknown Track'
    };
  } catch (error) {
    logger.error('Error blocking seed recommendations:', error);
    throw error;
  }
}

/**
 * Check if a track is banned/blocked
 */
export async function isTrackBanned(youtubeId: string): Promise<boolean> {
  try {
    const track = await prisma.track.findUnique({
      where: { youtubeId },
      select: { status: true }
    });

    return track?.status === TrackStatus.BLOCKED;
  } catch (error) {
    logger.error(`Error checking if track ${youtubeId} is banned:`, error);
    return false;
  }
}

/**
 * Check if a channel is blocked
 */
export async function isChannelBlocked(channelId?: string | null, channelTitle?: string): Promise<boolean> {
  if (!channelId && !channelTitle) return false;

  try {
    // First try by ID
    if (channelId) {
      const byId = await prisma.channel.findUnique({
        where: { id: channelId },
        select: { isBlocked: true }
      });
      
      if (byId?.isBlocked) return true;
    }

    // Then try by title if available
    if (channelTitle) {
      const byTitle = await prisma.channel.findFirst({
        where: { 
          title: channelTitle,
          isBlocked: true
        },
        select: { isBlocked: true }
      });
      
      if (byTitle?.isBlocked) return true;
    }

    return false;
  } catch (error) {
    logger.error('Error checking channel blocked status:', error);
    return false;
  }
}

/**
 * Get channel info from a video (database first, then API)
 */
export async function getChannelInfoFromVideo(youtubeId: string): Promise<{ channelId: string; channelTitle: string } | null> {
  // 1. First try to get channel info from our database
  const track = await prisma.track.findUnique({
    where: { youtubeId },
    select: { 
      channelId: true,
      channel: {
        select: {
          title: true
        }
      }
    }
  });

  if (track?.channelId && track.channel) {
    return {
      channelId: track.channelId,
      channelTitle: track.channel.title
    };
  }

  // 2. Fall back to getYoutubeInfo() (which has its own yt-dlp fallback)
  try {
    const trackInfo = await getYoutubeInfo(youtubeId);
    if (trackInfo?.channelId && trackInfo.channelTitle) {
      return {
        channelId: trackInfo.channelId,
        channelTitle: trackInfo.channelTitle
      };
    }
  } catch (error) {
    logger.error('Error getting channel info:', error);
  }

  return null;
}

/**
 * Auto-ban instrumental tracks (used by player)
 */
export async function autoBanInstrumental(youtubeId: string, title: string): Promise<void> {
  try {
    logger.info(`Auto-banning instrumental track: ${title}`);
    
    // Apply ban penalty
    await prisma.$transaction([
      prisma.track.update({
        where: { youtubeId },
        data: {
          status: TrackStatus.BLOCKED,
          globalScore: {
            decrement: 10
          }
        }
      }),
      prisma.$executeRaw`
        UPDATE "UserTrackStats"
        SET "personalScore" = "UserTrackStats"."personalScore" - 5
        WHERE "youtubeId" = ${youtubeId}
      `
    ]);

    // Clean up from playlists
    await cleanupBlockedSong(youtubeId);

    logger.info(`Successfully auto-banned instrumental track: ${title}`);
  } catch (error) {
    logger.error(`Error auto-banning instrumental track ${youtubeId}:`, error);
    throw error;
  }
}

/**
 * Get all banned tracks
 */
export async function getBannedTracks(limit: number = 50, offset: number = 0) {
  try {
    return await prisma.track.findMany({
      where: { status: TrackStatus.BLOCKED },
      select: {
        youtubeId: true,
        title: true,
        channelId: true,
        globalScore: true,
        updatedAt: true,
        channel: {
          select: {
            title: true
          }
        }
      },
      orderBy: { updatedAt: 'desc' },
      take: limit,
      skip: offset
    });
  } catch (error) {
    logger.error('Error getting banned tracks:', error);
    throw error;
  }
}

/**
 * Unban a track (restore it to STANDBY status)
 */
export async function unbanTrack(youtubeId: string): Promise<BanResult> {
  try {
    const track = await prisma.track.findUnique({
      where: { youtubeId },
      select: { title: true, status: true }
    });

    if (!track) {
      return {
        success: false,
        message: 'Track not found'
      };
    }

    if (track.status !== TrackStatus.BLOCKED) {
      return {
        success: false,
        message: 'Track is not banned'
      };
    }

    await prisma.track.update({
      where: { youtubeId },
      data: {
        status: TrackStatus.STANDBY,
        // Optionally restore some score
        globalScore: {
          increment: 5
        }
      }
    });

    logger.info(`Successfully unbanned track: ${youtubeId}`);
    return {
      success: true,
      message: `Unbanned track: ${track.title}`
    };

  } catch (error) {
    logger.error(`Error unbanning track ${youtubeId}:`, error);
    return {
      success: false,
      message: `Failed to unban track: ${error instanceof Error ? error.message : 'Unknown error'}`
    };
  }
}