import { ChatInputCommandInteraction, GuildMember, SlashCommandBuilder } from 'discord.js';
import { prisma } from '../../db.js';
import { TrackingService } from '../../tracking/service.js';
import { cleanupBlockedSong } from '../../routes/music.js';
import { getKeyManager } from '../../utils/YouTubeKeyManager.js';
import { youtube, getYoutubeInfo } from '../../utils/youtube.js';
import { blockChannelById, formatChannelBlockMessage } from '../../utils/channelBlocking.js';
import logger from '../../utils/logger.js';
import { promisify } from 'util';
import { exec } from 'child_process';

const execAsync = promisify(exec);

async function getChannelInfoFromVideo(youtubeId: string): Promise<{ channelId: string; channelTitle: string } | null> {
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
    console.error('Error getting channel info:', error);
  }

  return null;
}


async function blockSeedRecommendations(youtubeId: string) {
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
          status: 'BLOCKED',
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
    for (const youtubeId of youtubeIds) {
      await cleanupBlockedSong(youtubeId);
    }

    return { 
      count: youtubeIds.length, 
      seedTrack: seedTrack?.title || 'Unknown Track'
    };
  } catch (error) {
    console.error('Error blocking seed recommendations:', error);
    throw error;
  }
}


export async function ban(interaction: ChatInputCommandInteraction) {
  try {
    // Check if user has admin role
    const userId = interaction.user.id;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { roles: true }
    });

    // Only allow admins to use this command
    if (!user || !user.roles.some(role => role.name === 'admin')) {
      await interaction.reply({
        content: 'You need admin permissions to use this command.',
        ephemeral: true
      });
      return;
    }

    if (!interaction.guildId) {
      await interaction.reply('This command can only be used in a server.');
      return;
    }

    // Defer reply to give us time to process
    await interaction.deferReply();

    const subcommand = interaction.options.getSubcommand();
    const player = interaction.client.player;
    const trackingService = new TrackingService();
    
    try {
      switch (subcommand) {
        case 'track': {
          const uiPosition = interaction.options.getInteger('position');
          const blockChannel = interaction.options.getBoolean('block_channel') || false;
          
          if (uiPosition !== null) {
            // Convert UI position (1-based) to array index (0-based)
            const position = uiPosition - 1;
            
            // Ban a specific song in the queue by position
            const queue = player.getQueue();
            
            if (position < 0 || position >= queue.length) {
              await interaction.editReply(`Invalid position. Queue has ${queue.length} songs (positions 1-${queue.length}).`);
              return;
            }
            
            const trackToBan = queue[position];
            
            // Get track info to check channel
            const trackInfo = await prisma.track.findUnique({
              where: { youtubeId: trackToBan.youtubeId }
            });

            if (!trackInfo) {
              await interaction.editReply(`Track information not found for ${trackToBan.title}.`);
              return;
            }

            // Apply ban penalty to the track (-10 score)
            await applyBanPenalty(trackToBan.youtubeId, trackingService);

            // If this was the currently playing track, skip it immediately
            const currentTrack = player.getCurrentTrack();
            if (currentTrack && currentTrack.youtubeId === trackToBan.youtubeId) {
              await player.skip();
            }

            // Send initial response
            if (blockChannel && trackInfo.channelId) {
              await interaction.editReply(`Banned song at position ${uiPosition}: ${trackToBan.title}\nProcessing channel block...`);
            } else {
              await interaction.editReply(`Banned song at position ${uiPosition}: ${trackToBan.title}`);
            }

            // Block channel if requested and channel exists (in background)
            if (blockChannel && trackInfo.channelId) {
              try {
                const channelResult = await blockChannelById(trackInfo.channelId, 'Banned along with track');
                // Update the message after channel is blocked
                let replyMessage = `Banned song at position ${uiPosition}: ${trackToBan.title}\n` +
                  `Blocked channel "${channelResult.channelTitle}" with ${channelResult.tracksBlocked} tracks.`;
                
                if (channelResult.duplicateChannelsBlocked > 0) {
                  replyMessage += `\nAlso blocked ${channelResult.duplicateChannelsBlocked} duplicate channels: ` +
                    channelResult.duplicateChannelIds.join(', ');
                }

                await interaction.editReply(replyMessage);
              } catch (error: any) {
                logger.error('Error blocking channel:', error);
                await interaction.editReply(
                  `Banned song at position ${uiPosition}: ${trackToBan.title}\n` +
                  `Failed to block channel: ${error.message || 'Unknown error'}`
                );
              }
            }
            
            // Force queue repopulation by resetting autoplay tracking if enabled
            if (player.isAutoplayEnabled()) {
              player.resetAutoplayTracking();
            }
            
            return;
          }

          // Ban the currently playing song
          const currentTrack = player.getCurrentTrack();
          
          if (!currentTrack) {
            await interaction.editReply('No track is currently playing.');
            return;
          }
          
          // Get track info to check channel
          const trackInfo = await prisma.track.findUnique({
            where: { youtubeId: currentTrack.youtubeId }
          });

          if (!trackInfo) {
            await interaction.editReply(`Track information not found for ${currentTrack.title}.`);
            return;
          }

          // Apply ban penalty to the track (-10 score)
          await applyBanPenalty(currentTrack.youtubeId, trackingService);

          // Skip the current track immediately if it's still playing
          const newCurrentTrack = player.getCurrentTrack();
          if (newCurrentTrack && newCurrentTrack.youtubeId === currentTrack.youtubeId) {
            await player.skip();
          }

          // Send initial response
          if (blockChannel && trackInfo.channelId) {
            await interaction.editReply(`Banned and skipped: ${currentTrack.title}\nProcessing channel block...`);
          } else {
            await interaction.editReply(`Banned and skipped: ${currentTrack.title}`);
          }

          // Block channel if requested and channel exists (in background)
          if (blockChannel && trackInfo.channelId) {
            try {
              const channelResult = await blockChannelById(trackInfo.channelId, 'Banned along with track');
              // Update the message after channel is blocked
              let replyMessage = `Banned and skipped: ${currentTrack.title}\n` +
                `Blocked channel "${channelResult.channelTitle}" with ${channelResult.tracksBlocked} tracks.`;
              
              if (channelResult.duplicateChannelsBlocked > 0) {
                replyMessage += `\nAlso blocked ${channelResult.duplicateChannelsBlocked} duplicate channels: ` +
                  channelResult.duplicateChannelIds.join(', ');
              }

              await interaction.editReply(replyMessage);
            } catch (error: any) {
              logger.error('Error blocking channel:', error);
              await interaction.editReply(
                `Banned and skipped: ${currentTrack.title}\n` +
                `Failed to block channel: ${error.message || 'Unknown error'}`
              );
            }
          }
          
          break;
        }
        
        case 'id': {
          const id = interaction.options.getString('id', true);
          const blockChannel = interaction.options.getBoolean('block_channel') || false;
          
          logger.info(`[Ban] Starting ban process for video ID: ${id}`);
          logger.info(`[Ban] Block channel option: ${blockChannel}`);

          // First check if track exists and get channel info
          const track = await prisma.track.findUnique({
            where: { youtubeId: id },
            include: { channel: true }
          });

          // If track's channel is already blocked, use blockChannelById
          if (track?.channel?.isBlocked) {
            logger.info(`[Ban] Channel ${track.channel.id} is already blocked, blocking all tracks`);
            const channelResult = await blockChannelById(track.channel.id, 'Channel already blocked');
            await interaction.editReply(
              `Banned song "${id}" from already-blocked channel "${track.channel.title}"\n` +
              `Blocked ${channelResult.tracksBlocked} tracks from this channel.`
            );
            return;
          }
          
          // Apply ban penalty to the track
          try {
            logger.info(`[Ban] Applying ban penalty to video ID: ${id}`);
            await applyBanPenalty(id, trackingService);
            logger.info(`[Ban] Successfully applied ban penalty`);
          } catch (error) {
            logger.error(`[Ban] Error applying ban penalty:`, error);
            throw error;
          }

          // Get channel info and block channel only if blockChannel is true
          let channelBlockMessage = '';
          if (blockChannel) {
            try {
              logger.info(`[Ban] Getting channel info for video ID: ${id}`);
              const channelInfo = await getChannelInfoFromVideo(id);
              
              if (channelInfo) {
                logger.info(`[Ban] Found channel: ${channelInfo.channelTitle} (${channelInfo.channelId})`);
                logger.info(`[Ban] Blocking channel: ${channelInfo.channelId}`);
                const channelResult = await blockChannelById(channelInfo.channelId, 'Banned along with track');
                logger.info(`[Ban] Channel blocked. Affected ${channelResult.tracksBlocked} tracks`);
                channelBlockMessage = `\nBlocked channel "${channelResult.channelTitle}" with ${channelResult.tracksBlocked} tracks.`;
                
                if (channelResult.duplicateChannelsBlocked > 0) {
                  channelBlockMessage += `\nAlso blocked ${channelResult.duplicateChannelsBlocked} duplicate channels: ` +
                    channelResult.duplicateChannelIds.join(', ');
                }
              } else {
                logger.info(`[Ban] Could not get channel info for video ${id}`);
                channelBlockMessage = '\nCould not get channel information - track was banned but channel could not be blocked.';
              }
            } catch (error) {
              logger.error(`[Ban] Error processing channel:`, error);
              channelBlockMessage = '\nFailed to process channel information.';
            }
          }

          // Block recommendations from this track
          let recommendationsBlocked = 0;
          try {
            logger.info(`[Ban] Blocking recommendations for video ID: ${id}`);
            const result = await blockSeedRecommendations(id);
            recommendationsBlocked = result.count;
            logger.info(`[Ban] Blocked ${recommendationsBlocked} recommendations`);
          } catch (error) {
            logger.error(`[Ban] Error blocking recommendations:`, error);
            throw error;
          }

          logger.info(`[Ban] Ban process completed for video ID: ${id}`);
          await interaction.editReply(
            `Banned song "${id}"\n` +
            `Blocked ${recommendationsBlocked} recommendations from this song.${channelBlockMessage}`
          );
          break;
        }
        
        case 'channel': {
          const id = interaction.options.getString('id', true);
          const reason = interaction.options.getString('reason') || 'No reason provided';
          
          const result = await blockChannelById(id, reason);
          await interaction.editReply(
            `Banned channel "${result.channelTitle}" (${id})\n` +
            `Reason: ${reason}\n` +
            `Blocked ${result.tracksBlocked} tracks from this channel.`
          );
          break;
        }
        
        default:
          await interaction.editReply('Invalid subcommand. Use /ban track, /ban id, or /ban channel.');
      }
    } catch (error) {
      logger.error('Error in ban command:', error);
      await interaction.editReply('An error occurred while executing the command.');
    }
  } catch (error) {
    logger.error('Ban command error:', error);
    // Only reply if we haven't replied yet
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply('An error occurred while executing the command.');
    } else if (interaction.deferred) {
      await interaction.editReply('An error occurred while executing the command.');
    }
  }
}

