import fs from 'fs';
import path from 'path';
import { DatabaseService } from './databaseService.js';
import { Track } from './types.js'; // Import Track type
import { downloadYoutubeAudio, getYoutubeInfo } from '../../utils/youtube.js'; // Import download and info functions
import { TrackStatus } from '../../types/enums.js'; // Import TrackStatus

export class CacheManager {
    private databaseService: DatabaseService;
    private audioCacheDir: string;
    private thumbnailCacheDir: string;
    private downloadingTracks = new Set<string>(); // Track ongoing downloads
    private downloadLocks = new Map<string, Promise<string | null>>(); // Track download promises

    constructor(databaseService: DatabaseService) {
        this.databaseService = databaseService;
        this.audioCacheDir = path.join(process.env.CACHE_DIR || 'cache', 'audio');
        this.thumbnailCacheDir = path.join(process.env.CACHE_DIR || 'cache', 'thumbnails');

        // Ensure cache directories exist
        this.ensureCacheDirsExist();
    }

    private async ensureCacheDirsExist(): Promise<void> {
        try {
            await fs.promises.mkdir(this.audioCacheDir, { recursive: true });
            await fs.promises.mkdir(this.thumbnailCacheDir, { recursive: true });
            console.log(`[CM] Ensured cache directories exist: ${this.audioCacheDir}, ${this.thumbnailCacheDir}`);
        } catch (error) {
            console.error('[CM] Failed to create cache directories:', error);
        }
    }

    /**
     * Special handling for tracks added at position 0 (immediate playback)
     */
    async ensureImmediateAudioCached(youtubeId: string): Promise<string | null> {
        console.log(`[CM] Ensuring immediate audio cache for track at position 0: ${youtubeId}`);
        return this.ensureAudioCached(youtubeId, true);
    }

    /**
     * Ensures audio for a track is cached. Downloads if necessary.
     * Returns the file path if successful, null otherwise.
     * Uses the original youtubeId for storing cache, but resolvedId for downloading.
     * @param isImmediate Whether this is for immediate playback (position 0)
     */
    async ensureAudioCached(youtubeId: string, isImmediate = false): Promise<string | null> {
        // First check if we already have this track cached
        const cachedAudio = await this.databaseService.getAudioCache(youtubeId);
        if (cachedAudio && fs.existsSync(cachedAudio.filePath)) {
            console.log(`✓ [CM] Using cached audio for ${youtubeId}: ${cachedAudio.filePath}`);
            return cachedAudio.filePath;
        }

        // Check if there's already a download in progress
        if (this.downloadLocks.has(youtubeId)) {
            console.log(`[CM] Download already in progress for ${youtubeId}. Waiting...`);
            try {
                // We've already checked that the lock exists, so we can safely use !
                const existingLock = this.downloadLocks.get(youtubeId)!;
                return await existingLock;
            } catch (error) {
                console.warn(`[CM] Previous download failed for ${youtubeId}, retrying...`);
                // Continue to start a new download
            }
        }

        // Not cached and not downloading, start the download process
        console.log(`[CM] Audio not cached for ${youtubeId}. Initiating download.`);
        
        // Create a new download promise and store it in the locks map
        const downloadPromise = this.performAudioDownload(youtubeId, isImmediate);
        this.downloadLocks.set(youtubeId, downloadPromise);

        try {
            const result = await downloadPromise;
            return result;
        } finally {
            this.downloadLocks.delete(youtubeId);
        }
    }

    /**
     * Performs the actual audio download with proper error handling
     */
    private async performAudioDownload(youtubeId: string, isImmediate: boolean): Promise<string | null> {
        this.downloadingTracks.add(youtubeId);
        
        try {
            // First check if we have track details in database
            const trackDetails = await this.databaseService.getTrack(youtubeId);
            if (!trackDetails) {
                throw new Error(`Track details not found for ${youtubeId}`);
            }

            await this.databaseService.updateTrackStatus(youtubeId, TrackStatus.DOWNLOADING);

            const downloadId = trackDetails.resolvedYtId || youtubeId;
            const isMusicUrl = trackDetails.isMusicUrl ?? false;
            console.log(`[CM] Using download ID: ${downloadId}, isMusicUrl: ${isMusicUrl}`);

            // For immediate playback, we might want to prioritize this download
            if (isImmediate) {
                console.log(`[CM] Prioritizing download for immediate playback: ${youtubeId}`);
            }

            const tempPath = await downloadYoutubeAudio(downloadId, isMusicUrl);
            const absoluteTempPath = path.resolve(tempPath);
            const finalPath = path.resolve(this.audioCacheDir, `${youtubeId}${path.extname(tempPath)}`);

            // Ensure cache directory exists
            await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });

