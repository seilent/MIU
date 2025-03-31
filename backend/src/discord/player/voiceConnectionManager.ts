import { Client, VoiceState, VoiceChannel } from 'discord.js';
import {
  joinVoiceChannel,
  getVoiceConnection as getDiscordVoiceConnection, // Alias to avoid naming conflict
  VoiceConnection,
  VoiceConnectionStatus,
  entersState,
  VoiceConnectionDisconnectReason,
  DiscordGatewayAdapterCreator,
} from '@discordjs/voice';
import { PlayerStateManager } from './playerStateManager.js'; // To notify state changes
import { AudioPlaybackEngine } from './audioPlaybackEngine.js'; // To pause/resume

export class VoiceConnectionManager {
  private client: Client;
  private playerStateManager: PlayerStateManager;
  private audioPlaybackEngine: AudioPlaybackEngine; // Added dependency
  private connection?: VoiceConnection;
  private defaultVoiceChannelId: string;
  private defaultGuildId: string;
  private userCheckInterval?: NodeJS.Timeout;
  private userLeaveTimeout?: NodeJS.Timeout; // Renamed for clarity
  private hasActiveUsers: boolean = false;
  private hasWebPresence: boolean = false; // Track web presence locally
  private isManuallyPaused: boolean = false; // Track if pause was manual or automatic
  private readonly USER_LEAVE_TIMEOUT_MS = parseInt(process.env.USER_LEAVE_TIMEOUT || '10000'); // 10 seconds
  private readonly RECONNECT_DELAY_MS = 5000; // 5 seconds

  constructor(
    client: Client,
    playerStateManager: PlayerStateManager,
    audioPlaybackEngine: AudioPlaybackEngine // Inject AudioPlaybackEngine
  ) {
    this.client = client;
    this.playerStateManager = playerStateManager;
    this.audioPlaybackEngine = audioPlaybackEngine; // Store dependency

    this.defaultVoiceChannelId = process.env.DISCORD_DEFAULT_VOICE_CHANNEL_ID || '';
    this.defaultGuildId = process.env.DISCORD_DEFAULT_GUILD_ID || '';

    if (!this.defaultVoiceChannelId || !this.defaultGuildId) {
      console.warn(
        '[VCM] Voice channel configuration missing. Set DISCORD_DEFAULT_VOICE_CHANNEL_ID and DISCORD_DEFAULT_GUILD_ID in .env'
      );
    }

    // Initialize connection when client is ready
    if (this.client.isReady()) {
      this.initializeConnection();
    } else {
      this.client.once('ready', () => this.initializeConnection());
    }

    // Listen for voice state updates globally
    this.client.on('voiceStateUpdate', this.handleVoiceStateUpdate);

    // Start user presence check
    this.startUserPresenceCheck();
  }

  public getCurrentConnection(): VoiceConnection | undefined {
    return this.connection;
  }

    public getAdapterCreator(): DiscordGatewayAdapterCreator | null {
        if (!this.connection?.joinConfig.guildId) return null;
        const guild = this.client.guilds.cache.get(this.connection.joinConfig.guildId);
        return guild?.voiceAdapterCreator ?? null;
    }

  public setWebPresence(active: boolean): void {
    if (active === this.hasWebPresence) return;

    console.log(`[VCM] Web presence state change: active=${active}`);
    this.hasWebPresence = active;

    // Re-evaluate pause/resume state
    this.evaluatePlaybackState();

    // Initialize connection if needed for web users and not connected
    if (active && !this.connection) {
      console.log('[VCM] Web user active, attempting to initialize voice connection...');
      this.initializeConnection().catch(error => {
        console.error('[VCM] Failed to initialize voice connection for web presence:', error);
      });
    }
  }

