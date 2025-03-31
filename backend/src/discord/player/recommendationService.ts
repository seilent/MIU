import { DatabaseService } from './databaseService.js';
import { Track, YoutubeRecommendationInfo } from './types.js';
import { getYoutubeInfo, getYoutubeRecommendations, refreshYoutubeRecommendationsPool as refreshExternalPool } from '../../utils/youtube.js';
import { isRecommendationsEnabled } from '../../utils/youtubeMusic.js'; // Check if feature is enabled

export class RecommendationService {
    private databaseService: DatabaseService;
    private recommendationPool: YoutubeRecommendationInfo[] = [];
    private usedSeedTracks: Set<string> = new Set(); // Track seeds used recently
    private isLoading: boolean = false;
    private refreshInterval?: NodeJS.Timeout;

    // Configuration (consider moving to a config file/env vars)
    private readonly POOL_LOW_THRESHOLD = parseInt(process.env.YT_REC_POOL_LOW_THRESHOLD || '10'); // Fetch more when pool drops below this
    private readonly POOL_TARGET_SIZE = parseInt(process.env.YT_REC_POOL_SIZE || '50');
    private readonly SEED_TRACK_COOLDOWN = parseInt(process.env.SEED_TRACK_COOLDOWN || '24') * 3600000; // In ms
    private readonly REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
    private readonly INITIAL_REFRESH_DELAY_MS = 5 * 60 * 1000; // 5 minutes

    constructor(databaseService: DatabaseService) {
        this.databaseService = databaseService;

        // Always initialize the pool regardless of recommendations being enabled
        console.log('[RS] Initializing recommendation pool from database...');
        this.initializePool();

        if (isRecommendationsEnabled()) {
            console.log('[RS] YouTube recommendations enabled. Setting up refresh service.');
            // Schedule periodic refresh using the external utility
            setTimeout(() => {
                 console.log('[RS] Starting initial recommendation pool refresh.');
                 this.triggerExternalPoolRefresh(); // Initial refresh
                 this.refreshInterval = setInterval(
                     () => this.triggerExternalPoolRefresh(),
                     this.REFRESH_INTERVAL_MS
                 );
                 console.log(`[RS] Recommendation refresh interval set to ${this.REFRESH_INTERVAL_MS / 1000 / 60} minutes.`);
            }, this.INITIAL_REFRESH_DELAY_MS);
        } else {
            console.log('[RS] YouTube recommendations disabled. Only using existing recommendations.');
        }
    }

    private async initializePool(): Promise<void> {
        console.log('[RS] Initializing recommendation pool from database...');
        this.isLoading = true;
        try {
            // Load non-played recommendations from DB initially
            this.recommendationPool = await this.databaseService.getRecommendations([], this.POOL_TARGET_SIZE * 2); // Fetch more initially
            console.log(`[RS] Loaded ${this.recommendationPool.length} recommendations from database.`);
            // No need to filter by cooldown here, assume getRecommendations handles wasPlayed or cooldown logic if necessary
        } catch (error) {
            console.error('[RS] Failed to initialize recommendation pool:', error);
            this.recommendationPool = [];
        } finally {
            this.isLoading = false;
        }
    }

    /** Triggers the external pool refresh utility. */
    private triggerExternalPoolRefresh(): void {
         if (!isRecommendationsEnabled()) return;
         console.log('[RS] Triggering external recommendation pool refresh...');
         refreshExternalPool().then(() => {
             console.log('[RS] External pool refresh completed. Reloading internal pool.');
             // Reload internal pool after external refresh completes
             this.initializePool();
         }).catch(error => {
             console.error('[RS] External pool refresh failed:', error);
         });
    }

    /** Gets the next available recommendation from the pool. */
    public async getNextRecommendation(): Promise<Track | null> {
         if (this.isLoading) {
             console.log('[RS] Skipping getNextRecommendation (loading).');
             return null;
         }

        if (this.recommendationPool.length === 0) {
            console.log('[RS] Recommendation pool is empty. Attempting to refresh from database.');
            // Attempt immediate refresh if empty, but don't block excessively
            await this.initializePool(); // Reload from DB
             if (this.recommendationPool.length === 0) {
                 // Only trigger external refresh if recommendations are enabled
                 if (isRecommendationsEnabled()) {
                     console.log('[RS] Still empty after DB reload, triggering external refresh...');
                     this.triggerExternalPoolRefresh();
                 } else {
                     console.log('[RS] Still empty after DB reload, and recommendations are disabled.');
                 }
                 return null;
             }
        }

        // Simple random selection from the current pool
        if (this.recommendationPool.length > 0) {
            const randomIndex = Math.floor(Math.random() * this.recommendationPool.length);
            const selectedRec = this.recommendationPool.splice(randomIndex, 1)[0]; // Remove from pool

            console.log(`[RS] Selected recommendation: ${selectedRec.title ?? selectedRec.youtubeId}`);

            // Fetch full track details (needed for duration, etc.)
            try {
                const trackDetails = await this.databaseService.getTrack(selectedRec.youtubeId);
                 if (trackDetails) {
                     // Check if pool is low after taking one, trigger background refresh if enabled
                     if (this.recommendationPool.length < this.POOL_LOW_THRESHOLD && isRecommendationsEnabled()) {
                         console.log('[RS] Recommendation pool low, triggering background refresh.');
                         this.triggerExternalPoolRefresh();
                     }
                     return trackDetails;
                 } else {
                     console.warn(`[RS] Could not fetch track details for recommendation ${selectedRec.youtubeId}. Skipping.`);
                      // Remove from DB if track details are missing?
                      await this.databaseService.removeRecommendation(selectedRec.youtubeId);
                 }
            } catch (error) {
                 console.error(`[RS] Error fetching track details for recommendation ${selectedRec.youtubeId}:`, error);
            }
        }

        return null; // Return null if no valid track found
    }

    /** Public method to manually trigger a pool refresh if needed. */
    public refreshPoolIfNeeded(): void {
        if (!this.isLoading) {
            console.log('[RS] Manual refresh triggered.');
            this.triggerExternalPoolRefresh();
        } else {
             console.log('[RS] Manual refresh skipped, already loading.');
        }
    }

    /** Resets the internal recommendation pool and reloads from the database. */
    public async resetRecommendationsPool(): Promise<void> {
        if (!isRecommendationsEnabled()) {
            console.log('[RS] Cannot reset pool: Recommendations disabled.');
            return;
        }
        console.log('[RS] Resetting recommendations pool...');
        this.recommendationPool = []; // Clear internal pool
        await this.initializePool(); // Reload from DB
        console.log(`[RS] Recommendations pool reset. New size: ${this.recommendationPool.length}`);
    }


    // --- Cleanup ---
    public destroy(): void {
        console.log('[RS] Destroying RecommendationService...');
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = undefined;
        }
        this.recommendationPool = [];
        this.usedSeedTracks.clear();
        this.isLoading = false;
        console.log('[RS] RecommendationService destroyed.');
    }
}