            // Rename/move the downloaded file
            try {
                await fs.promises.rename(absoluteTempPath, finalPath);
            } catch (renameError: any) {
                if (renameError.code === 'EXDEV') {
                    console.warn(`[CM] Rename failed (EXDEV), attempting copy/unlink for ${youtubeId}`);
                    await fs.promises.copyFile(absoluteTempPath, finalPath);
                    await fs.promises.unlink(absoluteTempPath);
                } else {
                    throw renameError;
                }
            }

            await this.databaseService.upsertAudioCache(youtubeId, finalPath);
            await this.databaseService.updateTrackStatus(youtubeId, TrackStatus.READY);

            console.log(`✓ [CM] Audio downloaded and cached for ${youtubeId}: ${finalPath}`);
            return finalPath;

        } catch (error: any) {
            console.error(`❌ [CM] Failed to ensure audio cache for ${youtubeId}:`, error);
            try {
                await this.databaseService.updateTrackStatus(youtubeId, TrackStatus.STANDBY);
            } catch (statusError) {
                console.error(`[CM] Failed to reset status for ${youtubeId} after download error:`, statusError);
            }
            return null;
        } finally {
            this.downloadingTracks.delete(youtubeId);
        }
    }

    /**
     * Retrieves the file path for cached audio. Does not trigger download.
     */
    async getAudioFilePath(youtubeId: string): Promise<string | null> {
        const cachedAudio = await this.databaseService.getAudioCache(youtubeId);
        if (cachedAudio && fs.existsSync(cachedAudio.filePath)) {
            return cachedAudio.filePath;
        }
        return null;
    }

    /**
     * Initiates audio download in the background without waiting.
     * Used for prefetching tracks in the queue.
     */
    prefetchAudio(youtubeId: string): void {
        // Check if already cached or downloading
        if (this.downloadLocks.has(youtubeId) || this.downloadingTracks.has(youtubeId)) {
            return;
        }
        
        this.getAudioFilePath(youtubeId).then(filePath => {
            if (filePath) {
                return;
            }

            // Not cached and not downloading, start prefetch
            console.log(`[CM] Prefetching audio for: ${youtubeId}`);
            this.ensureAudioCached(youtubeId).catch(error => {
                console.error(`[CM] Background prefetch failed for ${youtubeId}:`, error.message);
            });

        }).catch(error => {
            console.error(`[CM] Error checking cache for prefetch ${youtubeId}:`, error);
        });
    }

    /**
     * Ensures thumbnail for a track is cached. Downloads if necessary.
     * Returns the file path if successful, null otherwise.
     */
    async ensureThumbnailCached(youtubeId: string): Promise<string | null> {
        console.log(`[CM] Ensuring thumbnail cache for: ${youtubeId}`);
         try {
            const cachedThumbnail = await this.databaseService.getThumbnailCache(youtubeId);
            if (cachedThumbnail && fs.existsSync(cachedThumbnail.filePath)) {
                console.log(`[CM] Thumbnail already cached for ${youtubeId}: ${cachedThumbnail.filePath}`);
                return cachedThumbnail.filePath;
            }

             console.log(`[CM] Thumbnail not cached for ${youtubeId}. Fetching info to get URL...`);
             const trackInfo = await getYoutubeInfo(youtubeId);
             if (!trackInfo || !trackInfo.thumbnail) {
                 throw new Error(`Could not get thumbnail URL for ${youtubeId}`);
             }

             const thumbnailUrl = trackInfo.thumbnail;
             const finalPath = path.join(this.thumbnailCacheDir, `${youtubeId}.jpg`);

             console.warn(`[CM] Thumbnail download not implemented yet. Skipping download for ${youtubeId}.`);
             return null;

         } catch (error) {
             console.error(`[CM] Failed to ensure thumbnail cache for ${youtubeId}:`, error);
             return null;
         }
    }

    /**
     * Retrieves the file path for a cached thumbnail. Does not trigger download.
     */
    async getThumbnailFilePath(youtubeId: string): Promise<string | null> {
        const expectedPath = path.join(this.thumbnailCacheDir, `${youtubeId}.jpg`);
        try {
            await fs.promises.access(expectedPath, fs.constants.F_OK);
            return expectedPath;
        } catch {
            return null;
        }
    }

    // --- Cleanup ---
    public destroy(): void {
        console.log('[CM] Destroying CacheManager...');
        this.downloadingTracks.clear();
        this.downloadLocks.clear();
        console.log('[CM] CacheManager destroyed.');
    }
}