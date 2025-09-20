import { 
  ChatInputCommandInteraction, 
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ComponentType,
  StringSelectMenuInteraction,
  MessageComponentInteraction
} from 'discord.js';
import { searchYoutube } from '../../utils/youtube.js';
import type { SearchResult } from '../../utils/types.js';
import { getThumbnailUrl } from '../../utils/youtubeMusic.js';

export async function search(interaction: ChatInputCommandInteraction) {
  try {
    const query = interaction.options.getString('query', true);
    await interaction.deferReply();

    const results = await searchYoutube(query);
    if (!results || results.length === 0) {
      await interaction.editReply('No results found.');
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('Search Results')
      .setDescription('Select a song to play')
      .setColor('#FF0000')
      .setThumbnail(results[0].thumbnail);

    results.forEach((track: SearchResult, index: number) => {
      const youtubeUrl = `https://youtube.com/watch?v=${track.youtubeId}`;
      embed.addFields({
        name: `${index + 1}. ${track.title}`,
        value: `[View on YouTube](${youtubeUrl})\nDuration: ${Math.floor(track.duration / 60)}:${String(track.duration % 60).padStart(2, '0')}`
      });
    });

    const row = new ActionRowBuilder<StringSelectMenuBuilder>()
      .addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('song_select')
          .setPlaceholder('Choose a song')
          .addOptions(
            results.map((track: SearchResult) => ({
              label: track.title.substring(0, 100), // Discord has 100 char limit
              description: `Duration: ${Math.floor(track.duration / 60)}:${String(track.duration % 60).padStart(2, '0')}`,
              value: track.youtubeId
            }))
          )
      );

    const response = await interaction.editReply({
      embeds: [embed],
      components: [row]
    });

    try {
      const selectInteraction = await response.awaitMessageComponent({
        filter: (i: MessageComponentInteraction) => i.customId === 'song_select' && i.user.id === interaction.user.id,
        time: 30_000,
        componentType: ComponentType.StringSelect
      });

      if (!selectInteraction.isStringSelectMenu()) return;

      const selectedId = selectInteraction.values[0];
      await selectInteraction.deferUpdate();

      const member = interaction.member as any;
      // Play the selected track
      const track = await interaction.client.player.play(
        null, // No voice channel required
        selectedId,
        member.id,
        {
          username: member.user.username,
          discriminator: member.user.discriminator || '0',
          avatar: member.user.avatar || null
        }
      );

      await selectInteraction.editReply({
        content: `Added to queue: ${track.title}`,
        embeds: [{
          title: track.title,
          thumbnail: { url: `https://i.ytimg.com/vi/${track.youtubeId}/hqdefault.jpg` },
          footer: { 
            text: `Requested by ${member.displayName}`,
            icon_url: member.user.displayAvatarURL()
          }
        }],
        components: []
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'Time') {
        await interaction.editReply({
          content: 'Search timed out. Please try searching again.',
          embeds: [],
          components: []
        });
      } else {
        throw error;
      }
    }
  } catch (error) {
    console.error('Search command error:', error);
    const message = interaction.deferred
      ? 'An error occurred while searching.'
      : 'An error occurred while processing your request.';
    
    await (interaction.deferred ? interaction.editReply(message) : interaction.reply(message));
  }
}

function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}
