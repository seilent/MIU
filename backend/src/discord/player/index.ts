import { Client, VoiceState } from 'discord.js';
import { AudioPlayerStatus } from '@discordjs/voice';
import fs from 'fs';

// Import all the refactored modules
import { DatabaseService } from './databaseService.js';
import { VoiceConnectionManager } from './voiceConnectionManager.js';
import { AudioPlaybackEngine } from './audioPlaybackEngine.js';
import { PlayerStateManager } from './playerStateManager.js';
import { TrackQueue } from './trackQueue.js';
import { CacheManager } from './cacheManager.js';
import { BlockedContentManager } from './blockedContentManager.js';
import { AutoplayManager } from './autoplayManager.js';
import { PlaylistManager } from './playlistManager.js';
import { RecommendationService } from './recommendationService.js';
import { AudioStreamManager } from './audioStreamManager.js';
import { QueueItem, UserInfo, PlayerState, Track, QueuedTrackInfo } from './types.js';
import { TrackingService } from '../../tracking/service.js'; // Import original TrackingService if needed
import { RecommendationEngine } from '../../recommendation/engine.js'; // Import original RecommendationEngine if needed
import { getYoutubeInfo, getYoutubeId } from '../../utils/youtube.js';
import { getThumbnailUrl, resolveYouTubeMusicId } from '../../utils/youtubeMusic.js';
import { RequestStatus, TrackStatus } from '../../types/enums.js';
import { addToHistory } from '../../routes/music.js';
import { TrackProcessor } from './trackProcessor.js';


// Singleton instance holder
let instance: MusicPlayer | null = null;

export class MusicPlayer {
    private client: Client;
    private databaseService: DatabaseService;
    private voiceConnectionManager: VoiceConnectionManager;
    private audioPlaybackEngine: AudioPlaybackEngine;
    private playerStateManager: PlayerStateManager;
    private trackQueue: TrackQueue;
    private cacheManager: CacheManager;
    private blockedContentManager: BlockedContentManager;
    private autoplayManager: AutoplayManager;
    private playlistManager: PlaylistManager;
    private recommendationService: RecommendationService;
    private audioStreamManager: AudioStreamManager;
    private trackProcessor: TrackProcessor;

    // Dependencies from the original constructor - pass them through or integrate their logic
    private trackingService: TrackingService;
    // private recommendationEngine: RecommendationEngine; // Original engine, might be replaced by RecommendationService

    private isInitialized: boolean = false;

    constructor(
        client: Client,
        trackingService: TrackingService
    ) {
        console.log('[MusicPlayer] Creating singleton instance...');
        this.client = client;
        this.trackingService = trackingService;
        this.isInitialized = false;

        // Initialize services and managers
        console.log('[MusicPlayer] Initializing...');
        this.databaseService = new DatabaseService();
        this.playerStateManager = new PlayerStateManager();
        this.cacheManager = new CacheManager(this.databaseService);
        this.blockedContentManager = new BlockedContentManager(this.databaseService);
        this.playlistManager = new PlaylistManager(this.databaseService);
        this.recommendationService = new RecommendationService(this.databaseService);
        this.trackQueue = new TrackQueue(this.databaseService, this.playerStateManager, this.cacheManager, this.blockedContentManager);
        this.audioPlaybackEngine = new AudioPlaybackEngine(this.databaseService, this.playerStateManager);
        this.voiceConnectionManager = new VoiceConnectionManager(this.client, this.playerStateManager, this.audioPlaybackEngine);
        this.autoplayManager = new AutoplayManager(
            this.databaseService,
            this.trackQueue,
            this.playerStateManager,
            this.blockedContentManager,
            this.playlistManager,
            this.recommendationService,
            this.client
        );
        this.audioStreamManager = new AudioStreamManager(this.playerStateManager, this.cacheManager);
        this.trackProcessor = new TrackProcessor(this.databaseService);

        // Set AutoplayManager reference in PlayerStateManager
        this.playerStateManager.setAutoplayManager(this.autoplayManager);

        // Setup event handlers
        this.setupEventHandlers();

        // Wait for client to be ready before initializing
        if (this.client.isReady()) {
            this.initialize().catch(error => {
                console.error('[MusicPlayer] Initialization failed:', error);
            });
        } else {
            this.client.once('ready', () => {
                this.initialize().catch(error => {
                    console.error('[MusicPlayer] Initialization failed:', error);
                });
            });
        }

        console.log('[MusicPlayer] Initialization sequence started.');
    }

