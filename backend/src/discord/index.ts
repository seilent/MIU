import { Client, GatewayIntentBits, Collection, ActivityType } from 'discord.js';
import { initializePlayer } from './player.js';
import { registerCommands } from './commands/index.js';
import { handleVoiceStateUpdate } from './events/voiceStateUpdate.js';
import { handleInteractionCreate } from './events/interactionCreate.js';
import { joinVoiceChannel } from '@discordjs/voice';
import { TrackingService } from '../tracking/service.js';
import { RecommendationEngine } from '../recommendation/engine.js';

declare module 'discord.js' {
  interface Client {
    player: ReturnType<typeof initializePlayer>;
    commands: Collection<string, any>;
  }
}

export async function setupDiscordBot() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  // Initialize services
  const trackingService = new TrackingService();
  const recommendationEngine = new RecommendationEngine();

  // Initialize player
  client.player = initializePlayer(client, trackingService, recommendationEngine);
  client.commands = new Collection();

  // Register commands
  await registerCommands(client);

  // Event handlers
  client.on('voiceStateUpdate', (oldState, newState) => 
    handleVoiceStateUpdate(oldState, newState, client));
  
  client.on('interactionCreate', (interaction) => 
    handleInteractionCreate(interaction, client));

  // Auto-join voice channel when ready
  client.on('ready', async () => {
    const targetChannelId = process.env.DISCORD_DEFAULT_VOICE_CHANNEL_ID;

    if (!targetChannelId) {
      console.warn('No default voice channel configured. Set DISCORD_DEFAULT_VOICE_CHANNEL_ID in .env');
      return;
    }

    const channel = client.channels.cache.get(targetChannelId);

    // Set bot status to STREAMING with the URL
    if (client.user) {
      client.user.setPresence({
        activities: [{
          name: 'https://miu.gacha.boo',
          type: ActivityType.Streaming,
          url: 'https://miu.gacha.boo'
        }],
        status: 'online'
      });

      console.log(`🤖 Bot is ready as ${client.user.tag} with STREAMING status`);

      // Initialize bot user dependent operations
      await client.player.onReady();
    }

    if (channel?.isVoiceBased()) {
      console.log('Setting up voice connection');
      const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
      });

      client.player.setConnection(connection);
      console.log(`🎵 Joined voice channel: ${channel.name}`);

      // Start autoplay after connection is established (single source of truth)
      setTimeout(async () => {
        try {
          console.log('Starting initial autoplay from centralized initialization...');
          await client.player.startInitialAutoplay();
        } catch (error) {
          console.error('Failed to start initial autoplay:', error);
        }
      }, 3000);
    } else {
      console.error('Could not find target voice channel or channel is not a voice channel');
    }
  });

  // Login
  await client.login(process.env.DISCORD_TOKEN);

  return client;
} 