// Helper function to apply a ban penalty to a track
async function applyBanPenalty(youtubeId: string, trackingService: TrackingService) {
  try {
    // Apply a -10 score penalty to the track
    await prisma.$transaction([
      // Update global track stats with a heavy penalty
      prisma.$executeRaw`
        UPDATE "Track"
        SET "globalScore" = "Track"."globalScore" - 10,
            "status" = 'BLOCKED'
        WHERE "youtubeId" = ${youtubeId}
      `,
      // Also update all user stats for this track with a penalty
      prisma.$executeRaw`
        UPDATE "UserTrackStats"
        SET "personalScore" = "UserTrackStats"."personalScore" - 5
        WHERE "youtubeId" = ${youtubeId}
      `
    ]);

    // Clean up the blocked song from playlists and recommendations
    await cleanupBlockedSong(youtubeId);
  } catch (error) {
    logger.error('Error applying ban penalty:', error);
    throw error;
  }
}

export default {
  data: new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Ban a song or channel')
    .addSubcommand(subcommand =>
      subcommand
        .setName('track')
        .setDescription('Ban a specific track')
        .addIntegerOption(option =>
          option
            .setName('position')
            .setDescription('Position in queue (starting from 1, leave empty to ban currently playing song)')
            .setRequired(false)
        )
        .addBooleanOption(option =>
          option
            .setName('block_channel')
            .setDescription('Also block the channel that uploaded this song')
            .setRequired(false)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('id')
        .setDescription('Ban a specific song by YouTube ID')
        .addStringOption(option =>
          option
            .setName('id')
            .setDescription('YouTube video ID or URL')
            .setRequired(true)
        )
        .addBooleanOption(option =>
          option
            .setName('block_channel')
            .setDescription('Also block the channel that uploaded this song')
            .setRequired(false)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('channel')
        .setDescription('Ban an entire YouTube channel')
        .addStringOption(option =>
          option
            .setName('id')
            .setDescription('YouTube channel ID')
            .setRequired(true)
        )
        .addStringOption(option =>
          option
            .setName('reason')
            .setDescription('Reason for banning')
            .setRequired(false)
        )
    ),
  async execute(interaction: ChatInputCommandInteraction) {
    // Check if user has admin role
    const member = interaction.member as GuildMember;
    if (!member.roles.cache.some(role => role.name.toLowerCase() === 'admin')) {
      await interaction.reply('You need the Admin role to use this command.');
      return;
    }

    const subcommand = interaction.options.getSubcommand();
    const id = interaction.options.getString('id', true);
    const reason = interaction.options.getString('reason') || 'No reason provided';

    try {
      if (subcommand === 'id') {
        // Ban by YouTube ID logic
        const track = await prisma.track.findUnique({
          where: { youtubeId: id },
          include: { channel: true }
        });

        if (!track) {
          await interaction.reply(`Track ${id} not found.`);
          return;
        }

        // Update track status to BLOCKED
        await prisma.track.update({
          where: { youtubeId: id },
          data: {
            status: 'BLOCKED',
            globalScore: {
              decrement: 10 // Apply ban penalty
            }
          }
        });

        // Clean up blocked song
        await cleanupBlockedSong(id);

        // Block recommendations from this track
        const { count: recommendationsBlocked } = await blockSeedRecommendations(id);

        await interaction.reply(
          `Banned song "${track.title}" (${track.youtubeId})\n` +
          `Channel: ${track.channel?.title || 'Unknown'}\n` +
          `Reason: ${reason}\n` +
          `Also blocked ${recommendationsBlocked} recommendations from this song.`
        );
      } else if (subcommand === 'channel') {
        const result = await blockChannelById(id, reason);
        await interaction.reply(
          `Banned channel "${result.channelTitle}" (${id})\n` +
          `Reason: ${reason}\n` +
          `Blocked ${result.tracksBlocked} tracks from this channel.`
        );
      }
    } catch (error) {
      console.error('Error executing ban command:', error);
      await interaction.reply('An error occurred while executing the command.');
    }
  }
};
