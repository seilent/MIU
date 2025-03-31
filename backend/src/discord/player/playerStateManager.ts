import { AudioPlayerStatus } from '@discordjs/voice';
import { QueueItem, PlayerState, UserInfo } from './types.js';
import { getThumbnailUrl } from '../../utils/youtubeMusic.js';
import { broadcastPlayerState } from '../../routes/music.js'; // Import the broadcast function

export class PlayerStateManager {
  private state: PlayerState = {
    status: 'idle',
    currentTrack: null,
    queue: [],
    position: 0,
    volume: 1.0, // Initialize volume
    autoplayEnabled: true, // Initialize autoplay status
  };

  private positionUpdateInterval?: NodeJS.Timeout;
  private broadcastTimeout?: NodeJS.Timeout;
  private lastBroadcastState?: any;
  private autoplayManager?: any; // Reference to AutoplayManager

  constructor() {
    // Initial broadcast of the default state
    this.broadcastState();
  }

  // Add method to set AutoplayManager reference
  public setAutoplayManager(manager: any): void {
    this.autoplayManager = manager;
  }

  public triggerAutoplayFill(): void {
    if (this.autoplayManager && this.state.autoplayEnabled) {
      console.log('[PSM] Triggering autoplay buffer fill...');
      this.autoplayManager.ensureAutoplayBufferFilled();
    }
  }

  // --- State Getters ---

  public getState(): PlayerState {
    // Return a copy to prevent direct modification
    return { ...this.state };
  }

  public getCurrentTrack(): QueueItem | null {
    return this.state.currentTrack;
  }

  public getQueue(): QueueItem[] {
    // Return a copy
    return [...this.state.queue];
  }

  public getStatus(): 'playing' | 'paused' | 'idle' {
    return this.state.status;
  }

  public getVolume(): number {
    return this.state.volume;
  }

  public isAutoplayEnabled(): boolean {
      return this.state.autoplayEnabled;
  }

  // --- State Modifiers ---

  public setCurrentTrack(track: QueueItem | null): void {
    console.log(`[PSM] Setting current track: ${track?.title ?? 'None'}`);
    this.state.currentTrack = track;
    this.state.position = 0; // Reset position when track changes
    this.stopPositionUpdates(); // Stop updates for old track
    if (track && this.state.status === 'playing') {
      this.startPositionUpdates(); // Start updates for new track if playing
    }
    this.broadcastState();
  }

  public setQueue(queue: QueueItem[]): void {
    console.log(`[PSM] Setting queue (Length: ${queue.length})`);
    // Ensure we don't mutate the original array passed in
    this.state.queue = [...queue];
    this.broadcastState();
  }

  public updatePlayerStatus(status: 'playing' | 'paused' | 'idle'): void {
    // Skip if status hasn't changed
    if (this.state.status === status) return;

    if (process.env.NODE_ENV === 'development') {
      console.log(`[PSM] Updating player status: ${this.state.status} -> ${status}`);
    }
    
    this.state.status = status;

    if (status === 'playing' && this.state.currentTrack) {
      this.startPositionUpdates();
    } else {
      this.stopPositionUpdates();
      // Reset position if stopped/idle and not just paused
      if (status === 'idle') {
        this.state.position = 0;
      }
    }
    
    // Debounce the broadcast to prevent rapid consecutive updates
    if (this.broadcastTimeout) {
      clearTimeout(this.broadcastTimeout);
    }
    
    this.broadcastTimeout = setTimeout(() => {
      this.broadcastState();
      this.broadcastTimeout = undefined;
    }, 1000); // 1 second debounce
  }

  public setVolume(volume: number): void {
      if (this.state.volume === volume) return;
      this.state.volume = volume;
      console.log(`[PSM] Setting volume: ${volume}`);
      this.broadcastState(); // Broadcast volume change
  }

  public setAutoplay(enabled: boolean): void {
      if (this.state.autoplayEnabled === enabled) return;
      this.state.autoplayEnabled = enabled;
      console.log(`[PSM] Setting autoplay: ${enabled}`);
      this.broadcastState(); // Broadcast autoplay status change
  }

  // --- Event Handlers (Called by other components) ---

