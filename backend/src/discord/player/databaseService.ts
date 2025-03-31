import { PrismaClient, Prisma, RequestStatus as PrismaRequestStatus, TrackStatus as PrismaTrackStatus, PlaylistMode as PrismaPlaylistMode } from '@prisma/client';
import { prisma } from '../../db.js'; // Use the global prisma instance
import {
  Track,
  UserInfo,
  Request,
  AudioCacheInfo,
  ThumbnailCacheInfo,
  PlaylistWithTracks,
  YoutubeRecommendationInfo,
  TrackStats, // Keep TrackStats for other methods that use it
  UserTrackStatsInfo,
  ChannelInfo,
  FetchedYoutubeInfo,
} from './types.js';
import { RequestStatus, TrackStatus, PlaylistMode } from '../../types/enums.js';
import { getThumbnailUrl } from '../../utils/youtubeMusic.js'; // For thumbnail generation

// Helper to convert our enum to Prisma's enum
function toPrismaRequestStatus(status: RequestStatus): PrismaRequestStatus {
  return status as PrismaRequestStatus;
}

function toAppRequestStatus(status: PrismaRequestStatus): RequestStatus {
  return status as RequestStatus;
}

function toPrismaTrackStatus(status: TrackStatus): PrismaTrackStatus {
  return status as PrismaTrackStatus;
}

function toAppTrackStatus(status: PrismaTrackStatus): TrackStatus {
  return status as TrackStatus;
}

function toPrismaPlaylistMode(mode: PlaylistMode): PrismaPlaylistMode {
    return mode as PrismaPlaylistMode;
}

function toAppPlaylistMode(mode: PrismaPlaylistMode): PlaylistMode {
    return mode as PlaylistMode;
}


export class DatabaseService {
  private db: PrismaClient;

  constructor() {
    this.db = prisma;
  }

  // --- User Operations ---

  async ensureUserExists(userInfo: UserInfo): Promise<void> {
    try {
      await this.db.user.upsert({
        where: { id: userInfo.id },
        create: {
          id: userInfo.id,
          username: userInfo.username,
          discriminator: userInfo.discriminator,
          avatar: userInfo.avatar,
        },
        update: {
          username: userInfo.username,
          discriminator: userInfo.discriminator,
          avatar: userInfo.avatar,
          updatedAt: new Date(),
        },
      });
    } catch (error) {
      console.error(`Failed to ensure user ${userInfo.id} exists:`, error);
      throw error;
    }
  }

  async getUser(userId: string): Promise<UserInfo | null> {
    const user = await this.db.user.findUnique({ where: { id: userId } });
    if (!user) return null;
    return {
      id: user.id,
      username: user.username,
      discriminator: user.discriminator,
      avatar: user.avatar,
    };
  }

  // --- Track Operations ---

  async getTrack(youtubeId: string): Promise<Track | null> {
    const track = await this.db.track.findUnique({
      where: { youtubeId },
    });
    if (!track) return null;
    return {
      youtubeId: track.youtubeId,
      title: track.title,
      duration: track.duration,
      channelId: track.channelId,
      isMusicUrl: track.isMusicUrl,
      resolvedYtId: track.resolvedYtId,
      isActive: track.isActive,
      status: toAppTrackStatus(track.status),
    };
  }

    async getTrackWithChannel(youtubeId: string): Promise<(TrackStats & { channel: ChannelInfo | null }) | null> {
        const track = await this.db.track.findUnique({
            where: { youtubeId },
            include: { channel: true }
        });
        if (!track) return null;
        return {
            youtubeId: track.youtubeId,
            title: track.title,
            duration: track.duration,
            globalScore: track.globalScore,
            playCount: track.playCount,
            skipCount: track.skipCount,
            isActive: track.isActive,
            status: toAppTrackStatus(track.status),
            lastPlayed: track.lastPlayed,
            channel: track.channel ? {
                id: track.channel.id,
                title: track.channel.title,
                isBlocked: track.channel.isBlocked,
            } : null,
        };
    }

