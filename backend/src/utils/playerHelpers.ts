import { prisma } from '../prisma.js';
import { getDiscordClient } from '../discord/client.js';
import { getPlayer } from '../discord/player.js';
import { RequestStatus } from '../types/enums.js';
import { getThumbnailUrl } from './youtubeMusic.js';

/**
 * Centralized player and track utilities
 */

// Types
interface WebUser {
  id: string;
  username: string;
  discriminator: string;
  avatar: string | null;
}

interface TrackResponse {
  youtubeId: string;
  title: string;
  thumbnail: string;
  duration: number;
  requestedBy: {
    id: string;
    username: string;
    avatar?: string;
  };
  requestedAt: string;
  isAutoplay: boolean;
}

interface RequestWithTrack {
  track: {
    youtubeId: string;
    title: string;
    thumbnail: string;
    duration: number;
    resolvedYtId: string | null;
    isMusicUrl?: boolean;
    createdAt?: Date;
    updatedAt?: Date;
    globalScore?: number;
    playCount?: number;
    skipCount?: number;
    isActive?: boolean;
  };
  user: {
    id: string;
    username: string;
    avatar: string;
  };
  requestedAt: Date;
  playedAt?: Date | null;
  isAutoplay: boolean;
}

interface QueueItem {
  youtubeId: string;
  title: string;
  thumbnail: string;
  duration: number;
  requestedBy: {
    userId: string;
    username: string;
    discriminator?: string;
    avatar?: string;
  };
  requestedAt: Date;
  isAutoplay: boolean;
}

/**
 * Get current playing track from database
 */
export async function getCurrentPlayingTrack() {
  return await prisma.request.findFirst({
    where: { status: RequestStatus.PLAYING },
    include: { track: true }
  });
}

/**
 * Get Discord client with null check
 */
export function getDiscordClientSafe() {
  const client = getDiscordClient();
  return client;
}

/**
 * Get player instance with null check
 */
export function getPlayerSafe() {
  const player = getPlayer();
  return player;
}

/**
 * Format track response for API
 */
export function formatTrack(request: RequestWithTrack): TrackResponse {
  // Always use original youtubeId for consistency
  const youtubeId = request.track.youtubeId;
  
  return {
    youtubeId,
    title: request.track.title,
    thumbnail: getThumbnailUrl(youtubeId),
    duration: request.track.duration,
    requestedBy: {
      id: request.user.id,
      username: request.user.username,
      avatar: request.user.avatar
    },
    requestedAt: request.requestedAt.toISOString(),
    isAutoplay: request.isAutoplay
  };
}

/**
 * Convert QueueItem to RequestWithTrack format
 */
export function queueItemToRequestWithTrack(item: QueueItem): RequestWithTrack {
  return {
    track: {
      youtubeId: item.youtubeId,
      title: item.title,
      thumbnail: getThumbnailUrl(item.youtubeId),
      duration: item.duration,
      resolvedYtId: null,
    },
    user: {
      id: item.requestedBy.userId,
      username: item.requestedBy.username,
      avatar: item.requestedBy.avatar || ''
    },
    requestedAt: item.requestedAt,
    isAutoplay: item.isAutoplay
  };
}

/**
 * Get player status information
 */
export async function getPlayerStatus() {
  const client = getDiscordClientSafe();
  const player = getPlayerSafe();
  
  if (!client || !player) {
    return null;
  }

  const currentTrack = player.getCurrentTrack();
  const queue = player.getQueue();
  
  return {
    status: player.getStatus(),
    currentTrack: currentTrack ? formatTrack(queueItemToRequestWithTrack({
      ...currentTrack,
      requestedBy: {
        userId: currentTrack.requestedBy.userId,
        username: currentTrack.requestedBy.username,
        discriminator: (currentTrack.requestedBy as any).discriminator || '0000',
        avatar: (currentTrack.requestedBy as any).avatar || ''
      }
    })) : null,
    queue: queue.map(track => formatTrack(queueItemToRequestWithTrack({
      ...track,
      requestedBy: {
        userId: track.requestedBy.userId,
        username: track.requestedBy.username,
        discriminator: (track.requestedBy as any).discriminator || '0000',
        avatar: (track.requestedBy as any).avatar || ''
      }
    }))),
    position: player.getPosition()
  };
}