  public handleAudioPlayerStateChange(
    oldStatus: AudioPlayerStatus,
    newStatus: AudioPlayerStatus,
    track: QueueItem | undefined
  ): void {
    let appStatus: 'playing' | 'paused' | 'idle' = this.state.status;
    let stateChanged = false;

    switch (newStatus) {
      case AudioPlayerStatus.Playing:
        appStatus = 'playing';
        // Ensure the track associated with the 'playing' state is set as current
        if (track && this.state.currentTrack?.youtubeId !== track.youtubeId) {
          if (process.env.NODE_ENV === 'development') {
            console.warn(`[PSM] AudioPlayer started playing track (${track.title}) different from current state (${this.state.currentTrack?.title}). Updating state.`);
          }
          this.setCurrentTrack(track); // Update state to match player
          stateChanged = true;
        } else if (!this.state.currentTrack && track) {
          if (process.env.NODE_ENV === 'development') {
            console.warn(`[PSM] AudioPlayer started playing track (${track.title}) but state has no current track. Updating state.`);
          }
          this.setCurrentTrack(track); // Update state to match player
          stateChanged = true;
        }
        break;
      case AudioPlayerStatus.Paused:
      case AudioPlayerStatus.AutoPaused:
        appStatus = 'paused';
        break;
      case AudioPlayerStatus.Idle:
        appStatus = 'idle';
        break;
      case AudioPlayerStatus.Buffering:
        return; // No change in our simplified state
    }

    // Only update status if it actually changed
    if (appStatus !== this.state.status || stateChanged) {
      this.updatePlayerStatus(appStatus);
    }
  }

  public handleAudioPlayerError(error: Error, track: QueueItem | undefined): void {
    console.error(`[PSM] Received error for track ${track?.title ?? 'Unknown'}: ${error.message}`);
    // Optionally update state to idle or keep current state?
    // Let's assume the player will likely transition to Idle, which will be handled by stateChange.
    // We could potentially set a specific 'error' status if needed.
    // For now, just log it. The calling component should handle the skip/retry logic.
  }

  // --- Broadcasting ---

  private shouldBroadcastUpdate(newState: any): boolean {
    if (!this.lastBroadcastState) return true;

    // Check for meaningful changes
    const hasStatusChanged = newState.status !== this.lastBroadcastState.status;
    const hasTrackChanged = JSON.stringify(newState.currentTrack) !== JSON.stringify(this.lastBroadcastState.currentTrack);
    const hasQueueChanged = JSON.stringify(newState.queue) !== JSON.stringify(this.lastBroadcastState.queue);
    const hasSignificantPositionChange = Math.abs(newState.position - this.lastBroadcastState.position) >= 5;

    return hasStatusChanged || hasTrackChanged || hasQueueChanged || hasSignificantPositionChange;
  }

  private broadcastState(): void {
    // Format the state for broadcasting
    const stateToBroadcast = {
      ...this.state,
      currentTrack: this.state.currentTrack ? {
        ...this.state.currentTrack,
        thumbnail: getThumbnailUrl(this.state.currentTrack.youtubeId),
        requestedBy: this.formatRequestedBy(this.state.currentTrack.requestedBy),
      } : null,
      queue: this.state.queue.map(track => ({
        ...track,
        thumbnail: getThumbnailUrl(track.youtubeId),
        requestedBy: this.formatRequestedBy(track.requestedBy),
      })),
      position: Math.floor(this.state.position),
    };

    // Only broadcast if there are meaningful changes
    if (this.shouldBroadcastUpdate(stateToBroadcast)) {
      this.lastBroadcastState = stateToBroadcast;
      broadcastPlayerState(stateToBroadcast);
    }
  }

    // Helper to format requestedBy consistently
    private formatRequestedBy(requestedBy: any): { id: string; userId: string; username: string; avatar: string | null } {
        const userId = requestedBy?.userId || 'unknown';
        const username = requestedBy?.username || 'Unknown User';
        const avatar = requestedBy?.avatar || null;
        return {
            id: userId, // Use userId as id for consistency with frontend expectations
            userId: userId, // Keep userId for potential backward compatibility
            username: username,
            avatar: avatar,
        };
    }

  // --- Position Tracking ---

  private startPositionUpdates(): void {
    // Clear any existing interval
    this.stopPositionUpdates();

    // Update position every second but broadcast less frequently
    this.positionUpdateInterval = setInterval(() => {
      if (this.state.status === 'playing' && this.state.currentTrack) {
        this.state.position += 1;

        // Debounce the broadcast
        if (this.broadcastTimeout) {
          clearTimeout(this.broadcastTimeout);
        }
        
        this.broadcastTimeout = setTimeout(() => {
          this.broadcastState();
          this.broadcastTimeout = undefined;
        }, 1000); // Broadcast position updates every 1 second
      } else {
        this.stopPositionUpdates();
      }
    }, 1000);
  }

  private stopPositionUpdates(): void {
    if (this.positionUpdateInterval) {
      clearInterval(this.positionUpdateInterval);
      this.positionUpdateInterval = undefined;
    }
    if (this.broadcastTimeout) {
      clearTimeout(this.broadcastTimeout);
      this.broadcastTimeout = undefined;
    }
  }

  // --- Cleanup ---
  public destroy(): void {
      console.log('[PSM] Destroying PlayerStateManager...');
      this.stopPositionUpdates();
      // Clear state? Or leave as is? Let's clear it.
      this.state = {
          status: 'idle',
          currentTrack: null,
          queue: [],
          position: 0,
          volume: 1.0,
          autoplayEnabled: true,
      };
       console.log('[PSM] PlayerStateManager destroyed.');
  }
}