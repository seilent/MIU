import { ChatInputCommandInteraction, GuildMember } from 'discord.js';
import { prisma } from '../../db';
import { TrackingService } from '../../tracking/service';

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

    // Get position from options (optional) - UI shows position starting from 1
    const uiPosition = interaction.options.getInteger('position');
    
    // Defer reply to give us time to process
    await interaction.deferReply();

    const player = interaction.client.player;
    const trackingService = new TrackingService();
    
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
      
      // Apply ban penalty to the track (-10 score)
      await applyBanPenalty(trackToBan.youtubeId, trackingService);
      
      // Remove from queue (this is handled differently than skipping the current track)
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
      
      // Force queue repopulation by toggling autoplay if enabled
      // This will cause the player to refresh its state and repopulate the queue
      const autoplayEnabled = player.isAutoplayEnabled();
      if (autoplayEnabled) {
        // Toggle autoplay off and on to force a refresh
        player.setAutoplay(false);
        player.setAutoplay(true);
      }
      
      await interaction.editReply(`Banned song at position ${uiPosition}: ${trackToBan.title}`);
    } else {
      // Ban the currently playing song
      const currentTrack = player.getCurrentTrack();
      
      if (!currentTrack) {
        await interaction.editReply('No track is currently playing.');
        return;
      }
      
      // Apply ban penalty to the track (-10 score)
      await applyBanPenalty(currentTrack.youtubeId, trackingService);
      
      // Skip the current track
      await player.skip();
      
      await interaction.editReply(`Banned and skipped: ${currentTrack.title}`);
    }
  } catch (error) {
    console.error('Ban command error:', error);
    // If we haven't replied yet, send an error reply
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply('An error occurred while banning the track.');
    } else {
      // If we've already replied or deferred, edit the reply
      await interaction.editReply('An error occurred while banning the track.');
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
  } catch (error) {
    console.error('Error applying ban penalty:', error);
    throw error;
  }
} 