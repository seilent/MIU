import { ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';

export async function queue(interaction: ChatInputCommandInteraction) {
  try {
    const currentTrack = interaction.client.player.getCurrentTrack();
    const queue = interaction.client.player.getQueue();

    if (!currentTrack && queue.length === 0) {
      await interaction.reply('The queue is empty.');
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('Music Queue')
      .setColor('#FF0000');

    // Add current track
    if (currentTrack) {
      embed.addFields({
        name: '🎵 Now Playing',
        value: formatTrack(currentTrack)
      });
    }

    // Add queue
    if (queue.length > 0) {
      const queueList = queue
        .slice(0, 10)
        .map((track, index) => `${index + 1}. ${formatTrack(track)}`)
        .join('\n');

      embed.addFields({
        name: '📋 Queue',
        value: queueList
      });

      if (queue.length > 10) {
        embed.setFooter({
          text: `And ${queue.length - 10} more tracks...`
        });
      }
    }

    await interaction.reply({ embeds: [embed] });
  } catch (error) {
    console.error('Queue command error:', error);
    await interaction.reply('An error occurred while fetching the queue.');
  }
}

function formatTrack(track: any) {
  const requestedBy = track.requestedBy.username === 'Autoplay' 
    ? track.requestedBy.username 
    : `<@${track.requestedBy.userId}>`;
  
  // Handle loading state
  if (track.title === 'Loading...') {
    return `🔄 Loading track... - Requested by ${requestedBy}`;
  }
  
  return `${track.title} (${formatDuration(track.duration)}) - Requested by ${requestedBy}`;
}

function formatDuration(seconds: number) {
  if (!seconds) return '--:--'; // Handle loading state where duration is 0
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
} 