    private async initialize(): Promise<void> {
        if (!this.client.isReady() || !this.client.user) {
            throw new Error('Cannot initialize MusicPlayer: Discord client is not ready');
        }

        await this.databaseService.ensureUserExists({
            id: this.client.user.id,
            username: this.client.user.username,
            discriminator: this.client.user.discriminator,
            avatar: this.client.user.avatar,
        });
        await this.databaseService.cleanupStuckRequests(); // Clean up DB state
        // Voice connection is initialized by its manager constructor
        this.isInitialized = true;
        console.log('[MusicPlayer] Core initialization complete.');
    }

    private setupEventHandlers(): void {
        console.log('[MusicPlayer] Setting up event handlers...');
        // Listen to state changes from the PlayerStateManager
        // This requires PlayerStateManager to emit events or have a subscription mechanism.
        // --- Placeholder for event subscription ---
        // this.playerStateManager.on('statusChange', this.handleStatusChange);
        // this.playerStateManager.on('trackEnd', this.handleTrackEnd);
        // this.playerStateManager.on('error', this.handlePlayerError);

        // For now, use the AudioPlayer's events directly as PlayerStateManager forwards them
         this.audioPlaybackEngine.getAudioPlayer().on('stateChange', async (oldState, newState) => {
             if (newState.status === AudioPlayerStatus.Idle && oldState.status !== AudioPlayerStatus.Idle) {
                 await this.handleTrackEnd();
             }
             // PlayerStateManager already handles broadcasting the state change
         });

         this.audioPlaybackEngine.getAudioPlayer().on('error', (error) => {
              this.handlePlayerError(error);
         });

        console.log('[MusicPlayer] Event handlers setup complete.');
    }

    // --- Public API ---

    /**
     * Handles a user request to play a track.
     * Resolves YT Music URLs, fetches info, ensures user/track/channel exist,
     * adds to queue, and starts playback if idle.
     */
    async play(voiceState: VoiceState | null, youtubeUrlOrId: string, userId: string, userInfo: Omit<UserInfo, 'id'>, isMusicUrl: boolean = false): Promise<{ success: boolean; message: string; trackInfo?: QueuedTrackInfo }> {
        if (!this.isInitialized) return { success: false, message: 'Player not yet initialized.' };

        try {
            // Process the track using TrackProcessor
            const processResult = await this.trackProcessor.processTrack(youtubeUrlOrId, isMusicUrl);
            if (!processResult.success || !processResult.videoId || !processResult.trackInfo) {
                return { success: false, message: processResult.message };
            }

            const { videoId, trackInfo } = processResult;

            // Create queue item
            const queueItem = this.trackProcessor.createQueueItem(videoId, trackInfo, { userId, ...userInfo });

            // Add to queue based on current state
            const isPlaying = this.playerStateManager.getStatus() === 'playing';
            const isQueueEmpty = this.trackQueue.getLength() === 0;
            const willPlayNext = !isPlaying && isQueueEmpty;
            
            let addResult;
            if (willPlayNext) {
                addResult = await this.trackQueue.addTrack(queueItem);
            } else {
                addResult = await this.trackQueue.addTrack(queueItem);
            }

            if (!addResult.success) {
                return { success: false, message: addResult.reason || 'Failed to add track to queue.' };
            }

            // Start playback if needed
            if (willPlayNext) {
                await this.playNextTrack();
            }

            const responseTrackInfo: QueuedTrackInfo = {
                youtubeId: videoId,
                title: trackInfo.title,
                thumbnail: getThumbnailUrl(videoId),
                duration: trackInfo.duration,
                requestedBy: queueItem.requestedBy,
                queuePosition: addResult.position,
                willPlayNext,
                isPlaying: willPlayNext && this.playerStateManager.getStatus() === 'playing'
            };

            return {
                success: true,
                message: `Track "${responseTrackInfo.title}" added to queue${isPlaying ? ' and is now playing' : (willPlayNext ? ' and will play next' : ` at position ${responseTrackInfo.queuePosition ?? 'N/A'}`)}.`,
                trackInfo: responseTrackInfo
            };

        } catch (error: any) {
            console.error('[MusicPlayer] Error during play request:', error);
            return { success: false, message: `An error occurred: ${error.message}` };
        }
    }