  public setManualPause(paused: boolean): void {
      this.isManuallyPaused = paused;
      // If manually pausing, clear any automatic pause timeout
      if (paused && this.userLeaveTimeout) {
          clearTimeout(this.userLeaveTimeout);
          this.userLeaveTimeout = undefined;
      }
      // If manually resuming, ensure playback state is re-evaluated
      if (!paused) {
          this.evaluatePlaybackState();
      }
  }

  private async initializeConnection(): Promise<void> {
    if (!this.defaultVoiceChannelId || !this.defaultGuildId) {
      console.log('[VCM] Cannot initialize connection: Missing default channel/guild ID.');
      return;
    }

    // Check if already connected to the correct channel and state is good
    if (
      this.connection?.joinConfig.channelId === this.defaultVoiceChannelId &&
      this.connection.state.status !== VoiceConnectionStatus.Destroyed &&
      this.connection.state.status !== VoiceConnectionStatus.Disconnected
    ) {
      console.log('[VCM] Already connected to the correct voice channel.');
      return;
    }

    console.log('[VCM] Attempting to initialize voice connection...');

    try {
      const guild = await this.client.guilds.fetch(this.defaultGuildId);
      if (!guild) {
        console.error(`[VCM] Could not find guild with ID: ${this.defaultGuildId}`);
        return;
      }

      const channel = await this.client.channels.fetch(this.defaultVoiceChannelId);
      if (!channel || !channel.isVoiceBased()) {
        console.error(`[VCM] Voice channel not found or is not a voice channel: ${this.defaultVoiceChannelId}`);
        return;
      }

      // Destroy existing connection if it exists
      if (this.connection) {
        console.log('[VCM] Destroying existing connection...');
        this.connection.destroy();
        this.connection = undefined;
      }

      console.log(`[VCM] Joining voice channel: ${channel.name} (${channel.id}) in guild: ${guild.name} (${guild.id})`);

      const newConnection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: true,
        selfMute: false,
      });

      this.connection = newConnection; // Assign immediately

      // --- Configure Connection Listeners ---
      newConnection.on(VoiceConnectionStatus.Ready, () => {
        console.log(`[VCM] Voice connection Ready in channel: ${channel.name}`);
        // Subscribe the audio player when the connection is ready
        const audioPlayer = this.audioPlaybackEngine.getAudioPlayer();
        if (audioPlayer) {
            newConnection.subscribe(audioPlayer);
            console.log('[VCM] Subscribed AudioPlayer to the voice connection.');
        } else {
            console.error('[VCM] AudioPlayer not available to subscribe.');
        }
        this.checkUserPresence(); // Initial check on connect
      });

      newConnection.on(VoiceConnectionStatus.Disconnected, async (oldState, newState) => {
        console.warn(`[VCM] Voice connection Disconnected.`);
        // Check if the disconnection was recoverable
        try {
          await Promise.race([
            entersState(newConnection, VoiceConnectionStatus.Signalling, this.RECONNECT_DELAY_MS),
            entersState(newConnection, VoiceConnectionStatus.Connecting, this.RECONNECT_DELAY_MS),
          ]);
          // Connection recovered, no need to reconnect manually
          console.log('[VCM] Voice connection recovered.');
        } catch (error) {
          // Connection did not recover in time, attempt to destroy and reconnect
          console.error('[VCM] Voice connection did not recover, attempting to destroy and reconnect.');
          if (newConnection.state.status !== VoiceConnectionStatus.Destroyed) {
            newConnection.destroy();
          }
          // Only schedule reconnect if this is still the active connection
          if (this.connection === newConnection) {
              this.connection = undefined; // Clear current connection
              this.scheduleReconnect();
          }
        }
      });

      newConnection.on(VoiceConnectionStatus.Destroyed, () => {
        console.warn('[VCM] Voice connection Destroyed.');
        // If this was the active connection, clear it and schedule reconnect
        if (this.connection === newConnection) {
            this.connection = undefined;
            this.scheduleReconnect();
        }
      });

