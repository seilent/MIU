import { prisma } from '../prisma.js';
import { RequestStatus, TrackStatus } from '../types/enums.js';
import logger from './logger.js';

/**
 * Centralized database query utilities
 */

/**
 * Get current playing track from database
 */
export async function getCurrentPlayingTrack() {
  try {
    return await prisma.request.findFirst({
      where: { status: RequestStatus.PLAYING },
      include: { 
        track: true,
        user: true 
      }
    });
  } catch (error) {
    logger.error('Error fetching current playing track:', error);
    return null;
  }
}

/**
 * Get track by YouTube ID
 */
export async function getTrackByYouTubeId(youtubeId: string) {
  try {
    return await prisma.track.findUnique({
      where: { youtubeId },
      include: { channel: true }
    });
  } catch (error) {
    logger.error(`Error fetching track ${youtubeId}:`, error);
    return null;
  }
}

/**
 * Get audio cache by YouTube ID
 */
export async function getAudioCache(youtubeId: string) {
  try {
    return await prisma.audioCache.findUnique({
      where: { youtubeId }
    });
  } catch (error) {
    logger.error(`Error fetching audio cache for ${youtubeId}:`, error);
    return null;
  }
}

/**
 * Update track status to playing
 */
export async function setTrackPlaying(youtubeId: string, userId: string) {
  try {
    // First, set all other tracks to not playing
    await prisma.request.updateMany({
      where: { status: RequestStatus.PLAYING },
      data: { status: RequestStatus.COMPLETED }
    });

    // Set the new track as playing
    return await prisma.request.updateMany({
      where: { 
        track: { youtubeId },
        userId 
      },
      data: { status: RequestStatus.PLAYING }
    });
  } catch (error) {
    logger.error(`Error setting track ${youtubeId} as playing:`, error);
    return null;
  }
}

/**
 * Get user with roles
 */
export async function getUserWithRoles(userId: string) {
  try {
    return await prisma.user.findUnique({
      where: { id: userId },
      include: { roles: true }
    });
  } catch (error) {
    logger.error(`Error fetching user ${userId} with roles:`, error);
    return null;
  }
}

/**
 * Get blocked channels
 */
export async function getBlockedChannels() {
  try {
    return await prisma.channel.findMany({
      where: { isBlocked: true }
    });
  } catch (error) {
    logger.error('Error fetching blocked channels:', error);
    return [];
  }
}

/**
 * Block track by YouTube ID
 */
export async function blockTrackByYouTubeId(youtubeId: string, reason: string = 'No reason provided') {
  try {
    const result = await prisma.$transaction([
      // Update track status to blocked
      prisma.track.updateMany({
        where: { youtubeId },
        data: { status: TrackStatus.BLOCKED }
      }),
      
      // Remove from playlists
      prisma.defaultPlaylistTrack.deleteMany({
        where: { trackId: youtubeId }
      }),
      
      // Remove recommendations
      prisma.youtubeRecommendation.deleteMany({
        where: {
          OR: [
            { seedTrackId: youtubeId },
            { youtubeId: youtubeId }
          ]
        }
      })
    ]);

    logger.info(`Blocked track ${youtubeId}: ${reason}`);
    return result;
  } catch (error) {
    logger.error(`Error blocking track ${youtubeId}:`, error);
    throw error;
  }
}