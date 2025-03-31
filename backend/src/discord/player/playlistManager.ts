import { DatabaseService } from './databaseService.js';
import { PlaylistWithTracks, Track, QueueItem } from './types.js';
import { PlaylistMode } from '../../types/enums.js'; // Import PlaylistMode enum

export class PlaylistManager {
    private databaseService: DatabaseService;
    private currentPlaylist: PlaylistWithTracks | null = null;
    private currentPlaylistPosition: number = 0; // For LINEAR mode tracking

    constructor(databaseService: DatabaseService) {
        this.databaseService = databaseService;
        this.initializeActivePlaylist();
    }

    /** Loads the currently active playlist from the database on startup. */
    private async initializeActivePlaylist(): Promise<void> {
        console.log('[PM] Initializing active playlist...');
        try {
            this.currentPlaylist = await this.databaseService.getActivePlaylist();
            if (this.currentPlaylist) {
                console.log(`[PM] Loaded active playlist: "${this.currentPlaylist.name}" (Mode: ${this.currentPlaylist.mode}, Tracks: ${this.currentPlaylist.tracks.length})`);
                this.currentPlaylistPosition = 0; // Reset position on load
            } else {
                console.log('[PM] No active default playlist found.');
            }
        } catch (error) {
            console.error('[PM] Failed to initialize active playlist:', error);
            this.currentPlaylist = null;
        }
    }

    /** Sets the currently active playlist. Used for admin controls. */
    public async setActivePlaylist(playlistId: string | undefined): Promise<boolean> {
        console.log(`[PM] Setting active playlist to: ${playlistId ?? 'None'}`);
        // This requires DB interaction to update the 'active' flag on playlists
        // For now, we just reload the active playlist based on the current DB state
        // A more complete implementation would update the DB first.
        await this.initializeActivePlaylist(); // Reload based on DB state
        return !!this.currentPlaylist && this.currentPlaylist.id === playlistId;
    }

    /** Gets the next track from the active playlist based on its mode. */
    public async getNextPlaylistTrack(): Promise<Track | null> {
        if (!this.currentPlaylist || this.currentPlaylist.tracks.length === 0) {
            // console.log('[PM] No active playlist or playlist is empty.'); // Debug
            return null;
        }

        const playlistTracks = this.currentPlaylist.tracks;

        if (this.currentPlaylist.mode === PlaylistMode.LINEAR) {
            // Get the track at the current position
            const trackInfo = playlistTracks[this.currentPlaylistPosition];
            if (!trackInfo) {
                console.log('[PM] Reached end of LINEAR playlist.');
                this.currentPlaylistPosition = 0; // Loop back to start
                return playlistTracks[0]?.track ?? null; // Return first track if looping
            }

            // Advance position for next call
            this.currentPlaylistPosition = (this.currentPlaylistPosition + 1) % playlistTracks.length;
            console.log(`[PM] Next LINEAR track: ${trackInfo.track.title} (New Position: ${this.currentPlaylistPosition})`);
            return trackInfo.track;

        } else if (this.currentPlaylist.mode === PlaylistMode.POOL) {
            // Select a random track from the pool
            const randomIndex = Math.floor(Math.random() * playlistTracks.length);
            const trackInfo = playlistTracks[randomIndex];
            console.log(`[PM] Next POOL track (Random): ${trackInfo?.track?.title}`);
            return trackInfo?.track ?? null;

        } else {
            console.warn(`[PM] Unknown playlist mode: ${this.currentPlaylist.mode}`);
            return null;
        }
    }

    /** Checks if a playlist is currently active. */
    public hasActivePlaylist(): boolean {
        return !!this.currentPlaylist;
    }

    /** Gets the ID of the currently active playlist. */
    public getActivePlaylistId(): string | undefined {
        return this.currentPlaylist?.id;
    }

    // --- Cleanup ---
    public destroy(): void {
        console.log('[PM] Destroying PlaylistManager...');
        this.currentPlaylist = null;
        // No intervals or listeners to clear
        console.log('[PM] PlaylistManager destroyed.');
    }
}