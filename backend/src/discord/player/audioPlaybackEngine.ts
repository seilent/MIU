import {
  createAudioPlayer,
  createAudioResource,
  AudioPlayer,
  AudioPlayerStatus,
  StreamType,
  demuxProbe,
  NoSubscriberBehavior,
  AudioResource,
  VoiceConnection, // Keep VoiceConnection import if needed for subscription logic later
} from '@discordjs/voice';
import { createReadStream } from 'fs';
import fs from 'fs';
import path from 'path';
import { DatabaseService } from './databaseService.js';
import { PlayerStateManager } from './playerStateManager.js'; // To report state changes
import { QueueItem } from './types.js'; // To know what's playing

// Configure FFmpeg path (ensure this runs, maybe move to a central config later)
import ffmpeg from 'ffmpeg-static';
if (ffmpeg) {
  process.env.FFMPEG_PATH = ffmpeg as unknown as string;
  console.log('[APE] Using FFmpeg from:', ffmpeg);
} else {
  console.error('[APE] FFmpeg not found in ffmpeg-static package');
}

export class AudioPlaybackEngine {
  private audioPlayer: AudioPlayer;
  private databaseService: DatabaseService;
  private playerStateManager: PlayerStateManager;
  private currentResource?: AudioResource<QueueItem>; // Store resource with metadata
  private volume: number = 1.0; // Default volume
  private retryCount: number = 0;
  private readonly maxRetries: number = parseInt(process.env.MAX_RETRIES || '3');
  private readonly retryDelay: number = parseInt(process.env.RETRY_DELAY || '1000');

  constructor(databaseService: DatabaseService, playerStateManager: PlayerStateManager) {
    this.databaseService = databaseService;
    this.playerStateManager = playerStateManager;

    this.audioPlayer = createAudioPlayer({
      behaviors: {
        // Play even if no one is listening (important for web streaming)
        noSubscriber: NoSubscriberBehavior.Play,
      },
    });

    // --- Configure AudioPlayer Listeners ---
    this.audioPlayer.on('stateChange', (oldState, newState) => {
      console.log(`[APE] Audio player state: ${oldState.status} -> ${newState.status}`);

      // Notify PlayerStateManager about the state change
      this.playerStateManager.handleAudioPlayerStateChange(oldState.status, newState.status, this.currentResource?.metadata);

      // Reset retry count when successfully playing
      if (newState.status === AudioPlayerStatus.Playing) {
        this.retryCount = 0;
         // Apply current volume when playback starts
         if (this.currentResource?.volume) {
            this.currentResource.volume.setVolume(this.volume);
         }
      }
    });

    this.audioPlayer.on('error', (error) => {
      console.error('[APE] Audio player error:', error.message);
      const failedTrack = this.currentResource?.metadata; // Get track metadata from resource
      console.error(`[APE] Error occurred while playing track: ${failedTrack?.title ?? 'Unknown'}`);
      this.playerStateManager.handleAudioPlayerError(error, failedTrack); // Notify manager
      // Error handling (like skipping) should be managed by PlayerStateManager/main Player class
    });

    // Debugging listener (optional)
    this.audioPlayer.on('debug', (message) => {
       // console.log('[APE] Debug:', message); // Uncomment for verbose logging
    });
  }

  public getAudioPlayer(): AudioPlayer {
    return this.audioPlayer;
  }

  public async play(track: QueueItem): Promise<boolean> {
    console.log(`[APE] Attempting to play track: ${track.title} (${track.youtubeId})`);
    try {
      const resource = await this.createAudioResourceForTrack(track);
      if (!resource) {
        console.error(`[APE] Failed to create audio resource for ${track.youtubeId}`);
        return false;
      }

      this.currentResource = resource; // Store the resource with metadata
      this.currentResource.volume?.setVolume(this.volume); // Set initial volume
      this.audioPlayer.play(this.currentResource);
      console.log(`[APE] Play command issued for ${track.title}`);
      return true;
    } catch (error) {
      console.error(`[APE] Error initiating playback for ${track.youtubeId}:`, error);
      this.playerStateManager.handleAudioPlayerError(error as Error, track); // Report error
      return false;
    }
  }

