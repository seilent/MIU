import { VoiceState, Client } from 'discord.js';
import { AudioPlayerStatus } from '@discordjs/voice';

export async function handleVoiceStateUpdate(
  oldState: VoiceState,
  newState: VoiceState,
  client: Client // Client already includes the player property due to declaration merging
) {
  try {
    // Check if bot was moved or disconnected
    if (oldState.member?.id === client.user?.id) {
      if (!newState.channel) {
        // Bot was disconnected. VoiceConnectionManager handles state and reconnection attempt.
        console.log('[Event:VoiceStateUpdate] Bot disconnected from voice channel.');
      } else if (newState.channelId !== oldState.channelId) {
          // Bot was moved. VoiceConnectionManager handles rejoining the default channel if necessary.
          console.log(`[Event:VoiceStateUpdate] Bot moved from ${oldState.channelId} to ${newState.channelId}.`);
      }
      // No direct player action needed here; VCM manages connection state.
      return;
    }

    // User join/leave events in the bot's channel are handled by VoiceConnectionManager's
    // internal presence check, which is triggered by this event.
    // No specific pause/resume logic needed directly in this handler anymore.

  } catch (error) {
    console.error('Voice state update error:', error);
  }
}