    /** Skips the current track. */
    async skip(userId?: string): Promise<{ success: boolean; message: string }> {
        if (!this.isInitialized) return { success: false, message: 'Player not yet initialized.' };
        const currentTrack = this.playerStateManager.getCurrentTrack();
        if (!currentTrack) {
            return { success: false, message: 'Nothing is currently playing.' };
        }

        console.log(`[MusicPlayer] Skip requested for "${currentTrack.title}" by User ${userId || 'System'}`);

        try {
            // Update skip count in DB (fire and forget)
            this.databaseService.incrementTrackSkipCount(currentTrack.youtubeId).catch(err => {
                 console.error(`[MusicPlayer] Failed to increment skip count for ${currentTrack.youtubeId}:`, err);
            });

             // Update request status
             await this.databaseService.updateRequestStatus(currentTrack.youtubeId, currentTrack.requestedAt, RequestStatus.SKIPPED);

             // Add to history as skipped - remove 4th argument
             addToHistory(currentTrack, currentTrack.requestedBy, currentTrack.isAutoplay);

             // Add to autoplay cooldown
             this.autoplayManager.addTrackToCooldown(currentTrack.youtubeId);

            // Stop the audio player, which will trigger the 'idle' state change
            this.audioPlaybackEngine.stop();
            // The 'idle' state handler (handleTrackEnd) will call playNextTrack

            return { success: true, message: `Skipped "${currentTrack.title}".` };
        } catch (error: any) {
            console.error('[MusicPlayer] Error skipping track:', error);
            return { success: false, message: `An error occurred while skipping: ${error.message}` };
        }
    }

    /** Pauses playback. */
    pause(): { success: boolean; message: string } {
        if (!this.isInitialized) return { success: false, message: 'Player not yet initialized.' };
        if (this.playerStateManager.getStatus() !== 'playing') {
            return { success: false, message: 'Player is not currently playing.' };
        }
        const success = this.audioPlaybackEngine.pause();
        if (success) {
             this.voiceConnectionManager.setManualPause(true); // Inform VCM about manual pause
            return { success: true, message: 'Playback paused.' };
        } else {
            return { success: false, message: 'Failed to pause playback.' };
        }
    }

    /** Resumes playback. */
    resume(): { success: boolean; message: string } {
        if (!this.isInitialized) return { success: false, message: 'Player not yet initialized.' };
         if (this.playerStateManager.getStatus() !== 'paused') {
            return { success: false, message: 'Player is not currently paused.' };
        }
         this.voiceConnectionManager.setManualPause(false); // Inform VCM about manual resume attempt
        const success = this.audioPlaybackEngine.resume();
        if (success) {
            return { success: true, message: 'Playback resumed.' };
        } else {
            return { success: false, message: 'Failed to resume playback.' };
        }
    }

    /** Sets the player volume. */
    setVolume(volume: number): { success: boolean; message: string } {
        if (!this.isInitialized) return { success: false, message: 'Player not yet initialized.' };
        const clampedVolume = Math.max(0, Math.min(1, volume)); // Clamp 0-1
        this.audioPlaybackEngine.setVolume(clampedVolume);
        this.playerStateManager.setVolume(clampedVolume); // Update state
        return { success: true, message: `Volume set to ${Math.round(clampedVolume * 100)}%.` };
    }

    /** Gets the current player state. */
    getState(): PlayerState | null {
        if (!this.isInitialized) return null;
        return this.playerStateManager.getState();
    }

     /** Gets the current playback position in seconds. */
     getPosition(): number {
         if (!this.isInitialized) return 0;
         // Get position from audio engine, convert ms to s
         return this.audioPlaybackEngine.getPlaybackDuration() / 1000;
     }

     /** Gets the current track queue. */
     getQueue(): QueueItem[] {
         if (!this.isInitialized) return [];
         return this.playerStateManager.getQueue();
     }

     /** Gets the currently playing track. */
     getCurrentTrack(): QueueItem | null {
         if (!this.isInitialized) return null;
         return this.playerStateManager.getCurrentTrack();
     }

     /** Gets the current player status ('playing', 'paused', 'idle'). */
     getStatus(): 'playing' | 'paused' | 'idle' {
         if (!this.isInitialized) return 'idle';
         return this.playerStateManager.getStatus();
     }


     /** Sets the autoplay state. */
     setAutoplay(enabled: boolean): { success: boolean; message: string } {
         if (!this.isInitialized) return { success: false, message: 'Player not yet initialized.' };
         this.playerStateManager.setAutoplay(enabled);
         if (enabled && this.playerStateManager.getStatus() === 'idle') {
             // If enabling autoplay and player is idle, try to start playing immediately
             this.playNextTrack();
         }
         return { success: true, message: `Autoplay ${enabled ? 'enabled' : 'disabled'}.` };
     }

