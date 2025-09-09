import { prisma } from '../prisma.js';
import logger from './logger.js';
import { promisify } from 'util';
import { exec } from 'child_process';
import { cleanupBlockedSong } from '../routes/music.js';

const execAsync = promisify(exec);

export interface ChannelBlockResult {
  channelTitle: string;
  tracksBlocked: number;
  duplicateChannelsBlocked: number;
  duplicateChannelIds: string[];
}

/**
 * Get all video IDs from a YouTube channel
 */
async function getAllChannelVideos(channelId: string): Promise<string[]> {
  try {
    const tempFile = `/tmp/channel_${channelId}_videos.txt`;
    // Get all video IDs and save to a file
    await execAsync(`yt-dlp --no-warnings --flat-playlist --print id "https://www.youtube.com/channel/${channelId}" > ${tempFile}`);
    
    // Read the file content
    const { stdout: fileContent } = await execAsync(`cat ${tempFile}`);
    
    // Clean up temp file
    await execAsync(`rm ${tempFile}`);
    
    // Split by newlines and filter empty lines
    return fileContent.trim().split('\n').filter(id => id);
  } catch (error) {
    logger.error('Error getting channel videos:', error);
    throw error;
  }
}

/**
 * Find channels with the same title that are not blocked
 */
async function findDuplicateChannels(channelTitle: string) {
  return await prisma.channel.findMany({
    where: {
      title: channelTitle,
      isBlocked: false
    }
  });
}

/**
 * Block a channel by ID and update all its tracks
 */
async function blockChannelById(channelId: string, reason: string = 'No reason provided'): Promise<ChannelBlockResult> {
  try {
    logger.info(`Starting to block channel: ${channelId}`);
    
    // Get all video IDs from the channel using yt-dlp
    logger.info(`Fetching all video IDs...`);
    const allChannelVideos = await getAllChannelVideos(channelId);
    logger.info(`Found ${allChannelVideos.length} videos`);
    
    // Get channel info for new channels
    let channel = await prisma.channel.findUnique({
      where: { id: channelId }
    });
    logger.info(`Channel exists in DB: ${!!channel}`);

    if (!channel) {
      // Get channel title using yt-dlp
      logger.info(`Getting channel title from YouTube...`);
      const { stdout: channelTitle } = await execAsync(`yt-dlp --no-warnings --print channel "https://www.youtube.com/channel/${channelId}"`);
      const cleanTitle = channelTitle.trim().split('\n')[0]; // Take only the first line
      logger.info(`Channel title: "${cleanTitle}"`);
      
      // Create channel entry
      logger.info(`Creating new channel entry in DB...`);
      channel = await prisma.channel.create({
        data: {
          id: channelId,
          title: cleanTitle,
          isBlocked: true,
          blockedAt: new Date(),
          blockedReason: reason
        }
      });
    } else {
      // Update existing channel to blocked status
      logger.info(`Updating existing channel to blocked status...`);
      await prisma.channel.update({
        where: { id: channelId },
        data: {
          isBlocked: true,
          blockedAt: new Date(),
          blockedReason: reason
        }
      });
    }

    // Block all existing tracks from this channel
    logger.info(`Finding existing tracks from this channel...`);
    const existingTracks = await prisma.track.findMany({
      where: {
        youtubeId: {
          in: allChannelVideos
        }
      }
    });
    logger.info(`Found ${existingTracks.length} existing tracks to block`);

    // Update all existing tracks to BLOCKED status
    if (existingTracks.length > 0) {
      const trackIds = existingTracks.map(track => track.youtubeId);
      
      logger.info(`Updating tracks and user stats...`);
      await prisma.$transaction([
        // Update tracks to BLOCKED status
        prisma.track.updateMany({
          where: {
            youtubeId: {
              in: trackIds
            }
          },
          data: {
            status: 'BLOCKED',
            globalScore: {
              decrement: 10
            }
          }
        }),
        // Apply penalty to user stats
        prisma.$executeRaw`
          UPDATE "UserTrackStats"
          SET "personalScore" = "UserTrackStats"."personalScore" - 5
          WHERE "youtubeId" = ANY(${trackIds})
        `
      ]);

      // Clean up blocked songs
      logger.info(`Cleaning up blocked songs...`);
      for (const youtubeId of trackIds) {
        await cleanupBlockedSong(youtubeId);
      }
    }

    // Remove all recommendations that use any track from this channel as a seed
    logger.info(`Removing recommendations...`);
    const recommendationResult = await prisma.youtubeRecommendation.deleteMany({
      where: {
        OR: [
          {
            seedTrackId: {
              in: allChannelVideos
            }
          },
          {
            youtubeId: {
              in: allChannelVideos
            }
          }
        ]
      }
    });
    logger.info(`Removed ${recommendationResult.count} recommendations`);

    logger.info(`Channel blocking complete`);

    // Find and block duplicate channels with same name
    const duplicateResult = await blockDuplicateChannels(channel.title, channelId, reason);

    logger.info(`Blocked channel ${channelId} (${channel.title}) with ${existingTracks.length} tracks`);
    if (duplicateResult.duplicateChannelsBlocked > 0) {
      logger.info(`Also blocked ${duplicateResult.duplicateChannelsBlocked} duplicate channels`);
    }

    return {
      channelTitle: channel.title,
      tracksBlocked: existingTracks.length,
      duplicateChannelsBlocked: duplicateResult.duplicateChannelsBlocked,
      duplicateChannelIds: duplicateResult.duplicateChannelIds
    };
  } catch (error) {
    logger.error('Error blocking channel:', error);
    throw error;
  }
}

/**
 * Block duplicate channels with the same title
 */
async function blockDuplicateChannels(
  channelTitle: string,
  originalChannelId: string,
  reason: string
): Promise<{ duplicateChannelsBlocked: number; duplicateChannelIds: string[] }> {
  let duplicateChannelsBlocked = 0;
  const duplicateChannelIds: string[] = [];
  const duplicateChannels = await findDuplicateChannels(channelTitle);
  
  for (const dupChannel of duplicateChannels) {
    // Skip if: original channel, already blocked, or same as current channel
    if (dupChannel.id !== originalChannelId && !dupChannel.isBlocked) {
      logger.info(`Found unblocked duplicate channel: ${dupChannel.id} (${dupChannel.title})`);
      try {
        await blockChannelById(dupChannel.id, `Duplicate of blocked channel ${originalChannelId}: ${reason}`);
        duplicateChannelsBlocked++;
        duplicateChannelIds.push(dupChannel.id);
      } catch (error) {
        logger.error(`Error blocking duplicate channel ${dupChannel.id}:`, error);
      }
    } else {
      logger.info(`Skipping duplicate channel ${dupChannel.id} (already blocked or same as original)`);
    }
  }

  return { duplicateChannelsBlocked, duplicateChannelIds };
}

/**
 * Format channel block result message for Discord responses
 */
export function formatChannelBlockMessage(result: ChannelBlockResult, action: string = 'Blocked'): string {
  let message = `${action} channel "${result.channelTitle}" with ${result.tracksBlocked} tracks.`;
  
  if (result.duplicateChannelsBlocked > 0) {
    message += `\nAlso blocked ${result.duplicateChannelsBlocked} duplicate channels: ` +
      result.duplicateChannelIds.join(', ');
  }
  
  return message;
}

export { blockChannelById, findDuplicateChannels, blockDuplicateChannels };