  async upsertTrack(trackData: Track): Promise<Track> {
    try {
      const track = await this.db.track.upsert({
        where: { youtubeId: trackData.youtubeId },
        create: {
          youtubeId: trackData.youtubeId,
          channelId: trackData.channelId,
          title: trackData.title,
          duration: trackData.duration,
          isMusicUrl: trackData.isMusicUrl ?? false,
          resolvedYtId: trackData.resolvedYtId,
          isActive: trackData.isActive ?? true,
          status: trackData.status ? toPrismaTrackStatus(trackData.status) : PrismaTrackStatus.STANDBY,
          lastPlayed: new Date(),
        },
        update: {
          channelId: trackData.channelId,
          title: trackData.title,
          duration: trackData.duration,
          isMusicUrl: trackData.isMusicUrl,
          resolvedYtId: trackData.resolvedYtId,
          isActive: trackData.isActive,
          status: trackData.status ? toPrismaTrackStatus(trackData.status) : undefined,
          lastPlayed: new Date(),
          updatedAt: new Date(),
        },
      });

      return {
        youtubeId: track.youtubeId,
        channelId: track.channelId,
        title: track.title,
        duration: track.duration,
        isMusicUrl: track.isMusicUrl,
        resolvedYtId: track.resolvedYtId,
        isActive: track.isActive,
        status: toAppTrackStatus(track.status),
      };
    } catch (error) {
      console.error(`Failed to upsert track ${trackData.youtubeId}:`, error);
      throw error;
    }
  }

    async updateTrackStatus(youtubeId: string, status: TrackStatus, lastPlayed?: Date): Promise<void> {
        try {
            const data: Prisma.TrackUpdateInput = {
                status: toPrismaTrackStatus(status),
                updatedAt: new Date(),
            };
            if (lastPlayed !== undefined) {
                data.lastPlayed = lastPlayed;
            }
            if (status === TrackStatus.PLAYING && lastPlayed === undefined) {
                data.lastPlayed = new Date();
            }

            await this.db.track.update({
                where: { youtubeId },
                data,
            });
        } catch (error) {
            console.error(`Failed to update status for track ${youtubeId} to ${status}:`, error);
        }
    }

    async incrementTrackPlayCount(youtubeId: string): Promise<void> {
        try {
            await this.db.track.update({
                where: { youtubeId },
                data: {
                    playCount: { increment: 1 },
                    lastPlayed: new Date(),
                },
            });
        } catch (error) {
            console.error(`Failed to increment play count for track ${youtubeId}:`, error);
        }
    }

    async incrementTrackSkipCount(youtubeId: string): Promise<void> {
        try {
            await this.db.track.update({
                where: { youtubeId },
                data: { skipCount: { increment: 1 } },
            });
        } catch (error) {
            console.error(`Failed to increment skip count for track ${youtubeId}:`, error);
        }
    }

    async getPopularTracks(limit: number): Promise<TrackStats[]> {
        const tracks = await this.db.track.findMany({
            where: {
                globalScore: { gt: 0 },
                status: { not: PrismaTrackStatus.BLOCKED }
            },
            orderBy: { globalScore: 'desc' },
            take: limit,
        });
        return tracks.map(track => ({
            youtubeId: track.youtubeId,
            title: track.title,
            duration: track.duration,
            globalScore: track.globalScore,
            playCount: track.playCount,
            skipCount: track.skipCount,
            isActive: track.isActive,
            lastPlayed: track.lastPlayed,
            status: toAppTrackStatus(track.status),
        }));
    }

    async getRandomTracks(limit: number): Promise<TrackStats[]> {
        const tracks = await this.db.track.findMany({
             where: {
                status: { not: PrismaTrackStatus.BLOCKED }
            },
            orderBy: { createdAt: 'desc' },
            take: limit * 5,
        });
        const shuffled = tracks.sort(() => 0.5 - Math.random());
        return shuffled.slice(0, limit).map(track => ({
             youtubeId: track.youtubeId,
            title: track.title,
            duration: track.duration,
            globalScore: track.globalScore,
            playCount: track.playCount,
            skipCount: track.skipCount,
            isActive: track.isActive,
            lastPlayed: track.lastPlayed,
            status: toAppTrackStatus(track.status),
        }));
    }

