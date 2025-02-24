import { Interaction, Client } from 'discord.js';

export async function handleInteractionCreate(
  interaction: Interaction,
  client: Client
) {
  try {
    if (!interaction.isChatInputCommand()) return;

    const command = client.commands.get(interaction.commandName);
    if (!command) {
      console.warn(`Command not found: ${interaction.commandName}`);
      return;
    }

    await command(interaction);
  } catch (error) {
    console.error('Interaction create error:', error);

    // Try to respond with error message
    try {
      const message = 'An error occurred while processing your command.';
      if (interaction.isRepliable()) {
        if (interaction.deferred) {
          await interaction.editReply(message);
        } else {
          await interaction.reply(message);
        }
      }
    } catch (replyError) {
      console.error('Failed to send error message:', replyError);
    }
  }
} 