      newConnection.on('error', (error) => {
        console.error('[VCM] Voice connection error:', error);
        // Optionally attempt reconnect on error
         if (this.connection === newConnection) {
            this.connection?.destroy();
            this.connection = undefined;
            this.scheduleReconnect();
         }
      });

      // Wait for the connection to be ready before proceeding
      await entersState(newConnection, VoiceConnectionStatus.Ready, 20_000); // 20 seconds timeout

    } catch (error) {
      console.error('[VCM] Failed to initialize voice connection:', error);
      this.connection?.destroy(); // Ensure cleanup if error occurs
      this.connection = undefined;
      this.scheduleReconnect(); // Schedule a retry
    }
  }

  private scheduleReconnect(): void {
    console.log(`[VCM] Scheduling reconnect in ${this.RECONNECT_DELAY_MS / 1000} seconds...`);
    setTimeout(() => {
      if (!this.connection) { // Only reconnect if not already connected
        console.log('[VCM] Attempting scheduled reconnect...');
        this.initializeConnection();
      } else {
        console.log('[VCM] Reconnect scheduled but connection already exists. Skipping.');
      }
    }, this.RECONNECT_DELAY_MS);
  }

  private startUserPresenceCheck(): void {
    if (this.userCheckInterval) {
      clearInterval(this.userCheckInterval);
    }
    // Check every 5 seconds
    this.userCheckInterval = setInterval(() => this.checkUserPresence(), 5000);
    console.log('[VCM] Started user presence check interval.');
  }

  private async checkUserPresence(): Promise<void> {
    if (!this.connection || !this.defaultVoiceChannelId) return;

    try {
      const channel = await this.client.channels.fetch(this.defaultVoiceChannelId);
      if (!channel?.isVoiceBased()) return;

      const members = channel.members.filter(member => !member.user.bot);
      const currentlyActiveUsers = members.size > 0;

      if (currentlyActiveUsers !== this.hasActiveUsers) {
          console.log(`[VCM] User presence changed: ${this.hasActiveUsers} -> ${currentlyActiveUsers}`);
          this.hasActiveUsers = currentlyActiveUsers;
          this.evaluatePlaybackState(); // Re-evaluate pause/resume state
      }

    } catch (error) {
      console.error('[VCM] Error checking user presence:', error);
      // If channel fetch fails, assume no users for safety? Or maintain last state?
      // Let's assume no users if fetch fails to avoid playing to empty channel
      if (this.hasActiveUsers) {
          console.warn('[VCM] Assuming no active users due to channel fetch error.');
          this.hasActiveUsers = false;
          this.evaluatePlaybackState();
      }
    }
  }

  private evaluatePlaybackState(): void {
      const shouldBePlaying = this.hasActiveUsers || this.hasWebPresence;
      const isCurrentlyPlaying = this.audioPlaybackEngine.getStatus() === 'playing';
      const isCurrentlyPaused = this.audioPlaybackEngine.getStatus() === 'paused';

      console.log(`[VCM] Evaluating playback state: shouldBePlaying=${shouldBePlaying}, isPlaying=${isCurrentlyPlaying}, isPaused=${isCurrentlyPaused}, isManuallyPaused=${this.isManuallyPaused}, hasCurrentTrack=${this.audioPlaybackEngine.hasCurrentTrack()}`);

      // --- Pause Logic ---
      // If it should NOT be playing AND it IS currently playing AND it's NOT manually paused
      if (!shouldBePlaying && isCurrentlyPlaying && !this.isManuallyPaused) {
          if (!this.userLeaveTimeout) {
              console.log(`[VCM] No users/web presence detected. Starting ${this.USER_LEAVE_TIMEOUT_MS / 1000}s pause timeout.`);
              this.userLeaveTimeout = setTimeout(() => {
                   // Re-check conditions before pausing
                   const stillShouldPause = !this.hasActiveUsers && !this.hasWebPresence;
                   const stillPlaying = this.audioPlaybackEngine.getStatus() === 'playing';
                   if (stillShouldPause && stillPlaying && !this.isManuallyPaused) {
                       console.log('[VCM] Pause timeout reached. Pausing playback automatically.');
                       this.audioPlaybackEngine.pause();
                       this.playerStateManager.updatePlayerStatus('paused');
                   } else {
                       console.log('[VCM] Pause timeout reached, but conditions changed. Not pausing.');
                   }
                   this.userLeaveTimeout = undefined;
              }, this.USER_LEAVE_TIMEOUT_MS);
          } else {
              // console.log('[VCM] Pause timeout already running.'); // Optional debug log
          }
      }

      // --- Resume Logic ---
      // If it SHOULD be playing AND it is currently PAUSED AND it's NOT manually paused
      if (shouldBePlaying && isCurrentlyPaused && !this.isManuallyPaused) {
          console.log('[VCM] Users/web presence detected. Resuming playback.');
          // Clear any pending pause timeout
          if (this.userLeaveTimeout) {
              clearTimeout(this.userLeaveTimeout);
              this.userLeaveTimeout = undefined;
              console.log('[VCM] Cleared pending pause timeout.');
          }
          this.audioPlaybackEngine.resume();
          this.playerStateManager.updatePlayerStatus('playing');
      }

      // --- Clear Timeout Logic ---
      // If it SHOULD be playing and a pause timeout is running, clear the timeout
      if (shouldBePlaying && this.userLeaveTimeout) {
          console.log('[VCM] Users/web presence detected while pause timeout running. Clearing timeout.');
          clearTimeout(this.userLeaveTimeout);
          this.userLeaveTimeout = undefined;
      }
  }


  // Bound function for the event listener
  private handleVoiceStateUpdate = async (oldState: VoiceState, newState: VoiceState): Promise<void> => {
    const selfId = this.client.user?.id;
    const botMovedOut = oldState.member?.id === selfId && oldState.channelId === this.defaultVoiceChannelId && newState.channelId !== this.defaultVoiceChannelId;
    const botDisconnected = oldState.member?.id === selfId && oldState.channelId && !newState.channelId;
    const relevantChannelEvent = oldState.channelId === this.defaultVoiceChannelId || newState.channelId === this.defaultVoiceChannelId;

    // Ignore irrelevant events
    if (!selfId || (!botMovedOut && !botDisconnected && !relevantChannelEvent)) {
      return;
    }

    console.log(`[VCM] Handling voice state update for user: ${newState.member?.user.tag ?? oldState.member?.user.tag}, Channel: ${oldState.channelId} -> ${newState.channelId}`);

    // --- Bot Disconnection/Move Logic ---
    if (botMovedOut) {
      console.log('[VCM] Bot was moved from the default channel.');
      this.connection?.destroy(); // Destroy the current connection
      this.connection = undefined;
      this.scheduleReconnect(); // Attempt to rejoin the default channel
      return; // Stop further processing for this event
    }

    if (botDisconnected) {
        console.log('[VCM] Bot was disconnected from voice.');
        // Connection listener should handle this via Destroyed/Disconnected states
        // No need to explicitly stop player here, rely on connection state handling
        return;
    }

    // --- User Join/Leave Logic for the Monitored Channel ---
    if (relevantChannelEvent) {
        // Trigger presence check immediately instead of waiting for the interval
        await this.checkUserPresence();
    }
  };

  // Cleanup method
  public destroy(): void {
    console.log('[VCM] Destroying VoiceConnectionManager...');
    if (this.userCheckInterval) {
      clearInterval(this.userCheckInterval);
      this.userCheckInterval = undefined;
    }
    if (this.userLeaveTimeout) {
        clearTimeout(this.userLeaveTimeout);
        this.userLeaveTimeout = undefined;
    }
    this.client.removeListener('voiceStateUpdate', this.handleVoiceStateUpdate);
    this.connection?.destroy();
    this.connection = undefined;
    console.log('[VCM] VoiceConnectionManager destroyed.');
  }
}