import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { TrackingService } from '../../tracking/service.js';
import { 
  banTrack, 
  blockSeedRecommendationsFunc, 
  BanOptions,
  getChannelInfoFromVideo 
} from '../../utils/banManager.js';
import { 
  requireAdminPermissions, 
  safeDeferReply, 
  safeReply, 
  requireGuild,
  validateYouTubeInput
} from '../../utils/commandHelpers.js';
import { blockChannelById } from '../../utils/channelBlocking.js';
import { getYoutubeId } from '../../utils/youtube.js';
import logger from '../../utils/logger.js';

export const data = new SlashCommandBuilder()
  .setName('ban')
  .setDescription('Ban tracks, channels, or recommendations')
  .setDefaultMemberPermissions('0')
  .addSubcommand(subcommand =>
    subcommand
      .setName('track')
      .setDescription('Ban a track in the queue by position')
      .addIntegerOption(option =>
        option
          .setName('position')
          .setDescription('Position in queue (1-based)')
          .setRequired(true)
          .setMinValue(1)
      )
      .addBooleanOption(option =>
        option
          .setName('block_channel')
          .setDescription('Also block the entire channel')
          .setRequired(false)
      )
      .addBooleanOption(option =>
        option
          .setName('block_recommendations')
          .setDescription('Also block tracks recommended from this one')
          .setRequired(false)
      )
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('id')
      .setDescription('Ban a track by YouTube ID/URL')
      .addStringOption(option =>
        option
          .setName('youtube_id')
          .setDescription('YouTube video ID or URL')
          .setRequired(true)
      )
      .addBooleanOption(option =>
        option
          .setName('block_channel')
          .setDescription('Also block the entire channel')
          .setRequired(false)
      )
      .addBooleanOption(option =>
        option
          .setName('block_recommendations')
          .setDescription('Also block tracks recommended from this one')
          .setRequired(false)
      )
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('channel')
      .setDescription('Block an entire channel by ID')
      .addStringOption(option =>
        option
          .setName('channel_id')
          .setDescription('YouTube channel ID')
          .setRequired(true)
      )
      .addStringOption(option =>
        option
          .setName('reason')
          .setDescription('Reason for blocking')
          .setRequired(false)
      )
  );

export async function ban(interaction: ChatInputCommandInteraction) {
  try {
    // Check permissions and guild context
    if (!await requireAdminPermissions(interaction)) return;
    if (!requireGuild(interaction)) return;

    // Defer reply to give us time to process
    if (!await safeDeferReply(interaction)) return;

    const subcommand = interaction.options.getSubcommand();
    const player = interaction.client.player;
    const trackingService = new TrackingService();

    switch (subcommand) {
      case 'track': {
        await handleTrackBan(interaction, player, trackingService);
        break;
      }
      case 'id': {
        await handleIdBan(interaction, trackingService);
        break;
      }
      case 'channel': {
        await handleChannelBan(interaction);
        break;
      }
      default: {
        await safeReply(interaction, 'Invalid subcommand. Use /ban track, /ban id, or /ban channel.', true);
      }
    }
  } catch (error) {
    logger.error('Error in ban command:', error);
    await safeReply(interaction, 'An error occurred while processing the ban command.', true);
  }
}