     /** Removes a track from the queue by its 1-based position. */
     removeFromQueue(position: number): { success: boolean; message: string } {
         if (!this.isInitialized) return { success: false, message: 'Player not yet initialized.' };
         const zeroBasedPosition = position - 1;
         const removedTrack = this.trackQueue.removeTrackAt(zeroBasedPosition);
         if (removedTrack) {
              // Update request status to skipped? Or just remove? Let's mark as skipped.
              this.databaseService.updateRequestStatus(removedTrack.youtubeId, removedTrack.requestedAt, RequestStatus.SKIPPED)
                  .catch(err => console.error(`[MusicPlayer] Failed to update status for removed queue item ${removedTrack.youtubeId}:`, err));
             return { success: true, message: `Removed "${removedTrack.title}" from the queue.` };
         } else {
             return { success: false, message: 'Invalid queue position.' };
         }
     }

     /** Clears the user and autoplay queues. */
     clearQueue(): { success: boolean; message: string } {
         if (!this.isInitialized) return { success: false, message: 'Player not yet initialized.' };
         const currentQueue = this.trackQueue.getCombinedQueue();
         this.trackQueue.clearQueue();
         // Mark all removed requests as skipped
         currentQueue.forEach(track => {
             this.databaseService.updateRequestStatus(track.youtubeId, track.requestedAt, RequestStatus.SKIPPED)
                 .catch(err => console.error(`[MusicPlayer] Failed to update status for cleared queue item ${track.youtubeId}:`, err));
         });
         return { success: true, message: 'Queue cleared.' };
     }

     /** Registers a web client for audio streaming. */
     addAudioStreamClient(clientId: string, stream: NodeJS.WritableStream): void {
         if (!this.isInitialized) return;
         this.audioStreamManager.addClientStream(clientId, stream);
     }

     /** Unregisters a web client for audio streaming. */
     removeAudioStreamClient(clientId: string): void {
         if (!this.isInitialized) return;
         this.audioStreamManager.removeClientStream(clientId);
     }

     /** Proxy method to set web presence via VoiceConnectionManager */
     setWebPresence(active: boolean): void {
         if (!this.isInitialized) return;
         this.voiceConnectionManager.setWebPresence(active);
     }

     /** Proxy method to reset recommendation pool via RecommendationService */
     async resetRecommendationsPool(): Promise<void> {
        if (!this.isInitialized) return;
        await this.recommendationService.resetRecommendationsPool(); // Added await
     }

    // --- Internal Logic ---

    /** Plays the next track from the queue or autoplay. */
    private async playNextTrack(): Promise<void> {
        console.log('[MusicPlayer] Attempting to play next track...');
        const nextTrack = this.trackQueue.getNextTrack();

        if (nextTrack) {
            console.log(`[MusicPlayer] Next track selected: ${nextTrack.title} (Autoplay: ${nextTrack.isAutoplay})`);

            // Add to cooldown if it came from autoplay
             if (nextTrack.isAutoplay) {
                 this.autoplayManager.addTrackToCooldown(nextTrack.youtubeId);
             }

             // Update DB status before playing
             await this.databaseService.updateTrackStatus(nextTrack.youtubeId, TrackStatus.PLAYING);
             await this.databaseService.updateRequestStatus(nextTrack.youtubeId, nextTrack.requestedAt, RequestStatus.PLAYING, new Date());


            // Set as current track in state *before* telling engine to play
            this.playerStateManager.setCurrentTrack(nextTrack);

            // Tell the engine to play
            const success = await this.audioPlaybackEngine.play(nextTrack);
            if (!success) {
                console.error(`[MusicPlayer] AudioPlaybackEngine failed to play ${nextTrack.title}. Skipping.`);
                 // Mark request as skipped/errored?
                 await this.databaseService.updateRequestStatus(nextTrack.youtubeId, nextTrack.requestedAt, RequestStatus.SKIPPED);
                 await this.databaseService.updateTrackStatus(nextTrack.youtubeId, TrackStatus.STANDBY); // Reset track status
                 this.playerStateManager.setCurrentTrack(null); // Clear from state
                // Try playing the *next* track after failure
                await this.playNextTrack();
            } else {
                 // Increment play count (fire and forget)
                 this.databaseService.incrementTrackPlayCount(nextTrack.youtubeId).catch(err => {
                     console.error(`[MusicPlayer] Failed to increment play count for ${nextTrack.youtubeId}:`, err);
                 });
            }
        } else {
            console.log('[MusicPlayer] Queue is empty.');
            this.playerStateManager.setCurrentTrack(null); // Ensure current track is null
            this.playerStateManager.updatePlayerStatus('idle'); // Ensure state is idle

            // If autoplay is enabled, trigger buffer fill check
            if (this.playerStateManager.isAutoplayEnabled()) {
                console.log('[MusicPlayer] Queue empty, ensuring autoplay buffer is filled...');
                this.autoplayManager.ensureAutoplayBufferFilled(); // Trigger background fill
            }
        }
    }

