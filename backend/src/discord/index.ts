import { Client, GatewayIntentBits, Collection, ActivityType } from 'discord.js';
// Updated import to use the new player structure and initialization function
import { initializeMusicPlayer, MusicPlayer } from './player/index.js';
import { registerCommands } from './commands/index.js';
import { handleVoiceStateUpdate } from './events/voiceStateUpdate.js';
import { handleInteractionCreate } from './events/interactionCreate.js';
// Keep joinVoiceChannel import if needed elsewhere, but likely not for player init
// import { joinVoiceChannel } from '@discordjs/voice';
import { TrackingService } from '../tracking/service.js';
// Remove RecommendationEngine import if it's fully replaced by the player's internal service
// import { RecommendationEngine } from '../recommendation/engine.js';

declare module 'discord.js' {
  interface Client {
    // Update type declaration to use MusicPlayer
    player: MusicPlayer;
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
  // Remove recommendationEngine instance if not needed elsewhere
  // const recommendationEngine = new RecommendationEngine();

  // Initialize player using the new function and constructor signature
  client.player = initializeMusicPlayer(client, trackingService /*, recommendationEngine */); // Pass only needed dependencies
  client.commands = new Collection();

  // Register commands
  await registerCommands(client);

  // Event handlers
  // Note: handleVoiceStateUpdate might need adjustments if it directly accessed old player properties
  client.on('voiceStateUpdate', (oldState, newState) =>
    handleVoiceStateUpdate(oldState, newState, client));

  // Note: handleInteractionCreate might need adjustments if it directly accessed old player properties/methods
  client.on('interactionCreate', (interaction) =>
    handleInteractionCreate(interaction, client));

  // Auto-join voice channel when ready - This logic is now handled by VoiceConnectionManager
  client.on('ready', async () => {
    if (!client.user) {
        console.error("Client user is not available on ready event.");
        return;
    }
    console.log(`🤖 Bot is ready as ${client.user.tag}`);

    // Set bot status
    client.user.setPresence({
      activities: [{
        name: 'https://miu.gacha.boo',
        type: ActivityType.Streaming,
        url: 'https://miu.gacha.boo'
      }],
      status: 'online'
    });
    console.log(`✨ Bot status set`);

    // --- Removed manual voice channel join and setConnection ---
    // The VoiceConnectionManager initialized within MusicPlayer now handles
    // connecting to the default voice channel automatically based on env vars.
    // --- Removed manual voice channel join and setConnection ---
  });

  // Login
  await client.login(process.env.DISCORD_TOKEN);

  return client;
}