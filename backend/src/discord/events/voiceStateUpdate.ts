import { VoiceState, Client } from 'discord.js';
import { AudioPlayerStatus } from '@discordjs/voice';

export async function handleVoiceStateUpdate(
  oldState: VoiceState,
  newState: VoiceState,
  client: Client
) {
  try {
    // Check if bot was moved or disconnected
    if (oldState.member?.id === client.user?.id) {
      if (!newState.channel) {
        // Bot was disconnected, pause playback but preserve queue
        await client.player.stop(true); // Stop but preserve state
      }
      return;
    }

    // Removed auto-pause logic - keep playing music regardless of voice channel users
  } catch (error) {
    console.error('Voice state update error:', error);
  }
} 