    async findTracksByStatus(status: TrackStatus): Promise<TrackStats[]> {
        const tracks = await this.db.track.findMany({
            where: { status: toPrismaTrackStatus(status) },
        });
        return tracks.map(track => ({
             youtubeId: track.youtubeId,
            title: track.title,
            duration: track.duration,
            globalScore: track.globalScore,
            playCount: track.playCount,
            skipCount: track.skipCount,
            isActive: track.isActive,
            lastPlayed: track.lastPlayed,
            status: toAppTrackStatus(track.status),
        }));
    }

    async getBlockedTrackIds(): Promise<Set<string>> {
        const blockedTracks = await this.db.track.findMany({
            where: { status: PrismaTrackStatus.BLOCKED },
            select: { youtubeId: true }
        });
        return new Set(blockedTracks.map(t => t.youtubeId));
    }

  // --- Channel Operations ---

  async upsertChannel(channelId: string, channelTitle: string): Promise<void> {
    try {
      await this.db.channel.upsert({
        where: { id: channelId },
        create: { id: channelId, title: channelTitle },
        update: { title: channelTitle },
      });
    } catch (error) {
      console.error(`Failed to upsert channel ${channelId}:`, error);
    }
  }

    async getChannel(channelId: string): Promise<ChannelInfo | null> {
        const channel = await this.db.channel.findUnique({
            where: { id: channelId },
        });
        return channel ? {
            id: channel.id,
            title: channel.title,
            isBlocked: channel.isBlocked,
        } : null;
    }

    async getBlockedChannelIds(): Promise<Set<string>> {
        const blockedChannels = await this.db.channel.findMany({
            where: { isBlocked: true },
            select: { id: true }
        });
        return new Set(blockedChannels.map(c => c.id));
    }

  // --- Request Operations ---

