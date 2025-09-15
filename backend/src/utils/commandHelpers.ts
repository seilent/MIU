import { ChatInputCommandInteraction, GuildMember, EmbedBuilder } from 'discord.js';
import { prisma } from '../db.js';
import logger from './logger.js';

/**
 * Centralized command utility functions
 */

export interface CommandResponse {
  success: boolean;
  message: string;
  ephemeral?: boolean;
}

/**
 * Check if user has admin permissions
 */
export async function requireAdminPermissions(interaction: ChatInputCommandInteraction): Promise<boolean> {
  const userId = interaction.user.id;
  
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { roles: true }
    });

    const isAdmin = user?.roles.some(role => role.name === 'admin') || false;
    
    if (!isAdmin) {
      await interaction.reply({
        content: 'You need admin permissions to use this command.',
        ephemeral: true
      });
      return false;
    }
    
    return true;
  } catch (error) {
    logger.error('Error checking admin permissions:', error);
    await interaction.reply({
      content: 'Error checking permissions. Please try again.',
      ephemeral: true
    });
    return false;
  }
}

/**
 * Check if user has specific role
 */
export async function hasRole(userId: string, roleName: string): Promise<boolean> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { roles: true }
    });

    return user?.roles.some(role => role.name === roleName) || false;
  } catch (error) {
    logger.error(`Error checking role ${roleName} for user ${userId}:`, error);
    return false;
  }
}

/**
 * Get user with roles
 */
export async function getUserWithRoles(userId: string) {
  try {
    return await prisma.user.findUnique({
      where: { id: userId },
      include: { roles: true }
    });
  } catch (error) {
    logger.error(`Error getting user ${userId} with roles:`, error);
    return null;
  }
}

/**
 * Safe interaction reply with error handling
 */
export async function safeReply(
  interaction: ChatInputCommandInteraction, 
  response: CommandResponse | string,
  deferred: boolean = false
): Promise<void> {
  try {
    const content = typeof response === 'string' ? response : response.message;
    const ephemeral = typeof response === 'object' ? response.ephemeral : false;

    if (deferred || interaction.deferred) {
      await interaction.editReply({ content });
    } else if (interaction.replied) {
      await interaction.followUp({ content, ephemeral });
    } else {
      await interaction.reply({ content, ephemeral });
    }
  } catch (error) {
    logger.error('Error sending interaction reply:', error);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: 'An error occurred while processing your command.',
          ephemeral: true
        });
      }
    } catch (secondError) {
      logger.error('Error sending fallback reply:', secondError);
    }
  }
}

/**
 * Safe defer reply with error handling
 */
export async function safeDeferReply(
  interaction: ChatInputCommandInteraction,
  ephemeral: boolean = false
): Promise<boolean> {
  try {
    await interaction.deferReply({ ephemeral });
    return true;
  } catch (error) {
    logger.error('Error deferring reply:', error);
    return false;
  }
}

/**
 * Validate guild context (server only command)
 */
export function requireGuild(interaction: ChatInputCommandInteraction): boolean {
  if (!interaction.guildId) {
    safeReply(interaction, {
      success: false,
      message: 'This command can only be used in a server.',
      ephemeral: true
    });
    return false;
  }
  return true;
}

/**
 * Create error embed
 */
export function createErrorEmbed(title: string, description: string): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`❌ ${title}`)
    .setDescription(description)
    .setColor(0xFF0000)
    .setTimestamp();
}

/**
 * Create success embed
 */
export function createSuccessEmbed(title: string, description: string): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`✅ ${title}`)
    .setDescription(description)
    .setColor(0x00FF00)
    .setTimestamp();
}

/**
 * Create info embed
 */
export function createInfoEmbed(title: string, description: string): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`ℹ️ ${title}`)
    .setDescription(description)
    .setColor(0x0099FF)
    .setTimestamp();
}

/**
 * Validate YouTube ID or URL format
 */
export function validateYouTubeInput(input: string): { isValid: boolean; youtubeId?: string; error?: string } {
  if (!input || typeof input !== 'string') {
    return { isValid: false, error: 'Input is required' };
  }

  // YouTube ID validation patterns
  const youtubeIdRegex = /^[a-zA-Z0-9_-]{11}$/;
  const youtubeUrlRegex = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/;

  if (youtubeIdRegex.test(input)) {
    return { isValid: true, youtubeId: input };
  }

  const urlMatch = input.match(youtubeUrlRegex);
  if (urlMatch && urlMatch[1]) {
    return { isValid: true, youtubeId: urlMatch[1] };
  }

  return { isValid: false, error: 'Invalid YouTube URL or ID format' };
}

/**
 * Format duration in seconds to human readable format
 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  
  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }
  
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  
  let result = `${hours}h`;
  if (remainingMinutes > 0) result += ` ${remainingMinutes}m`;
  if (remainingSeconds > 0) result += ` ${remainingSeconds}s`;
  
  return result;
}

/**
 * Truncate text to specified length
 */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

/**
 * Get queue position display text
 */
export function getQueuePositionText(position: number, total: number): string {
  if (total === 0) return 'Queue is empty';
  if (position === 0) return 'Currently playing';
  return `Position ${position} of ${total} in queue`;
}