async function handleTrackBan(interaction: ChatInputCommandInteraction, player: any, trackingService: TrackingService) {
  const uiPosition = interaction.options.getInteger('position', true);
  const blockChannel = interaction.options.getBoolean('block_channel') ?? false;
  const blockRecommendations = interaction.options.getBoolean('block_recommendations') ?? false;

  // Convert UI position (1-based) to array index (0-based)
  const position = uiPosition - 1;
  
  // Get queue and validate position
  const queue = player.getQueue();
  if (position < 0 || position >= queue.length) {
    await safeReply(interaction, `Invalid position. Queue has ${queue.length} songs (positions 1-${queue.length}).`, true);
    return;
  }
  
  const trackToBan = queue[position];
  
  // Ban the track with options
  const options: BanOptions = {
    reason: 'Banned from queue position',
    blockChannel,
    blockSeedRecommendations: blockRecommendations
  };

  const result = await banTrack(trackToBan.youtubeId, options, trackingService);
  
  // If this was the currently playing track, skip it
  const currentTrack = player.getCurrentTrack();
  if (currentTrack && currentTrack.youtubeId === trackToBan.youtubeId) {
    await player.skip();
  }

  const message = `**Banned track at position ${uiPosition}**\n${result.message}`;
  await safeReply(interaction, message, true);
}

async function handleIdBan(interaction: ChatInputCommandInteraction, trackingService: TrackingService) {
  const input = interaction.options.getString('youtube_id', true);
  const blockChannel = interaction.options.getBoolean('block_channel') ?? false;
  const blockRecommendations = interaction.options.getBoolean('block_recommendations') ?? false;

  // Validate and extract YouTube ID
  const validation = validateYouTubeInput(input);
  if (!validation.isValid) {
    await safeReply(interaction, `❌ ${validation.error}`, true);
    return;
  }

  const youtubeId = validation.youtubeId!;
  
  // Ban the track with options
  const options: BanOptions = {
    reason: 'Banned by ID',
    blockChannel,
    blockSeedRecommendations: blockRecommendations
  };

  const result = await banTrack(youtubeId, options, trackingService);
  
  const message = result.success 
    ? `**✅ Ban Successful**\n${result.message}`
    : `**❌ Ban Failed**\n${result.message}`;
  
  await safeReply(interaction, message, true);
}

async function handleChannelBan(interaction: ChatInputCommandInteraction) {
  const channelId = interaction.options.getString('channel_id', true);
  const reason = interaction.options.getString('reason') ?? 'Manual channel block';

  try {
    const result = await blockChannelById(channelId, reason);
    
    const message = `**✅ Channel Blocked**\nBlocked channel "${result.channelTitle}" with ${result.tracksBlocked} tracks.`;
    await safeReply(interaction, message, true);
    
  } catch (error) {
    logger.error(`Error blocking channel ${channelId}:`, error);
    await safeReply(interaction, `❌ Failed to block channel: ${error instanceof Error ? error.message : 'Unknown error'}`, true);
  }
}

// Additional utility functions for the unban command
export const unbanData = new SlashCommandBuilder()
  .setName('unban')
  .setDescription('Remove ban from tracks or channels')
  .setDefaultMemberPermissions('0')
  .addSubcommand(subcommand =>
    subcommand
      .setName('track')
      .setDescription('Unban a track by YouTube ID/URL')
      .addStringOption(option =>
        option
          .setName('youtube_id')
          .setDescription('YouTube video ID or URL')
          .setRequired(true)
      )
  );

export async function unban(interaction: ChatInputCommandInteraction) {
  try {
    if (!await requireAdminPermissions(interaction)) return;
    if (!requireGuild(interaction)) return;
    if (!await safeDeferReply(interaction)) return;

    const subcommand = interaction.options.getSubcommand();
    
    if (subcommand === 'track') {
      const input = interaction.options.getString('youtube_id', true);
      
      const validation = validateYouTubeInput(input);
      if (!validation.isValid) {
        await safeReply(interaction, `❌ ${validation.error}`, true);
        return;
      }

      const { unbanTrack } = await import('../../utils/banManager.js');
      const result = await unbanTrack(validation.youtubeId!);
      
      const message = result.success 
        ? `**✅ Unban Successful**\n${result.message}`
        : `**❌ Unban Failed**\n${result.message}`;
      
      await safeReply(interaction, message, true);
    }
  } catch (error) {
    logger.error('Error in unban command:', error);
    await safeReply(interaction, 'An error occurred while processing the unban command.', true);
  }
}