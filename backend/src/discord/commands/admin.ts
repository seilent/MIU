import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { prisma } from '../../db.js';

export const data = new SlashCommandBuilder()
  .setName('admin')
  .setDescription('Admin management commands')
  .addSubcommand(subcommand =>
    subcommand
      .setName('setup')
      .setDescription('Set up initial admin role and assign to user')
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'setup') {
    // Only allow the bot owner to run this command
    const application = await interaction.client.application.fetch();
    if (interaction.user.id !== application.owner?.id) {
      await interaction.reply({
        content: 'Only the bot owner can run this command.',
        ephemeral: true
      });
      return;
    }

    try {
      // Create admin role if it doesn't exist
      let adminRole = await prisma.role.findUnique({
        where: { name: 'admin' }
      });

      if (!adminRole) {
        adminRole = await prisma.role.create({
          data: {
            name: 'admin',
            permissions: ['MANAGE_PLAYLISTS', 'MANAGE_ROLES']
          }
        });
      }

      // Get or create user
      let user = await prisma.user.findUnique({
        where: { id: interaction.user.id },
        include: { roles: true }
      });

      if (!user) {
        user = await prisma.user.create({
          data: {
            id: interaction.user.id,
            username: interaction.user.username,
            discriminator: interaction.user.discriminator || '0',
            avatar: interaction.user.avatar,
            roles: {
              connect: { id: adminRole.id }
            }
          },
          include: { roles: true }
        });
      } else if (!user.roles.some(role => role.name === 'admin')) {
        // Add admin role to existing user
        await prisma.user.update({
          where: { id: user.id },
          data: {
            roles: {
              connect: { id: adminRole.id }
            }
          }
        });
      }

      await interaction.reply({
        content: 'Admin role has been set up and assigned to you.',
        ephemeral: true
      });
    } catch (error) {
      console.error('Error setting up admin:', error);
      await interaction.reply({
        content: 'An error occurred while setting up admin role.',
        ephemeral: true
      });
    }
  }
} 