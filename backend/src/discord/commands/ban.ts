import { ChatInputCommandInteraction, GuildMember, SlashCommandBuilder } from 'discord.js';
import { prisma } from '../../db';
import { TrackingService } from '../../tracking/service';
import { cleanupBlockedSong } from '../../routes/music';
import { getKeyManager } from '../../utils/YouTubeKeyManager';
import { youtube } from '../../utils/youtube';

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
    // Update channel to blocked status
    await prisma.channel.update({
      where: { id: channelId },
      data: {
        isBlocked: true,
        blockedAt: new Date(),
        blockedReason: reason
      }
    });

    // Get all tracks from this channel
    const tracks = await prisma.track.findMany({
      where: { channelId }
    });

    // Block all tracks from this channel and clean up recommendations
    for (const track of tracks) {
      // Update track status and apply penalty
      await prisma.track.update({
        where: { youtubeId: track.youtubeId },
        data: {
          status: 'BLOCKED',
          globalScore: {
            decrement: 10 // Apply ban penalty
          }
        }
      });

      // Clean up blocked song from playlists and recommendations
      await cleanupBlockedSong(track.youtubeId);
    }

    // Remove all recommendations that use any track from this channel as a seed
    const trackIds = tracks.map(track => track.youtubeId);
    await prisma.youtubeRecommendation.deleteMany({
      where: {
        seedTrackId: {
          in: trackIds
        }
      }
    });

    // Remove all recommendations of any track from this channel
    await prisma.youtubeRecommendation.deleteMany({
      where: {
        youtubeId: {
          in: trackIds
        }
      }
    });

    return {
      channelTitle: (await prisma.channel.findUnique({ where: { id: channelId } }))?.title || 'Unknown Channel',
      tracksBlocked: tracks.length
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
          const blockSeed = interaction.options.getBoolean('block_seed') || false;
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

            // Block channel if requested and channel exists
            let channelBlockMessage = '';
            if (blockChannel && trackInfo.channelId) {
              const channelResult = await blockChannelById(trackInfo.channelId, 'Banned along with track');
              channelBlockMessage = `\nAlso blocked channel "${channelResult.channelTitle}" with ${channelResult.tracksBlocked} tracks.`;
            }

            // Block seed recommendations if requested
            let seedBlockMessage = '';
            if (blockSeed) {
              const result = await blockSeedRecommendations(trackToBan.youtubeId);
              if (result.count > 0) {
                seedBlockMessage = `\nAlso blocked ${result.count} recommendations that were based on this track.`;
              }
            }
            
            // Remove from queue
            await prisma.request.updateMany({
              where: {
                youtubeId: trackToBan.youtubeId,
                status: 'QUEUED',
                requestedAt: trackToBan.requestedAt
              },
              data: {
                status: 'SKIPPED'
              }
            });
            
            // Force queue repopulation by resetting autoplay tracking if enabled
            if (player.isAutoplayEnabled()) {
              player.resetAutoplayTracking();
            }
            
            await interaction.editReply(`Banned song at position ${uiPosition}: ${trackToBan.title}${seedBlockMessage}${channelBlockMessage}`);
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

          // Block channel if requested and channel exists
          let channelBlockMessage = '';
          if (blockChannel && trackInfo.channelId) {
            const channelResult = await blockChannelById(trackInfo.channelId, 'Banned along with track');
            channelBlockMessage = `\nAlso blocked channel "${channelResult.channelTitle}" with ${channelResult.tracksBlocked} tracks.`;
          }

          // Block seed recommendations if requested
          let seedBlockMessage = '';
          if (blockSeed) {
            const result = await blockSeedRecommendations(currentTrack.youtubeId);
            if (result.count > 0) {
              seedBlockMessage = `\nAlso blocked ${result.count} recommendations that were based on this track.`;
            }
          }
          
          // Skip the current track
          await player.skip();
          
          await interaction.editReply(`Banned and skipped: ${currentTrack.title}${seedBlockMessage}${channelBlockMessage}`);
          break;
        }
        
        case 'song': {
          const id = interaction.options.getString('id', true);
          const blockChannel = interaction.options.getBoolean('block_channel') || false;
          
          // Find the track in the database
          const track = await prisma.track.findUnique({
            where: { youtubeId: id }
          });

          if (!track) {
            await interaction.editReply(`Track ${id} not found.`);
            return;
          }

          // Apply ban penalty to the track
          await applyBanPenalty(id, trackingService);

          // Block channel if requested and channel exists
          let channelBlockMessage = '';
          if (blockChannel && track.channelId) {
            const channelResult = await blockChannelById(track.channelId, 'Banned along with track');
            channelBlockMessage = `\nAlso blocked channel "${channelResult.channelTitle}" with ${channelResult.tracksBlocked} tracks.`;
          }

          // Block recommendations from this track
          const { count: recommendationsBlocked } = await blockSeedRecommendations(id);

          await interaction.editReply(
            `Banned song "${track.title}" (${track.youtubeId})\n` +
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
          await interaction.editReply('Invalid subcommand. Use /ban track, /ban song, or /ban channel.');
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
            .setName('block_seed')
            .setDescription('Also block all recommendations from this song')
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
        .setName('song')
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
      if (subcommand === 'song') {
        // Existing song ban logic
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