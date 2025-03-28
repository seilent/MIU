import { CommandInteraction } from 'discord.js';
import { SlashCommandBuilder } from '@discordjs/builders';
import { setRecommendationsEnabled, isRecommendationsEnabled } from '../../utils/youtubeMusic.js';

export const data = new SlashCommandBuilder()
  .setName('youtube')
  .setDescription('Admin commands for YouTube functionality')
  .setDefaultMemberPermissions('0') // Requires administrator permission
  .addSubcommand(subcommand =>
    subcommand
      .setName('recommendations')
      .setDescription('Control YouTube recommendations')
      .addStringOption(option =>
        option
          .setName('action')
          .setDescription('Enable or disable recommendations')
          .setRequired(true)
          .addChoices(
            { name: 'Enable', value: 'enable' },
            { name: 'Disable', value: 'disable' },
            { name: 'Status', value: 'status' }
          )
      )
  );

export async function execute(interaction: CommandInteraction): Promise<void> {
  if (!interaction.isChatInputCommand()) return;

  const subcommand = interaction.options.getSubcommand();
  
  if (subcommand === 'recommendations') {
    const action = interaction.options.getString('action', true);
    
    switch (action) {
      case 'enable':
        setRecommendationsEnabled(true);
        await interaction.reply({
          content: '✅ YouTube recommendations have been enabled',
          ephemeral: true
        });
        break;
        
      case 'disable':
        setRecommendationsEnabled(false);
        await interaction.reply({
          content: '🚫 YouTube recommendations have been disabled',
          ephemeral: true
        });
        break;
        
      case 'status':
        const status = isRecommendationsEnabled();
        await interaction.reply({
          content: `YouTube recommendations are currently ${status ? '✅ enabled' : '🚫 disabled'}`,
          ephemeral: true
        });
        break;
    }
  }
} 