import { VoiceState, Client } from 'discord.js';

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

    // Check if channel is empty (except for bot)
    const channel = oldState.channel || newState.channel;
    if (channel) {
      const members = channel.members.filter(member => !member.user.bot);
      if (members.size === 0) {
        // Channel is empty, pause playback but preserve queue
        await client.player.pause();
      } else if (members.size > 0 && client.player.isPaused()) {
        // Users joined and player is paused, resume playback
        await client.player.resume();
      }
    }
  } catch (error) {
    console.error('Voice state update error:', error);
  }
} 