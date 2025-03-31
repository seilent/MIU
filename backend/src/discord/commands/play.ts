import { ChatInputCommandInteraction, GuildMember } from 'discord.js';
import { getYoutubeId } from '../../utils/youtube.js';
import { AudioPlayerStatus } from '@discordjs/voice';
import { getThumbnailUrl } from '../../utils/youtubeMusic.js';

export async function play(interaction: ChatInputCommandInteraction) {
  try {
    if (!interaction.guildId) {
      await interaction.reply('This command can only be used in a server.');
      return;
    }

    const member = interaction.member as GuildMember;
    const query = interaction.options.getString('query', true);
    const { videoId, isMusicUrl } = await getYoutubeId(query);

    if (!videoId) {
      await interaction.reply('Could not find a valid YouTube video.');
      return;
    }

    await interaction.deferReply();

    try {
      // First, send a temporary "Processing..." message
      await interaction.editReply({
        content: 'Processing your request...',
      });

      const track = await interaction.client.player.play(
        null, // No voice channel required
        videoId,
        member.id,
        {
          username: member.user.username,
          discriminator: member.user.discriminator || '0',
          avatar: member.user.avatar || null
        },
        isMusicUrl
      );

      // Only proceed if we have track info
      if (!track.trackInfo || !track.success) {
        await interaction.editReply(track.message);
        return;
      }

      // Convert cached thumbnail path to YouTube URL if needed
      const thumbnailUrl = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

      const queuePosition = track.trackInfo.queuePosition ? ` (#${track.trackInfo.queuePosition} in queue)` : '';
      const playingNext = track.trackInfo.willPlayNext ? ' - Playing next!' : '';
      const status = `${queuePosition}${playingNext}`;

      // Use the track info title instead of temporary one
      const titleDisplay = track.trackInfo.title || 'Unknown Title';

      // Respond with track information
      await interaction.editReply({
        embeds: [{
          title: titleDisplay,
          thumbnail: { url: thumbnailUrl },
          description: `Added to queue${status}`,
          footer: { 
            text: `Requested by ${member.displayName}`,
            icon_url: member.user.displayAvatarURL()
          }
        }]
      });

    } catch (error: any) {
      if (error.message?.includes('recently played')) {
        await interaction.editReply(error.message);
      } else if (error.message === 'Queue limit reached') {
        await interaction.editReply('You have reached your queue limit.');
      } else {
        console.error('Play command error:', error);
        await interaction.editReply('Failed to play the track. Please try again later.');
      }
    }
  } catch (error) {
    console.error('Play command error:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply('An error occurred while processing your request.');
    } else {
      await interaction.editReply('An error occurred while processing your request.');
    }
  }
}