  async createRequest(requestData: Request): Promise<void> {
    try {
      await this.db.request.create({
        data: {
          youtubeId: requestData.youtubeId,
          userId: requestData.userId,
          requestedAt: requestData.requestedAt,
          isAutoplay: requestData.isAutoplay,
          status: toPrismaRequestStatus(requestData.status),
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        console.warn(`Request already exists for ${requestData.youtubeId} at ${requestData.requestedAt}. Ignoring.`);
      } else {
        console.error(`Failed to create request for track ${requestData.youtubeId}:`, error);
        throw error;
      }
    }
  }

  async updateRequestStatus(
    youtubeId: string,
    requestedAt: Date,
    status: RequestStatus,
    playedAt?: Date | null
  ): Promise<void> {
    try {
      const data: Prisma.RequestUpdateInput = {
        status: toPrismaRequestStatus(status),
      };
      if (playedAt !== undefined) {
        data.playedAt = playedAt;
      }
      await this.db.request.updateMany({
        where: { youtubeId, requestedAt },
        data,
      });
    } catch (error) {
      console.error(`Failed to update request status for track ${youtubeId} at ${requestedAt}:`, error);
    }
  }

    async updateRequestsStatusByTrack(youtubeId: string, currentStatus: RequestStatus, newStatus: RequestStatus): Promise<void> {
        try {
            await this.db.request.updateMany({
                where: {
                    youtubeId: youtubeId,
                    status: toPrismaRequestStatus(currentStatus),
                },
                data: {
                    status: toPrismaRequestStatus(newStatus),
                },
            });
        } catch (error) {
            console.error(`Failed to update requests status for track ${youtubeId} from ${currentStatus} to ${newStatus}:`, error);
        }
    }

    async cleanupStuckRequests(): Promise<void> {
        try {
            const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
            const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);

            const playingPendingExpired = await this.db.request.updateMany({
                where: {
                    status: { in: [PrismaRequestStatus.PLAYING, PrismaRequestStatus.PENDING] },
                },
                data: { status: PrismaRequestStatus.EXPIRED },
            });

            const queuedExpired = await this.db.request.updateMany({
                where: {
                    status: PrismaRequestStatus.QUEUED,
                    requestedAt: { lt: tenMinutesAgo },
                },
                data: { status: PrismaRequestStatus.EXPIRED },
            });

            const completedExpired = await this.db.request.updateMany({
                where: {
                    status: PrismaRequestStatus.COMPLETED,
                    playedAt: { gte: fiveHoursAgo },
                },
                data: {
                    status: PrismaRequestStatus.EXPIRED,
                    playedAt: new Date(0),
                },
            });

            console.log(`✨ Cleaned up stuck requests: ${playingPendingExpired.count} (Playing/Pending), ${queuedExpired.count} (Queued), ${completedExpired.count} (Completed)`);

        } catch (error) {
            console.error('Error cleaning up stuck request states:', error);
        }
    }

  // --- Cache Operations ---

  async getAudioCache(youtubeId: string): Promise<AudioCacheInfo | null> {
    return this.db.audioCache.findUnique({ where: { youtubeId } });
  }

  async upsertAudioCache(youtubeId: string, filePath: string): Promise<void> {
    try {
      await this.db.audioCache.upsert({
        where: { youtubeId },
        create: { youtubeId, filePath },
        update: { filePath, updatedAt: new Date() },
      });
    } catch (error) {
      console.error(`Failed to upsert audio cache for ${youtubeId}:`, error);
      throw error;
    }
  }

  // Added getThumbnailCache method
  async getThumbnailCache(youtubeId: string): Promise<ThumbnailCacheInfo | null> {
    const cache = await this.db.thumbnailCache.findUnique({ where: { youtubeId } });
    // Return the relevant fields matching the ThumbnailCacheInfo interface
    return cache ? { youtubeId: cache.youtubeId, filePath: cache.filePath } : null;
  }

  async upsertThumbnailCache(youtubeId: string, filePath: string): Promise<void> {
    try {
      await this.db.thumbnailCache.upsert({
        where: { youtubeId },
        create: { youtubeId, filePath }, // Assuming default width/height is handled by Prisma schema or okay as 0
        update: { filePath, updatedAt: new Date() },
      });
    } catch (error) {
      console.error(`Failed to upsert thumbnail cache for ${youtubeId}:`, error);
      throw error;
    }
  }

  // --- Playlist Operations ---

    async getActivePlaylist(): Promise<PlaylistWithTracks | null> {
        const activePlaylist = await this.db.defaultPlaylist.findFirst({
            where: { active: true },
            include: {
                tracks: {
                    orderBy: { position: 'asc' },
                    include: {
                        track: true,
                    },
                },
            },
        });

        if (!activePlaylist) return null;

        return {
            ...activePlaylist,
            mode: toAppPlaylistMode(activePlaylist.mode),
            tracks: activePlaylist.tracks.map(pt => ({
                trackId: pt.trackId,
                position: pt.position,
                track: {
                    youtubeId: pt.track.youtubeId,
                    title: pt.track.title,
                    duration: pt.track.duration,
                    channelId: pt.track.channelId,
                    isMusicUrl: pt.track.isMusicUrl,
                    resolvedYtId: pt.track.resolvedYtId,
                    isActive: pt.track.isActive,
                    status: toAppTrackStatus(pt.track.status),
                    thumbnail: getThumbnailUrl(pt.track.youtubeId),
                },
            })),
        };
    }

    async getPlaylistTracks(playlistId: string): Promise<Track[]> {
        const playlistTracks = await this.db.defaultPlaylistTrack.findMany({
            where: { playlistId },
            include: { track: true },
            orderBy: { position: 'asc' },
        });

        return playlistTracks.map(pt => ({
            youtubeId: pt.track.youtubeId,
            title: pt.track.title,
            duration: pt.track.duration,
            channelId: pt.track.channelId,
            isMusicUrl: pt.track.isMusicUrl,
            resolvedYtId: pt.track.resolvedYtId,
            isActive: pt.track.isActive,
            status: toAppTrackStatus(pt.track.status),
            thumbnail: getThumbnailUrl(pt.track.youtubeId),
        }));
    }

  // --- Recommendation Operations ---

  async getRecommendations(excludeIds: string[], limit: number): Promise<YoutubeRecommendationInfo[]> {
    return this.db.youtubeRecommendation.findMany({
      where: {
        youtubeId: { notIn: excludeIds },
      },
      take: limit,
    });
  }

  async addRecommendations(recommendations: YoutubeRecommendationInfo[]): Promise<void> {
    if (recommendations.length === 0) return;
    try {
      const created = await this.db.youtubeRecommendation.createMany({
        data: recommendations.map(rec => ({
          youtubeId: rec.youtubeId,
          title: rec.title,
          seedTrackId: rec.seedTrackId,
          relevanceScore: rec.relevanceScore ?? 0,
          wasPlayed: false,
        })),
        skipDuplicates: true,
      });
      console.log(`[DB] Added ${created.count} new recommendations.`);
    } catch (error) {
      console.error('Failed to add recommendations:', error);
    }
  }

    async clearPlayedRecommendations(): Promise<void> {
        try {
            // Only remove recommendations for blocked tracks
            const blockedTracks = await this.db.track.findMany({
                where: { status: 'BLOCKED' },
                select: { youtubeId: true }
            });

            const deleted = await this.db.youtubeRecommendation.deleteMany({
                where: {
                    youtubeId: {
                        in: blockedTracks.map(t => t.youtubeId)
                    }
                }
            });
            
            console.log(`[DB] Cleared ${deleted.count} recommendations for blocked tracks.`);
        } catch (error) {
            console.error('Failed to clear recommendations:', error);
        }
    }

    async getRecommendationCount(): Promise<number> {
        return this.db.youtubeRecommendation.count();
    }

    async findRecommendation(youtubeId: string): Promise<YoutubeRecommendationInfo | null> {
        return this.db.youtubeRecommendation.findUnique({ where: { youtubeId }});
    }

    async removeRecommendation(youtubeId: string): Promise<void> {
        try {
            await this.db.youtubeRecommendation.delete({ where: { youtubeId }});
        } catch (error) {
             if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025')) {
                console.error(`Failed to remove recommendation ${youtubeId}:`, error);
            }
        }
    }

