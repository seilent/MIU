import { prisma } from '../prisma.js';
import { TrackStatus } from '../types/enums.js';
import logger from './logger.js';

/**
 * Centralized track database operations
 */

export interface TrackCreateData {
  youtubeId: string;
  title: string;
  duration: number;
  channelId?: string;
  channelTitle?: string;
  isMusicUrl?: boolean;
  resolvedYtId?: string;
}

export interface ChannelCreateData {
  id: string;
  title: string;
  isBlocked?: boolean;
  blockedReason?: string;
}

/**
 * Upsert track with standardized error handling
 */
export async function upsertTrack(data: TrackCreateData) {
  try {
    return await prisma.track.upsert({
      where: { youtubeId: data.youtubeId },
      create: {
        youtubeId: data.youtubeId,
        title: data.title,
        duration: data.duration,
        channelId: data.channelId || null,
        isMusicUrl: data.isMusicUrl || false,
        resolvedYtId: data.resolvedYtId || null,
        globalScore: 0,
        playCount: 0,
        skipCount: 0,
        status: TrackStatus.STANDBY
      },
      update: {
        title: data.title,
        duration: data.duration,
        channelId: data.channelId || undefined,
        isMusicUrl: data.isMusicUrl || undefined,
        resolvedYtId: data.resolvedYtId || undefined,
        updatedAt: new Date()
      }
    });
  } catch (error) {
    logger.error(`Failed to upsert track ${data.youtubeId}:`, error);
    throw error;
  }
}

/**
 * Update track status with error handling
 */
export async function updateTrackStatus(youtubeId: string, status: TrackStatus) {
  try {
    return await prisma.track.update({
      where: { youtubeId },
      data: { 
        status,
        updatedAt: new Date()
      }
    });
  } catch (error) {
    logger.error(`Failed to update track ${youtubeId} status to ${status}:`, error);
    throw error;
  }
}

/**
 * Upsert channel with standardized error handling
 */
export async function upsertChannel(data: ChannelCreateData) {
  try {
    return await prisma.channel.upsert({
      where: { id: data.id },
      create: {
        id: data.id,
        title: data.title,
        isBlocked: data.isBlocked || false,
        blockedReason: data.blockedReason || null
      },
      update: {
        title: data.title,
        updatedAt: new Date()
      }
    });
  } catch (error) {
    logger.error(`Failed to upsert channel ${data.id}:`, error);
    throw error;
  }
}

/**
 * Get track with channel info
 */
export async function getTrackWithChannel(youtubeId: string) {
  try {
    return await prisma.track.findUnique({
      where: { youtubeId },
      include: { channel: true }
    });
  } catch (error) {
    logger.error(`Failed to get track ${youtubeId} with channel:`, error);
    return null;
  }
}

/**
 * Update track play statistics
 */
export async function updateTrackStats(youtubeId: string, played: boolean = true) {
  try {
    return await prisma.track.update({
      where: { youtubeId },
      data: {
        playCount: played ? { increment: 1 } : undefined,
        skipCount: !played ? { increment: 1 } : undefined,
        globalScore: played ? { increment: 0.1 } : { increment: -0.2 },
        lastPlayed: played ? new Date() : undefined,
        updatedAt: new Date()
      }
    });
  } catch (error) {
    logger.error(`Failed to update track ${youtubeId} stats:`, error);
    throw error;
  }
}