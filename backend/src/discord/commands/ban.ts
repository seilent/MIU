import { ChatInputCommandInteraction, GuildMember, SlashCommandBuilder } from 'discord.js';
import { prisma } from '../../db.js';
import { TrackingService } from '../../tracking/service.js';
import { cleanupBlockedSong } from '../../routes/music.js';
import { getKeyManager } from '../../utils/YouTubeKeyManager.js';
import { youtube } from '../../utils/youtube.js';
import { promisify } from 'util';
import { exec } from 'child_process';

const execAsync = promisify(exec);

async function getChannelInfoFromVideo(youtubeId: string): Promise<{ channelId: string; channelTitle: string }> {
  try {
    const { stdout: channelInfo } = await execAsync(`yt-dlp --no-warnings --print channel,channel_id "https://www.youtube.com/watch?v=${youtubeId}"`);
    const [channelTitle, channelId] = channelInfo.trim().split('\n');
    // Take only the first line of channel title if it contains newlines
    const cleanTitle = channelTitle.trim().split('\n')[0];
    return { channelId, channelTitle: cleanTitle };
  } catch (error) {
    console.error('Error getting channel info:', error);
    throw error;
  }
}

async function getAllChannelVideos(channelId: string): Promise<string[]> {
  try {
    const tempFile = `/home/seilent/MIU/backend/cache/temp/channel_${channelId}_videos.txt`;
    // Get all video IDs and save to a file
    await execAsync(`yt-dlp --no-warnings --flat-playlist --print id "https://www.youtube.com/channel/${channelId}" > ${tempFile}`);
    
    // Read the file content
    const { stdout: fileContent } = await execAsync(`cat ${tempFile}`);
    
    // Clean up temp file
    await execAsync(`rm ${tempFile}`);
    
    // Split by newlines and filter empty lines
    return fileContent.trim().split('\n').filter(id => id);
  } catch (error) {
    console.error('Error getting channel videos:', error);
    throw error;
  }
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

async function blockChannelById(channelId: string, reason: string) {
  try {
    console.log(`[Ban][Channel] Starting to block channel: ${channelId}`);
    
    // Get all video IDs from the channel using yt-dlp
    console.log(`[Ban][Channel] Fetching all video IDs...`);
    const allChannelVideos = await getAllChannelVideos(channelId);
    console.log(`[Ban][Channel] Found ${allChannelVideos.length} videos`);
    
    // Get channel info for new channels
    let channel = await prisma.channel.findUnique({
      where: { id: channelId }
    });
    console.log(`[Ban][Channel] Channel exists in DB: ${!!channel}`);

    if (!channel) {
      // Get channel title using yt-dlp
      console.log(`[Ban][Channel] Getting channel title from YouTube...`);
      const { stdout: channelTitle } = await execAsync(`yt-dlp --no-warnings --print channel "https://www.youtube.com/channel/${channelId}"`);
      const cleanTitle = channelTitle.trim().split('\n')[0]; // Take only the first line
      console.log(`[Ban][Channel] Channel title: "${cleanTitle}"`);
      
      // Create channel entry
      console.log(`[Ban][Channel] Creating new channel entry in DB...`);
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
      console.log(`[Ban][Channel] Updating existing channel to blocked status...`);
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
    console.log(`[Ban][Channel] Finding existing tracks from this channel...`);
    const existingTracks = await prisma.track.findMany({
      where: {
        youtubeId: {
          in: allChannelVideos
        }
      }
    });
    console.log(`[Ban][Channel] Found ${existingTracks.length} existing tracks to block`);

    // Update all existing tracks to BLOCKED status
    if (existingTracks.length > 0) {
      const trackIds = existingTracks.map(track => track.youtubeId);
      
      console.log(`[Ban][Channel] Updating tracks and user stats...`);
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
      console.log(`[Ban][Channel] Cleaning up blocked songs...`);
      for (const youtubeId of trackIds) {
        await cleanupBlockedSong(youtubeId);
      }
    }

    // Remove all recommendations that use any track from this channel as a seed
    console.log(`[Ban][Channel] Removing recommendations...`);
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
    console.log(`[Ban][Channel] Removed ${recommendationResult.count} recommendations`);

    console.log(`[Ban][Channel] Channel blocking complete`);
    return {
      channelTitle: channel.title,
      tracksBlocked: existingTracks.length
    };
  } catch (error) {
    console.error('Error blocking channel:', error);
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
                await interaction.editReply(
                  `Banned song at position ${uiPosition}: ${trackToBan.title}\n` +
                  `Also blocked channel "${channelResult.channelTitle}" with ${channelResult.tracksBlocked} tracks.`
                );
              } catch (error: any) {
                console.error('Error blocking channel:', error);
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
              await interaction.editReply(
                `Banned and skipped: ${currentTrack.title}\n` +
                `Also blocked channel "${channelResult.channelTitle}" with ${channelResult.tracksBlocked} tracks.`
              );
            } catch (error: any) {
              console.error('Error blocking channel:', error);
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
          
          console.log(`[Ban] Starting ban process for video ID: ${id}`);
          console.log(`[Ban] Block channel option: ${blockChannel}`);
          
          // Apply ban penalty to the track
          try {
            console.log(`[Ban] Applying ban penalty to video ID: ${id}`);
            await applyBanPenalty(id, trackingService);
            console.log(`[Ban] Successfully applied ban penalty`);
          } catch (error) {
            console.error(`[Ban] Error applying ban penalty:`, error);
            throw error;
          }

          // Get channel info and block channel only if blockChannel is true
          let channelBlockMessage = '';
          if (blockChannel) {
            try {
              console.log(`[Ban] Getting channel info for video ID: ${id}`);
              const { channelId, channelTitle } = await getChannelInfoFromVideo(id);
              console.log(`[Ban] Found channel: ${channelTitle} (${channelId})`);
              
              console.log(`[Ban] Blocking channel: ${channelId}`);
              const channelResult = await blockChannelById(channelId, 'Banned along with track');
              console.log(`[Ban] Channel blocked. Affected ${channelResult.tracksBlocked} tracks`);
              
              channelBlockMessage = `\nAlso blocked channel "${channelResult.channelTitle}" with ${channelResult.tracksBlocked} tracks.`;
            } catch (error) {
              console.error(`[Ban] Error processing channel:`, error);
              channelBlockMessage = '\nFailed to process channel information.';
            }
          }

          // Block recommendations from this track
          let recommendationsBlocked = 0;
          try {
            console.log(`[Ban] Blocking recommendations for video ID: ${id}`);
            const result = await blockSeedRecommendations(id);
            recommendationsBlocked = result.count;
            console.log(`[Ban] Blocked ${recommendationsBlocked} recommendations`);
          } catch (error) {
            console.error(`[Ban] Error blocking recommendations:`, error);
            throw error;
          }

          console.log(`[Ban] Ban process completed for video ID: ${id}`);
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
      console.error('Error in ban command:', error);
      await interaction.editReply('An error occurred while executing the command.');
    }
  } catch (error) {
    console.error('Ban command error:', error);
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
    console.error('Error applying ban penalty:', error);
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