  private async createAudioResourceForTrack(track: QueueItem): Promise<AudioResource<QueueItem> | null> {
    let attempt = 0;
    while (attempt <= this.maxRetries) {
      try {
        const audioCache = await this.databaseService.getAudioCache(track.youtubeId);

        if (!audioCache || !fs.existsSync(audioCache.filePath)) {
            console.warn(`[APE] Audio cache miss or file not found for ${track.youtubeId}. Attempting download...`);
            // Fetch track details to get resolved ID if needed
            const trackDetails = await this.databaseService.getTrack(track.youtubeId);
            const downloadId = trackDetails?.resolvedYtId || track.youtubeId;

             // Dynamic import for download function to avoid circular dependencies if needed
            const { downloadYoutubeAudio } = await import('../../utils/youtube.js');

            // Trigger download (using original ID for saving, resolved ID for fetching)
            const tempPath = await downloadYoutubeAudio(downloadId, trackDetails?.isMusicUrl ?? false);
            const finalPath = path.join(path.dirname(tempPath), `${track.youtubeId}${path.extname(tempPath)}`);

            // Ensure directory exists
            await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });

            // Rename temp file to final path
             try {
                await fs.promises.rename(tempPath, finalPath);
            } catch (renameError: any) {
                // Handle potential EXDEV error across different filesystems/mount points
                if (renameError.code === 'EXDEV') {
                    console.warn(`[APE] Rename failed (EXDEV), attempting copy/unlink for ${track.youtubeId}`);
                    await fs.promises.copyFile(tempPath, finalPath);
                    await fs.promises.unlink(tempPath);
                } else {
                    throw renameError; // Re-throw other errors
                }
            }

            await this.databaseService.upsertAudioCache(track.youtubeId, finalPath);
            console.log(`[APE] Download complete, cached at ${finalPath}`);

            // Re-fetch cache info after download
            const updatedCache = await this.databaseService.getAudioCache(track.youtubeId);
            if (!updatedCache || !fs.existsSync(updatedCache.filePath)) {
                 throw new Error(`Failed to get audio file even after download for: ${track.youtubeId}`);
            }
            // Use the newly downloaded file path
             return await this.createResourceFromFile(updatedCache.filePath, track);
        } else {
             // Use existing cached file
             console.log(`[APE] Using cached audio file: ${path.basename(audioCache.filePath)}`);
             return await this.createResourceFromFile(audioCache.filePath, track);
        }

      } catch (error) {
        console.error(`[APE] Attempt ${attempt + 1}/${this.maxRetries + 1} failed to get/create resource for ${track.youtubeId}:`, error);
        attempt++;
        if (attempt <= this.maxRetries) {
          console.log(`[APE] Retrying in ${this.retryDelay}ms...`);
          await new Promise(resolve => setTimeout(resolve, this.retryDelay));
        } else {
          console.error(`[APE] All attempts failed for ${track.youtubeId}`);
          return null; // Failed after all retries
        }
      }
    }
    return null; // Should not be reached, but satisfies TS
  }

    private async createResourceFromFile(filePath: string, trackMetadata: QueueItem): Promise<AudioResource<QueueItem>> {
        const stream = createReadStream(filePath);
        // Use demuxProbe to determine the input type
        const { stream: probedStream, type } = await demuxProbe(stream);
        console.log(`[APE] Creating AudioResource with type: ${type}`);
        return createAudioResource(probedStream, {
            inputType: type,
            inlineVolume: true, // Enable inline volume control
            metadata: trackMetadata // Attach track metadata to the resource
        });
    }

  public pause(): boolean {
    if (this.audioPlayer.state.status === AudioPlayerStatus.Playing) {
      const success = this.audioPlayer.pause();
      console.log(`[APE] Pause command issued. Success: ${success}`);
      return success;
    }
    console.log('[APE] Cannot pause, player not playing.');
    return false;
  }

  public resume(): boolean {
    if (this.audioPlayer.state.status === AudioPlayerStatus.Paused) {
      const success = this.audioPlayer.unpause();
      console.log(`[APE] Resume command issued. Success: ${success}`);
      return success;
    }
    console.log('[APE] Cannot resume, player not paused.');
    return false;
  }

  public stop(force: boolean = false): void {
    console.log(`[APE] Stop command issued (force=${force})`);
    this.audioPlayer.stop(force);
    this.currentResource = undefined; // Clear current resource on stop
  }

  public setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume)); // Clamp volume between 0 and 1
    console.log(`[APE] Setting volume to ${this.volume}`);
    // Apply volume to the current resource if it exists and supports inline volume
    if (this.currentResource?.volume) {
      this.currentResource.volume.setVolume(this.volume);
      console.log('[APE] Applied volume to current resource.');
    } else if (this.audioPlayer.state.status === AudioPlayerStatus.Playing) {
        console.warn('[APE] Could not set volume: Current resource missing or does not support inline volume.');
    }
  }

  public getVolume(): number {
    return this.volume;
  }

  public getStatus(): AudioPlayerStatus {
    return this.audioPlayer.state.status;
  }

  public getPlaybackDuration(): number {
    if (
      this.audioPlayer.state.status === AudioPlayerStatus.Playing ||
      this.audioPlayer.state.status === AudioPlayerStatus.Paused
    ) {
      // Ensure the resource exists before accessing playbackDuration
      return this.currentResource?.playbackDuration ?? 0;
    }
    return 0;
  }

   public hasCurrentTrack(): boolean {
    return !!this.currentResource;
  }

  // Cleanup method
  public destroy(): void {
    console.log('[APE] Destroying AudioPlaybackEngine...');
    // Stop the player before destroying listeners might be safer
    if (this.audioPlayer.state.status !== AudioPlayerStatus.Idle) {
        this.audioPlayer.stop(true);
    }
    // Remove all listeners to prevent memory leaks
    this.audioPlayer.removeAllListeners();
    // Note: The AudioPlayer itself doesn't have a destroy method.
    // Garbage collection should handle it once references are gone.
    console.log('[APE] AudioPlaybackEngine destroyed.');
  }
}