    /** Handles the event when a track finishes playing naturally. */
    private async handleTrackEnd(): Promise<void> {
         const finishedTrack = this.playerStateManager.getCurrentTrack(); // Get track that just finished
         console.log(`[MusicPlayer] Track finished: ${finishedTrack?.title ?? 'Unknown'}`);

         if (finishedTrack) {
             // Update DB status
             await this.databaseService.updateTrackStatus(finishedTrack.youtubeId, TrackStatus.STANDBY);
             await this.databaseService.updateRequestStatus(finishedTrack.youtubeId, finishedTrack.requestedAt, RequestStatus.COMPLETED);

             // Add to history - remove 4th argument
             addToHistory(finishedTrack, finishedTrack.requestedBy, finishedTrack.isAutoplay);

             // Add to autoplay cooldown (even if user-requested, prevents immediate autoplay repeat)
             this.autoplayManager.addTrackToCooldown(finishedTrack.youtubeId);

             // TODO: Update user stats via TrackingService
             // Example: this.trackingService.trackPlaybackComplete(userId, finishedTrack.youtubeId, finishedTrack.duration);
         }

         // Play the next track
         await this.playNextTrack();
    }

    /** Handles errors from the AudioPlaybackEngine. */
    private handlePlayerError(error: Error): void {
        const erroredTrack = this.playerStateManager.getCurrentTrack();
        console.error(`[MusicPlayer] Player error occurred for track ${erroredTrack?.title ?? 'Unknown'}:`, error);

         if (erroredTrack) {
             // Mark request as skipped/errored
             this.databaseService.updateRequestStatus(erroredTrack.youtubeId, erroredTrack.requestedAt, RequestStatus.SKIPPED)
                  .catch(err => console.error(`[MusicPlayer] Failed to update status for errored track ${erroredTrack.youtubeId}:`, err));
             // Reset track status
             this.databaseService.updateTrackStatus(erroredTrack.youtubeId, TrackStatus.STANDBY)
                   .catch(err => console.error(`[MusicPlayer] Failed to reset status for errored track ${erroredTrack.youtubeId}:`, err));
             // Add to cooldown
             this.autoplayManager.addTrackToCooldown(erroredTrack.youtubeId);
         }

        // Attempt to play the next track to recover
        this.playNextTrack().catch(playError => {
             console.error("[MusicPlayer] Failed to play next track after error:", playError);
        });
    }

    // --- Cleanup ---
    public destroy(): void {
         console.log('[MusicPlayer] Destroying MusicPlayer and all components...');
         // Destroy components in reverse order of dependency or safe order
         this.audioStreamManager.destroy();
         this.autoplayManager.destroy();
         this.recommendationService.destroy();
         this.playlistManager.destroy();
         this.blockedContentManager.destroy();
         this.trackQueue.destroy();
         this.cacheManager.destroy();
         this.audioPlaybackEngine.destroy();
         this.voiceConnectionManager.destroy();
         this.playerStateManager.destroy();
         // DatabaseService might not need explicit destroy if using shared Prisma client

         // Clear singleton instance
         instance = null;
         this.isInitialized = false;
         console.log('[MusicPlayer] MusicPlayer destroyed.');
    }

}

// --- Singleton Access ---

/**
 * Initializes the singleton MusicPlayer instance.
 */
export function initializeMusicPlayer(
    client: Client,
    trackingService: TrackingService
    // recommendationEngine: RecommendationEngine // Pass if needed
): MusicPlayer {
    if (!instance) {
        console.log('[MusicPlayer] Creating singleton instance...');
        instance = new MusicPlayer(client, trackingService /*, recommendationEngine */);
    } else {
         console.warn('[MusicPlayer] Attempted to initialize already existing instance.');
    }
    return instance;
}

/**
 * Gets the singleton MusicPlayer instance.
 * Throws an error if the player hasn't been initialized.
 */
export function getMusicPlayer(): MusicPlayer {
    if (!instance) {
        throw new Error('MusicPlayer has not been initialized. Call initializeMusicPlayer first.');
    }
    return instance;
}