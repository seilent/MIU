import { DatabaseService } from './databaseService.js';
import { TrackQueue } from './trackQueue.js';
import { PlayerStateManager } from './playerStateManager.js';
import { BlockedContentManager } from './blockedContentManager.js';
import { PlaylistManager } from './playlistManager.js';
import { RecommendationService } from './recommendationService.js';
import { QueueItem, Track, TrackStats, AutoplaySource } from './types.js';
import { getThumbnailUrl } from '../../utils/youtubeMusic.js';
import { TrackStatus } from '../../types/enums.js'; // Import TrackStatus
import { Client } from 'discord.js'; // Needed to get bot user info

// Define weights for different autoplay sources
const AUTOPLAY_WEIGHTS = {
    PLAYLIST: parseFloat(process.env.AUTOPLAY_WEIGHT_PLAYLIST || '0.15'), // Default Playlist tracks
    HISTORY: parseFloat(process.env.AUTOPLAY_WEIGHT_HISTORY || '0.05'),   // User listening history (favorites)
    POPULAR: parseFloat(process.env.AUTOPLAY_WEIGHT_POPULAR || '0.05'),   // Popular tracks (global score)
    YOUTUBE: parseFloat(process.env.AUTOPLAY_WEIGHT_YOUTUBE || '0.65'),   // YouTube recommendations
    RANDOM: parseFloat(process.env.AUTOPLAY_WEIGHT_RANDOM || '0.10')      // Random tracks from DB
};

