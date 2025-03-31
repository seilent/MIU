import { Track, QueueItem, UserInfo } from './types.js';
import { DatabaseService } from './databaseService.js';
import { getYoutubeInfo, getYoutubeId, isValidYoutubeId } from '../../utils/youtube.js';
import { getThumbnailUrl } from '../../utils/youtubeMusic.js';
import { TrackStatus } from '../../types/enums.js';
import fs from 'fs';

export class TrackProcessor {
    constructor(
        private databaseService: DatabaseService
    ) {}

    /**
     * Process a track from URL/ID to get all necessary information
     * Returns processed track info and extracted video ID
     */
    async processTrack(youtubeUrlOrId: string, isMusicUrl: boolean = false): Promise<{
        success: boolean;
        message: string;
        videoId?: string;
        trackInfo?: Track;
    }> {
        try {
            let videoId: string;
            let detectedMusicUrl = isMusicUrl;

            // First check if input is already a valid YouTube ID
            if (isValidYoutubeId(youtubeUrlOrId)) {
                videoId = youtubeUrlOrId;
                
                // Check if we already have this track cached
                const existingTrack = await this.databaseService.getTrack(videoId);
                const existingCache = await this.databaseService.getAudioCache(videoId);
                
                if (existingTrack && existingCache && fs.existsSync(existingCache.filePath)) {
                    console.log(`[TrackProcessor] Using cached track: ${existingTrack.title}`);
                    return {
                        success: true,
                        message: 'Track found in cache.',
                        videoId,
                        trackInfo: existingTrack
                    };
                }
            } else {
                // Not a valid ID, try to extract from URL or search
                try {
                    const result = await getYoutubeId(youtubeUrlOrId);
                    if (!result.videoId) {
                        return { success: false, message: 'Failed to extract video ID from URL.' };
                    }
                    videoId = result.videoId;
                    detectedMusicUrl = result.isMusicUrl;

                    // Check cache after extracting ID
                    const existingTrack = await this.databaseService.getTrack(videoId);
                    const existingCache = await this.databaseService.getAudioCache(videoId);
                    
                    if (existingTrack && existingCache && fs.existsSync(existingCache.filePath)) {
                        console.log(`[TrackProcessor] Using cached track: ${existingTrack.title}`);
                        return {
                            success: true,
                            message: 'Track found in cache.',
                            videoId,
                            trackInfo: existingTrack
                        };
                    }
                } catch (error) {
                    console.error('[TrackProcessor] Failed to extract video ID:', error);
                    return { success: false, message: 'Failed to extract video ID from URL.' };
                }
            }

            // If we get here, we need to fetch track info from YouTube
            try {
                const info = await getYoutubeInfo(videoId, detectedMusicUrl);
                if (!info) {
                    return { success: false, message: 'Failed to fetch track information.' };
                }

                // Create track in database with complete info
                await this.databaseService.upsertTrack({
                    youtubeId: videoId,
                    title: info.title,
                    duration: info.duration,
                    channelId: info.channelId,
                    isMusicUrl: detectedMusicUrl,
                    resolvedYtId: null,
                    status: TrackStatus.STANDBY
                });

                const trackInfo = await this.databaseService.getTrack(videoId);
                if (!trackInfo) {
                    return { success: false, message: 'Failed to save track information.' };
                }

                return {
                    success: true,
                    message: 'Track processed successfully.',
                    videoId,
                    trackInfo
                };
            } catch (error) {
                console.error(`[TrackProcessor] Failed to fetch info for track ${videoId}:`, error);
                return { success: false, message: 'Failed to load track information.' };
            }
        } catch (error: any) {
            console.error('[TrackProcessor] Error processing track:', error);
            return { success: false, message: `An error occurred: ${error.message}` };
        }
    }

    /**
     * Create a queue item from track info and user info
     */
    createQueueItem(videoId: string, trackInfo: Track, userInfo: { userId: string } & Omit<UserInfo, 'id'>): QueueItem {
        return {
            youtubeId: videoId,
            title: trackInfo.title,
            thumbnail: getThumbnailUrl(videoId),
            duration: trackInfo.duration,
            requestedBy: {
                userId: userInfo.userId,
                username: userInfo.username,
                avatar: userInfo.avatar || undefined
            },
            requestedAt: new Date(),
            isAutoplay: false
        };
    }

    /**
     * Create a minimal track entry in the database
     * Used when we want to store the track ID but don't need full info yet
     */
    async createMinimalTrack(videoId: string, isMusicUrl: boolean = false): Promise<Track> {
        return await this.databaseService.upsertTrack({
            youtubeId: videoId,
            title: videoId, // Temporary title, will be updated when played
            duration: 0, // Will be updated when played
            isMusicUrl,
            resolvedYtId: null,
            status: TrackStatus.STANDBY
        });
    }

    /**
     * Process a batch of video IDs
     * Returns array of processed tracks and counts of successes/failures
     */
    async processBatch(videoIds: string[], isMusicUrl: boolean = false): Promise<{
        tracks: Track[];
        addedCount: number;
        skippedCount: number;
        errorCount: number;
    }> {
        const tracks: Track[] = [];
        let addedCount = 0;
        let skippedCount = 0;
        let errorCount = 0;

        await Promise.all(videoIds.map(async (videoId) => {
            try {
                if (!videoId) {
                    skippedCount++;
                    return;
                }

                // Check if track already exists
                const existingTrack = await this.databaseService.getTrack(videoId);
                if (existingTrack) {
                    tracks.push(existingTrack);
                    skippedCount++;
                    return;
                }

                // Create minimal track entry
                const track = await this.createMinimalTrack(videoId, isMusicUrl);
                tracks.push(track);
                addedCount++;
            } catch (error) {
                console.error(`[TrackProcessor] Error processing video ${videoId}:`, error);
                errorCount++;
            }
        }));

        return {
            tracks,
            addedCount,
            skippedCount,
            errorCount
        };
    }
} 