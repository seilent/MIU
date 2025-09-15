import { AudioPlayer, AudioPlayerStatus, AudioResource, createAudioResource } from '@discordjs/voice';
import { TrackingService } from '../tracking/service.js';
// Local interface for QueuedTrack
interface QueuedTrack {
  youtubeId: string;
  title: string;
  thumbnail: string | null;
  duration: number;
  requestedBy?: {
    userId: string;
    username: string;
    avatar?: string;
  };
}
import { getAudioCacheWithCheck } from './cacheHelpers.js';
import { getAudioProcessingManager } from './audioProcessingManager.js';
import logger from './logger.js';

/**
 * Centralized Music Playback Manager
 * Handles all audio playback operations including resource creation, 
 * state management, and playback control
 */

export interface PlaybackState {
  isPlaying: boolean;
  isPaused: boolean;
  currentTrack: QueuedTrack | null;
  position: number;
  volume: number;
}

export interface PlaybackOptions {
  volume?: number;
  skipValidation?: boolean;
  immediate?: boolean;
}

export class PlaybackManager {
  private audioPlayer: AudioPlayer;
  private currentResource: AudioResource | null = null;
  private currentTrack: QueuedTrack | null = null;
  private volume: number = 1.0;
  private trackingService?: TrackingService;

  constructor(audioPlayer: AudioPlayer, trackingService?: TrackingService) {
    this.audioPlayer = audioPlayer;
    this.trackingService = trackingService;
    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.audioPlayer.on(AudioPlayerStatus.Playing, () => {
      logger.info('Playback started');
    });

    this.audioPlayer.on(AudioPlayerStatus.Paused, () => {
      logger.info('Playback paused');
    });

    this.audioPlayer.on(AudioPlayerStatus.Idle, () => {
      logger.info('Playback finished');
      this.currentResource = null;
    });

    this.audioPlayer.on('error', (error) => {
      logger.error('Audio player error:', error);
      this.handlePlaybackError(error);
    });
  }

  /**
   * Create audio resource for a track
   */
  async createAudioResource(youtubeId: string, options: PlaybackOptions = {}): Promise<AudioResource | null> {
    try {
      logger.info(`Creating audio resource for: ${youtubeId}`);

      // Check cache first
      const cachedAudio = await getAudioCacheWithCheck(youtubeId);
      
      let audioPath: string;
      
      if (cachedAudio) {
        logger.info(`Using cached audio for: ${youtubeId}`);
        audioPath = cachedAudio.filePath;
      } else {
        logger.info(`Processing audio for: ${youtubeId}`);
        const audioProcessingManager = getAudioProcessingManager();
        const processResult = await audioProcessingManager.processAudio(youtubeId);
        if (!processResult.success || !processResult.filePath) {
          logger.error(`Failed to process audio for: ${youtubeId}:`, processResult.error);
          return null;
        }
        audioPath = processResult.filePath;
      }

      // Create audio resource
      const resource = createAudioResource(audioPath, {
        inlineVolume: true,
        metadata: { youtubeId }
      });

      // Set volume
      if (resource.volume) {
        resource.volume.setVolume(options.volume || this.volume);
      }

      return resource;

    } catch (error) {
      logger.error(`Error creating audio resource for ${youtubeId}:`, error);
      return null;
    }
  }

  /**
   * Start playing a track
   */
  async playTrack(track: QueuedTrack, options: PlaybackOptions = {}): Promise<boolean> {
    try {
      logger.info(`Starting playback for: ${track.title} (${track.youtubeId})`);

      // Create audio resource
      const resource = await this.createAudioResource(track.youtubeId, options);
      if (!resource) {
        logger.error(`Failed to create audio resource for: ${track.youtubeId}`);
        return false;
      }

      // Start playback
      this.audioPlayer.play(resource);
      this.currentResource = resource;
      this.currentTrack = track;

      logger.info(`✓ Successfully started playback for: ${track.title}`);
      return true;

    } catch (error) {
      logger.error(`Error playing track ${track.youtubeId}:`, error);
      return false;
    }
  }