  // --- Stats Operations ---

    async getUserFavoriteTracks(limit: number): Promise<(TrackStats & { personalScore: number })[]> {
        const stats = await this.db.userTrackStats.findMany({
            where: { personalScore: { gt: 0 } },
            include: { track: true },
            orderBy: { personalScore: 'desc' },
            take: limit,
        });

        return stats.map(stat => ({
            youtubeId: stat.track.youtubeId,
            title: stat.track.title,
            duration: stat.track.duration,
            globalScore: stat.track.globalScore,
            playCount: stat.track.playCount,
            skipCount: stat.track.skipCount,
            isActive: stat.track.isActive,
            lastPlayed: stat.track.lastPlayed,
            status: toAppTrackStatus(stat.track.status),
            personalScore: stat.personalScore,
        }));
    }

    async applyBanPenalty(youtubeId: string): Promise<void> {
        try {
            await this.db.$transaction([
                this.db.track.update({
                    where: { youtubeId },
                    data: {
                        globalScore: { decrement: 10 },
                        status: PrismaTrackStatus.BLOCKED,
                    },
                }),
                this.db.userTrackStats.updateMany({
                    where: { youtubeId },
                    data: {
                        personalScore: { decrement: 5 },
                    },
                }),
            ]);
            console.log(`[DB] Applied ban penalty to track ${youtubeId}`);
        } catch (error) {
            console.error(`Failed to apply ban penalty to track ${youtubeId}:`, error);
        }
    }

    async cleanupBlockedSongData(youtubeId: string): Promise<void> {
        try {
            await this.db.$transaction([
                this.db.defaultPlaylistTrack.deleteMany({
                    where: { trackId: youtubeId },
                }),
                this.db.youtubeRecommendation.deleteMany({
                    where: { youtubeId: youtubeId },
                }),
            ]);
            console.log(`[DB] Cleaned up data associated with blocked track ${youtubeId}`);
        } catch (error) {
            console.error(`Failed to clean up data for blocked track ${youtubeId}:`, error);
        }
    }

}