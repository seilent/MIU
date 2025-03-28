import { ChatInputCommandInteraction, GuildMember } from 'discord.js';

export async function skip(interaction: ChatInputCommandInteraction) {
  try {
    if (!interaction.guildId) {
      await interaction.reply('This command can only be used in a server.');
      return;
    }

    const currentTrack = interaction.client.player.getCurrentTrack();
    if (!currentTrack) {
      await interaction.reply('No track is currently playing.');
      return;
    }

    // Defer the reply first
    await interaction.deferReply();

    // Perform the skip operation
    await interaction.client.player.skip();

    // Edit the deferred reply with the result
    await interaction.editReply(`Skipped: ${currentTrack.title}`);
  } catch (error) {
    console.error('Skip command error:', error);
    // If we haven't replied yet, send an error reply
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply('An error occurred while skipping the track.');
    } else {
      // If we've already replied or deferred, edit the reply
      await interaction.editReply('An error occurred while skipping the track.');
    }
  }
}
