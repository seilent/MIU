import { Client, GatewayIntentBits, Collection } from 'discord.js';
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
    const targetChannelId = process.env.DEFAULT_VOICE_CHANNEL_ID || '267922584123867137';
    const channel = client.channels.cache.get(targetChannelId);
    
    if (channel?.isVoiceBased()) {
      const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
      });
      
      client.player.setConnection(connection);
      console.log(`🎵 Joined voice channel: ${channel.name}`);
    } else {
      console.error('Could not find target voice channel or channel is not a voice channel');
    }
  });

  // Login
  await client.login(process.env.DISCORD_TOKEN);

  return client;
} 