  /**
   * Stop playback
   */
  stop(): void {
    logger.info('Stopping playback');
    this.audioPlayer.stop();
    this.currentResource = null;
    this.currentTrack = null;
  }

  /**
   * Pause playback
   */
  pause(): boolean {
    if (this.audioPlayer.state.status === AudioPlayerStatus.Playing) {
      logger.info('Pausing playback');
      return this.audioPlayer.pause();
    }
    return false;
  }

  /**
   * Resume playback
   */
  resume(): boolean {
    if (this.audioPlayer.state.status === AudioPlayerStatus.Paused) {
      logger.info('Resuming playback');
      return this.audioPlayer.unpause();
    }
    return false;
  }

  /**
   * Set volume
   */
  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    
    if (this.currentResource?.volume) {
      this.currentResource.volume.setVolume(this.volume);
      logger.info(`Volume set to: ${Math.round(this.volume * 100)}%`);
    }
  }

  /**
   * Get current volume
   */
  getVolume(): number {
    return this.volume;
  }

  /**
   * Get current playback state
   */
  getPlaybackState(): PlaybackState {
    const status = this.audioPlayer.state.status;
    
    return {
      isPlaying: status === AudioPlayerStatus.Playing,
      isPaused: status === AudioPlayerStatus.Paused,
      currentTrack: this.currentTrack,
      position: this.getPosition(),
      volume: this.volume
    };
  }

  /**
   * Get current playback position in seconds
   */
  getPosition(): number {
    if (this.currentResource && 'playbackDuration' in this.currentResource) {
      return Math.floor((this.currentResource as any).playbackDuration / 1000);
    }
    return 0;
  }

  /**
   * Check if currently playing
   */
  isPlaying(): boolean {
    return this.audioPlayer.state.status === AudioPlayerStatus.Playing;
  }

  /**
   * Check if paused
   */
  isPaused(): boolean {
    return this.audioPlayer.state.status === AudioPlayerStatus.Paused;
  }

  /**
   * Check if idle (not playing anything)
   */
  isIdle(): boolean {
    return this.audioPlayer.state.status === AudioPlayerStatus.Idle;
  }

  /**
   * Get current track
   */
  getCurrentTrack(): QueuedTrack | null {
    return this.currentTrack;
  }

  /**
   * Handle playback errors
   */
  private handlePlaybackError(error: Error): void {
    logger.error('Playback error occurred:', error);
    
    // Reset state
    this.currentResource = null;
    this.currentTrack = null;
    
    // Could emit events or call callbacks here for error handling
  }

  /**
   * Prefetch audio for a track (download but don't play)
   */
  async prefetchTrack(youtubeId: string): Promise<boolean> {
    try {
      logger.info(`Prefetching audio for: ${youtubeId}`);
      
      // Check if already cached
      const cached = await getAudioCacheWithCheck(youtubeId);
      if (cached) {
        logger.info(`Track ${youtubeId} already cached`);
        return true;
      }

      // Process audio
      const audioProcessingManager = getAudioProcessingManager();
      const result = await audioProcessingManager.processAudio(youtubeId, {
        skipIfExists: true,
        priority: 'low'
      });
      if (result.success) {
        logger.info(`✓ Prefetched audio for: ${youtubeId}`);
        return true;
      }

      return false;
    } catch (error) {
      logger.error(`Error prefetching track ${youtubeId}:`, error);
      return false;
    }
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    logger.info('Destroying playback manager');
    this.stop();
    this.audioPlayer.removeAllListeners();
  }
}

/**
 * Singleton instance for global access
 */
let playbackManagerInstance: PlaybackManager | null = null;

export function getPlaybackManager(): PlaybackManager | null {
  return playbackManagerInstance;
}

export function setPlaybackManager(manager: PlaybackManager): void {
  playbackManagerInstance = manager;
}