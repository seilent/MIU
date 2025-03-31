import { DatabaseService } from './databaseService.js';
import { TrackStatus } from '../../types/enums.js'; // Import TrackStatus for applying ban

export class BlockedContentManager {
    private databaseService: DatabaseService;
    private blockedTrackIds: Set<string> = new Set();
    private blockedChannelIds: Set<string> = new Set();
    private refreshInterval?: NodeJS.Timeout;

    constructor(databaseService: DatabaseService) {
        this.databaseService = databaseService;
        this.initializeBlockedLists();

        // Periodically refresh the lists (e.g., every 5 minutes)
        const refreshIntervalMs = 5 * 60 * 1000;
        this.refreshInterval = setInterval(() => this.refreshBlockedLists(), refreshIntervalMs);
        console.log(`[BCM] Blocked content refresh interval set to ${refreshIntervalMs / 1000} seconds.`);
    }

    private async initializeBlockedLists(): Promise<void> {
        console.log('[BCM] Initializing blocked content lists...');
        await this.refreshBlockedLists();
    }

    /**
     * Fetches the latest blocked track and channel IDs from the database
     * and updates the in-memory sets.
     */
    async refreshBlockedLists(): Promise<void> {
        try {
            const [trackIds, channelIds] = await Promise.all([
                this.databaseService.getBlockedTrackIds(),
                this.databaseService.getBlockedChannelIds()
            ]);
            this.blockedTrackIds = trackIds;
            this.blockedChannelIds = channelIds;
            console.log(`[BCM] Refreshed blocked lists: ${this.blockedTrackIds.size} tracks, ${this.blockedChannelIds.size} channels.`);
        } catch (error) {
            console.error('[BCM] Failed to refresh blocked content lists:', error);
        }
    }

    /**
     * Checks if a given YouTube track ID is blocked, either directly
     * or because its channel is blocked.
     * @param youtubeId The YouTube track ID to check.
     * @returns True if the track is considered blocked, false otherwise.
     */
    async isBlocked(youtubeId: string): Promise<boolean> {
        if (this.blockedTrackIds.has(youtubeId)) {
            console.log(`[BCM] Check: Track ${youtubeId} is directly blocked.`);
            return true;
        }

        // Check channel blocking (requires fetching track info)
        try {
            // Use getTrackWithChannel for efficiency if channel info is often needed
            // Or use getTrack if only channelId is needed
            const track = await this.databaseService.getTrack(youtubeId);
            if (track?.channelId && this.blockedChannelIds.has(track.channelId)) {
                console.log(`[BCM] Check: Track ${youtubeId} is blocked via channel ${track.channelId}.`);
                return true;
            }
        } catch (error) {
            console.error(`[BCM] Error checking channel blocking status for track ${youtubeId}:`, error);
            // Fail safe? Assume not blocked if DB check fails? Or assume blocked?
            // Let's assume not blocked on error to avoid false positives.
        }

        return false;
    }

     /**
      * Blocks a track, applies penalties, and cleans up associated data.
      * Note: The reason parameter is not currently stored in the schema.
      */
     async blockTrack(youtubeId: string, reason?: string): Promise<void> {
         console.log(`[BCM] Blocking track ${youtubeId}. Reason: ${reason || 'N/A'}`);
         try {
             // 1. Apply ban penalty and set status to BLOCKED in DB
             await this.databaseService.applyBanPenalty(youtubeId);

             // 2. Clean up associated data (playlists, recommendations)
             await this.databaseService.cleanupBlockedSongData(youtubeId);

             // 3. Update in-memory set
             this.blockedTrackIds.add(youtubeId);

             console.log(`[BCM] Successfully blocked track ${youtubeId}.`);

             // TODO: Notify relevant components (e.g., TrackQueue to remove, Player to skip if current)
             // This notification logic might live in the main Player class or be event-driven.

         } catch (error) {
             console.error(`[BCM] Failed to block track ${youtubeId}:`, error);
         }
     }

     /**
      * Blocks a channel and potentially all associated tracks.
      * Note: The reason parameter is not currently stored in the schema.
      */
     async blockChannel(channelId: string, reason?: string): Promise<void> {
         console.log(`[BCM] Blocking channel ${channelId}. Reason: ${reason || 'N/A'}`);
         try {
             // 1. Mark channel as blocked in DB (Requires adding this method to DatabaseService)
             // await this.databaseService.updateChannelBlockedStatus(channelId, true, reason);

             // 2. Optionally, find all tracks by this channel and block them individually?
             //    This could be intensive. A simpler approach is just checking channel status.
             //    For now, we rely on the isBlocked check using the channel list.

             // 3. Update in-memory set
             this.blockedChannelIds.add(channelId);

             console.log(`[BCM] Successfully blocked channel ${channelId}. Associated tracks will now be blocked.`);

             // TODO: Notify relevant components.

         } catch (error) {
             console.error(`[BCM] Failed to block channel ${channelId}:`, error);
         }
     }

    // --- Cleanup ---
    public destroy(): void {
        console.log('[BCM] Destroying BlockedContentManager...');
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = undefined;
        }
        this.blockedTrackIds.clear();
        this.blockedChannelIds.clear();
        console.log('[BCM] BlockedContentManager destroyed.');
    }
}