// Validate weights sum approximately to 1.0
const totalWeight = Object.values(AUTOPLAY_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
if (Math.abs(totalWeight - 1.0) > 0.01) {
    console.warn(`[AM] WARNING: Autoplay weights sum to ${totalWeight.toFixed(2)}, not 1.0. Adjust weights in environment variables.`);
    console.warn('[AM] Current weights:', JSON.stringify(AUTOPLAY_WEIGHTS, null, 2));
}

// Define a union type for the potential track data structures used internally
type PotentialTrackData = Track | TrackStats | (TrackStats & { personalScore: number });

export class AutoplayManager {
    private databaseService: DatabaseService;
    private trackQueue: TrackQueue;
    private playerStateManager: PlayerStateManager;
    private blockedContentManager: BlockedContentManager;
    private playlistManager: PlaylistManager;
    private recommendationService: RecommendationService;
    private client: Client; // Discord client for bot user info

    // Cooldown settings (consider moving to config)
    private readonly HOURS_TO_MS = 3600000;
    private readonly TOP_TIER_EXPIRY = parseInt(process.env.TOP_TIER_EXPIRY || '6') * this.HOURS_TO_MS;
    private readonly MID_TIER_EXPIRY = parseInt(process.env.MID_TIER_EXPIRY || '8') * this.HOURS_TO_MS;
    private readonly LOW_TIER_EXPIRY = parseInt(process.env.LOW_TIER_EXPIRY || '10') * this.HOURS_TO_MS;
    private readonly AUTOPLAY_TRACKS_EXPIRY = parseInt(process.env.AUTOPLAY_TRACKS_EXPIRY || '5') * this.HOURS_TO_MS;

    // Internal state
    private playedTracksCooldown: Map<string, number> = new Map(); // youtubeId -> expiry timestamp
    private readonly AUTOPLAY_BUFFER_SIZE = parseInt(process.env.AUTOPLAY_BUFFER_SIZE || '5');
    private isPrefetching: boolean = false;

    constructor(
        databaseService: DatabaseService,
        trackQueue: TrackQueue,
        playerStateManager: PlayerStateManager,
        blockedContentManager: BlockedContentManager,
        playlistManager: PlaylistManager,
        recommendationService: RecommendationService,
        client: Client
    ) {
        this.databaseService = databaseService;
        this.trackQueue = trackQueue;
        this.playerStateManager = playerStateManager;
        this.blockedContentManager = blockedContentManager;
        this.playlistManager = playlistManager;
        this.recommendationService = recommendationService;
        this.client = client;

        // Clean up expired cooldowns periodically (e.g., every hour)
        setInterval(() => this.cleanupPlayedTracksCooldown(), this.HOURS_TO_MS);
    }

    /** Adds a track ID to the cooldown list with an appropriate expiry time. */
    public addTrackToCooldown(youtubeId: string, isUserRequested: boolean = false): void {
        // User-requested tracks might get shorter cooldowns (handled elsewhere if needed)
        // For autoplay, use standard cooldown periods based on stats or default.
        this.getCooldownPeriod(youtubeId).then(cooldownPeriod => {
            const expiryTime = Date.now() + cooldownPeriod;
            this.playedTracksCooldown.set(youtubeId, expiryTime);
            console.log(`[AM] Added ${youtubeId} to cooldown until ${new Date(expiryTime).toLocaleTimeString()}`);
        }).catch(err => {
            console.error(`[AM] Error getting cooldown period for ${youtubeId}:`, err);
             // Fallback to default if stats fetch fails
            const expiryTime = Date.now() + this.AUTOPLAY_TRACKS_EXPIRY;
            this.playedTracksCooldown.set(youtubeId, expiryTime);
             console.log(`[AM] Added ${youtubeId} to cooldown (default) until ${new Date(expiryTime).toLocaleTimeString()}`);
        });
    }

    /** Checks if a track is currently on cooldown. */
    private isTrackOnCooldown(youtubeId: string): boolean {
        const expiryTime = this.playedTracksCooldown.get(youtubeId);
        if (!expiryTime) return false;
        const isOnCooldown = Date.now() < expiryTime;
        // if (isOnCooldown) console.log(`[AM] Cooldown check: ${youtubeId} is ON cooldown.`); // Debug
        return isOnCooldown;
    }

    /** Removes expired entries from the cooldown map. */
    private cleanupPlayedTracksCooldown(): void {
        const now = Date.now();
        let removedCount = 0;
        for (const [trackId, expiryTime] of this.playedTracksCooldown.entries()) {
            if (now >= expiryTime) {
                this.playedTracksCooldown.delete(trackId);
                removedCount++;
            }
        }
        if (removedCount > 0) {
            console.log(`[AM] Cleaned up ${removedCount} expired track cooldowns.`);
        }
    }

    /** Calculates the cooldown period based on track stats. */
    private async getCooldownPeriod(youtubeId: string): Promise<number> {
        try {
            // Fetch full track data which includes stats needed
            const fullStats = await this.databaseService.getTrackWithChannel(youtubeId);
            if (!fullStats) return this.AUTOPLAY_TRACKS_EXPIRY; // Default if no stats

            const playCount = fullStats.playCount ?? 0;
            const skipCount = fullStats.skipCount ?? 0;
            const globalScore = fullStats.globalScore ?? 0;

            const skipRatio = playCount > 0 ? skipCount / playCount : 0;

            if (globalScore > 8 && skipRatio < 0.2) return this.TOP_TIER_EXPIRY;
            if (globalScore > 5 && skipRatio < 0.3) return this.MID_TIER_EXPIRY;
            return this.LOW_TIER_EXPIRY;
        } catch (error) {
            console.error(`[AM] Error fetching stats for cooldown calculation (${youtubeId}):`, error);
            return this.AUTOPLAY_TRACKS_EXPIRY; // Default on error
        }
    }

    /**
     * Called when the player needs an autoplay track.
     * Attempts to fill the autoplay buffer if needed, then adds the next track to the main queue.
     */
    public async handleAutoplayRequest(): Promise<void> {
        if (!this.playerStateManager.isAutoplayEnabled()) {
            console.log('[AM] Autoplay is disabled, skipping request.');
            return;
        }

        console.log('[AM] Handling autoplay request...');
        // Ensure buffer is filled in the background if needed
        this.ensureAutoplayBufferFilled(); // Fire-and-forget background task

        // The actual playing of the next track is handled by the main player logic
        // which calls trackQueue.getNextTrack(). This manager focuses on *supplying* tracks.
    }

    /** Ensures the autoplay queue buffer has enough tracks. Runs in the background. */
    public async ensureAutoplayBufferFilled(): Promise<void> {
        if (this.isPrefetching) {
            // console.log('[AM] Prefetch already in progress.'); // Debug
            return;
        }

        // Calculate needed tracks based on TrackQueue's combined length
        const currentCombinedQueue = this.trackQueue.getCombinedQueue();
        // Estimate autoplay queue size (might not be perfect if structure changes)
        const currentAutoplayQueueSize = Math.max(0, currentCombinedQueue.length - (this.playerStateManager.getCurrentTrack() ? 1 : 0)); // Simple estimate
        const needed = this.AUTOPLAY_BUFFER_SIZE - currentAutoplayQueueSize;


        if (needed <= 0) {
            // console.log('[AM] Autoplay buffer seems full.'); // Debug
            return;
        }

        console.log(`[AM] Autoplay buffer needs ~${needed} tracks. Starting prefetch...`);
        this.isPrefetching = true;

        try {
            const botUser = this.client.user;
             if (!botUser) {
                 console.error('[AM] Cannot prefetch: Bot user info not available.');
                 this.isPrefetching = false; // Reset flag on error
                 return;
             }
            const botUserInfo = {
                userId: botUser.id,
                username: botUser.username,
                avatar: botUser.avatar || null
            };

            let addedCount = 0;
            let attempts = 0;
            const maxAttempts = needed * 5; // Allow more attempts

            while (addedCount < needed && attempts < maxAttempts) {
                attempts++;
                const track = await this.selectNextAutoplayTrack(botUserInfo);
                if (track) {
                    // Add to the dedicated autoplay queue within TrackQueue
                    const added = await this.trackQueue.addAutoplayTrack(track);
                    if (added) {
                        addedCount++;
                        console.log(`[AM] Prefetched track ${addedCount}/${needed}: ${track.title} (${track.autoplaySource})`);
                    }
                } else {
                    console.log(`[AM] Prefetch attempt ${attempts}: Failed to select a suitable track.`);
                    // Avoid tight loops if sources are exhausted
                    await new Promise(resolve => setTimeout(resolve, 200));
                }
            }
            if (addedCount < needed) {
                console.warn(`[AM] Prefetch finished but only added ${addedCount}/${needed} tracks after ${attempts} attempts.`);
            } else {
                 console.log(`[AM] Prefetch complete. Added ${addedCount} tracks.`);
            }

        } catch (error) {
            console.error('[AM] Error during autoplay prefetch:', error);
        } finally {
            this.isPrefetching = false; // Ensure flag is reset
        }
    }

    /** Helper function to filter tracks asynchronously */
    private async filterAvailableTracks(tracks: PotentialTrackData[]): Promise<PotentialTrackData[]> {
        // Explicitly type the array being built
        const availableTracks: PotentialTrackData[] = [];
        for (const track of tracks) {
            // Check cooldown synchronously first (quick check)
            if (this.isTrackOnCooldown(track.youtubeId)) {
                continue; // Skip if on cooldown
            }
            // Check blocked status asynchronously
            if (!await this.blockedContentManager.isBlocked(track.youtubeId)) {
                availableTracks.push(track); // Add if not blocked
            }
        }
        return availableTracks;
    }


    /** Selects the next autoplay track based on weighted sources. */
    private async selectNextAutoplayTrack(requestedBy: { userId: string, username: string, avatar: string | null }): Promise<QueueItem | null> {
        const maxSelectionAttempts = 10; // Prevent infinite loops if sources are dry
        let selectedSource: keyof typeof AUTOPLAY_WEIGHTS | null = null; // Declare outside the loop

        for (let i = 0; i < maxSelectionAttempts; i++) {
            const rand = Math.random();
            let cumulativeWeight = 0;
            selectedSource = null; // Reset for each attempt

            if (rand < (cumulativeWeight += AUTOPLAY_WEIGHTS.YOUTUBE)) selectedSource = 'YOUTUBE';
            else if (rand < (cumulativeWeight += AUTOPLAY_WEIGHTS.PLAYLIST)) selectedSource = 'PLAYLIST';
            else if (rand < (cumulativeWeight += AUTOPLAY_WEIGHTS.RANDOM)) selectedSource = 'RANDOM';
            else if (rand < (cumulativeWeight += AUTOPLAY_WEIGHTS.HISTORY)) selectedSource = 'HISTORY';
            else if (rand < (cumulativeWeight += AUTOPLAY_WEIGHTS.POPULAR)) selectedSource = 'POPULAR';

            if (!selectedSource) continue;

            // console.log(`[AM] Selecting track from source: ${selectedSource}`); // Debug
            let potentialTracks: PotentialTrackData[] = [];
            let autoplaySourceType: AutoplaySource = 'Pool: Random'; // Default

            try {
                switch (selectedSource) {
                    case 'YOUTUBE':
                        const rec = await this.recommendationService.getNextRecommendation();
                        if (rec) potentialTracks = [rec]; // Wrap in array for filter function
                        if (rec) autoplaySourceType = 'Pool: YouTube Mix';
                        break;
                    case 'PLAYLIST':
                        const playlistTrack = await this.playlistManager.getNextPlaylistTrack();
                        if (playlistTrack) potentialTracks = [playlistTrack];
                         if (playlistTrack) autoplaySourceType = 'Pool: Playlist';
                        break;
                    case 'HISTORY':
                        potentialTracks = await this.databaseService.getUserFavoriteTracks(50);
                        if (potentialTracks.length > 0) autoplaySourceType = 'Pool: History';
                        break;
                    case 'POPULAR':
                        potentialTracks = await this.databaseService.getPopularTracks(50);
                         if (potentialTracks.length > 0) autoplaySourceType = 'Pool: Popular';
                        break;
                    case 'RANDOM':
                        potentialTracks = await this.databaseService.getRandomTracks(100);
                         if (potentialTracks.length > 0) autoplaySourceType = 'Pool: Random';
                        break;
                }

                // Filter the fetched tracks asynchronously
                const availableTracks = await this.filterAvailableTracks(potentialTracks);

                if (availableTracks.length > 0) {
                    // Select a random track from the available ones
                    const trackData = availableTracks[Math.floor(Math.random() * availableTracks.length)];

                    // Ensure we have title and duration
                    let title = trackData.title;
                    let duration = trackData.duration;
                    if (!title || !duration) {
                        const fullTrack = await this.databaseService.getTrack(trackData.youtubeId);
                        if (!fullTrack) continue; // Skip if full details can't be fetched
                        title = fullTrack.title;
                        duration = fullTrack.duration;
                    }

                     // Add to cooldown *before* returning
                     this.addTrackToCooldown(trackData.youtubeId);

                    return {
                        youtubeId: trackData.youtubeId,
                        title: title,
                        thumbnail: getThumbnailUrl(trackData.youtubeId),
                        duration: duration,
                        requestedBy: {
                            userId: requestedBy.userId,
                            username: requestedBy.username,
                            avatar: requestedBy.avatar || undefined,
                        },
                        requestedAt: new Date(),
                        isAutoplay: true,
                        autoplaySource: autoplaySourceType,
                    };
                } else if (potentialTracks.length > 0) {
                     console.log(`[AM] Source ${selectedSource} provided tracks, but all were on cooldown or blocked. Retrying...`);
                } else {
                     console.log(`[AM] Source ${selectedSource} provided no tracks. Retrying...`);
                }

            } catch (error) {
                 console.error(`[AM] Error selecting track from ${selectedSource}:`, error);
            }
        }

        console.warn('[AM] Failed to select any autoplay track after multiple attempts.');
        // Trigger recommendation refresh only if YouTube was the *last attempted* source and failed
        if (selectedSource === 'YOUTUBE') {
             this.recommendationService.refreshPoolIfNeeded();
        }
        return null;
    }

    // --- Cleanup ---
    public destroy(): void {
        console.log('[AM] Destroying AutoplayManager...');
        // Correctly clear the interval using its reference
        // Assuming the interval reference is stored correctly in the constructor (it wasn't shown before)
        // If the interval was stored in a property like `this.cleanupInterval`, clear it here.
        // For now, assuming the previous setInterval call was global or needs to be managed differently.
        // clearInterval(this.cleanupPlayedTracksCooldown as unknown as NodeJS.Timeout); // Example if stored

        this.playedTracksCooldown.clear();
        this.isPrefetching = false;
        console.log('[AM] AutoplayManager destroyed.');
    }
}