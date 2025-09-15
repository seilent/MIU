import { youtube_v3 } from 'googleapis';
import path from 'path';
import { TrackInfo, SearchResult } from './youtube.js';
import { getKeyManager, YouTubeKeyManager } from './YouTubeKeyManager.js';
import { isChannelBlocked } from './banManager.js';
import logger from './logger.js';

/**
 * Centralized YouTube API Manager
 * Handles all YouTube API operations including search, video info, recommendations,
 * and playlist management with automatic key rotation and rate limiting
 */

export interface SearchOptions {
  maxResults?: number;
  type?: 'video' | 'playlist' | 'channel';
  order?: 'date' | 'rating' | 'relevance' | 'title' | 'videoCount' | 'viewCount';
  publishedAfter?: string;
  publishedBefore?: string;
  regionCode?: string;
  relevanceLanguage?: string;
  videoDuration?: 'any' | 'long' | 'medium' | 'short';
  videoDefinition?: 'any' | 'high' | 'standard';
}

export interface VideoInfoOptions {
  includeStatistics?: boolean;
  includeSnippet?: boolean;
  includeContentDetails?: boolean;
  includeStatus?: boolean;
}

export interface PlaylistOptions {
  maxResults?: number;
  pageToken?: string;
}

export interface RecommendationOptions {
  seedVideoId: string;
  maxResults?: number;
  excludeBlockedChannels?: boolean;
  minRelevanceScore?: number;
}

export class YouTubeAPIManager {
  private youtube: youtube_v3.Youtube;
  private keyManager: YouTubeKeyManager;
  private apiCallCount: number = 0;
  private rateLimitReset: number = Date.now() + 86400000; // 24 hours

  constructor() {
    this.keyManager = getKeyManager();
    this.youtube = new youtube_v3.Youtube({});
    
    logger.info('YouTube API Manager initialized');
  }

  /**
   * Search YouTube videos with advanced options
   */
  async searchVideos(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const {
      maxResults = 25,
      type = 'video',
      order = 'relevance',
      videoDuration = 'any',
      videoDefinition = 'any'
    } = options;

    try {
      logger.info(`Searching YouTube: "${query}" with ${maxResults} results`);
      
      const apiKey = await this.keyManager.getCurrentKey('search.list');
      const response = await this.youtube.search.list({
        part: ['snippet'],
        q: query,
        type: [type],
        order,
        maxResults,
        videoDuration,
        videoDefinition,
        videoEmbeddable: 'true',
        videoSyndicated: 'true',
        publishedAfter: options.publishedAfter || undefined,
        publishedBefore: options.publishedBefore || undefined,
        regionCode: options.regionCode || undefined,
        relevanceLanguage: options.relevanceLanguage || undefined,
        key: apiKey
      });

      if (!response?.data?.items) {
        logger.warn(`No search results for: ${query}`);
        return [];
      }

      const results: SearchResult[] = [];
      for (const item of response.data.items) {
        if (!item.id?.videoId || !item.snippet) continue;

        // Check if channel is blocked
        if (options.type !== 'playlist' && await isChannelBlocked(item.snippet.channelId || undefined, item.snippet.channelTitle || undefined)) {
          logger.debug(`Skipping blocked channel: ${item.snippet.channelTitle}`);
          continue;
        }

        results.push({
          youtubeId: item.id.videoId,
          title: item.snippet.title || 'Unknown Title',
          thumbnail: item.snippet.thumbnails?.medium?.url || '',
          duration: 0 // Will be populated by batch video info call if needed
        });
      }

      logger.info(`Found ${results.length} valid search results for: ${query}`);
      return results;

    } catch (error) {
      logger.error(`YouTube search error for "${query}":`, error);
      return [];
    }
  }

  /**
   * Get detailed video information
   */
  async getVideoInfo(videoId: string, options: VideoInfoOptions = {}): Promise<TrackInfo | null> {
    const {
      includeStatistics = true,
      includeSnippet = true,
      includeContentDetails = true,
      includeStatus = false
    } = options;

    try {
      const parts: string[] = [];
      if (includeSnippet) parts.push('snippet');
      if (includeContentDetails) parts.push('contentDetails');
      if (includeStatistics) parts.push('statistics');
      if (includeStatus) parts.push('status');

      const apiKey = await this.keyManager.getCurrentKey('videos.list');
      const response = await this.youtube.videos.list({
        part: parts,
        id: [videoId],
        key: apiKey
      });

      const video = response?.data?.items?.[0];
      if (!video || !video.snippet) {
        logger.warn(`No video info found for: ${videoId}`);
        return null;
      }

      // Check if channel is blocked
      if (await isChannelBlocked(video.snippet.channelId || undefined, video.snippet.channelTitle || undefined)) {
        logger.info(`Video ${videoId} from blocked channel: ${video.snippet.channelTitle}`);
        return null;
      }

      const trackInfo: TrackInfo = {
        youtubeId: videoId,
        title: video.snippet.title || 'Unknown Title',
        channelTitle: video.snippet.channelTitle || 'Unknown Channel',
        channelId: video.snippet.channelId || '',
        thumbnail: video.snippet.thumbnails?.medium?.url || '',
        duration: this.parseDuration(video.contentDetails?.duration || undefined),
        viewCount: parseInt(video.statistics?.viewCount || '0'),
        likeCount: parseInt(video.statistics?.likeCount || '0'),
        description: video.snippet.description || '',
        publishedAt: video.snippet.publishedAt || '',
        tags: video.snippet.tags || []
      };

      logger.debug(`Retrieved info for video: ${trackInfo.title}`);
      return trackInfo;

    } catch (error) {
      logger.error(`Error getting video info for ${videoId}:`, error);
      return null;
    }
  }

  /**
   * Get multiple video info in batch
   */
  async getBatchVideoInfo(videoIds: string[], options: VideoInfoOptions = {}): Promise<TrackInfo[]> {
    if (videoIds.length === 0) return [];

    const batchSize = 50; // YouTube API limit
    const results: TrackInfo[] = [];

    for (let i = 0; i < videoIds.length; i += batchSize) {
      const batch = videoIds.slice(i, i + batchSize);
      
      try {
        const parts: string[] = [];
        if (options.includeSnippet !== false) parts.push('snippet');
        if (options.includeContentDetails !== false) parts.push('contentDetails');
        if (options.includeStatistics) parts.push('statistics');
        if (options.includeStatus) parts.push('status');

        const apiKey = await this.keyManager.getCurrentKey('videos.list');
        const response = await this.youtube.videos.list({
          part: parts,
          id: batch,
          key: apiKey
        });

        if (response?.data?.items) {
          for (const video of response.data.items) {
            if (!video.snippet || !video.id) continue;

            // Check if channel is blocked
            if (await isChannelBlocked(video.snippet.channelId || undefined, video.snippet.channelTitle || undefined)) {
              continue;
            }

            const trackInfo: TrackInfo = {
              youtubeId: video.id,
              title: video.snippet.title || 'Unknown Title',
              channelTitle: video.snippet.channelTitle || 'Unknown Channel',
              channelId: video.snippet.channelId || '',
              thumbnail: video.snippet.thumbnails?.medium?.url || '',
              duration: this.parseDuration(video.contentDetails?.duration || undefined),
              viewCount: parseInt(video.statistics?.viewCount || '0'),
              likeCount: parseInt(video.statistics?.likeCount || '0'),
              description: video.snippet.description || '',
              publishedAt: video.snippet.publishedAt || '',
              tags: video.snippet.tags || []
            };

            results.push(trackInfo);
          }
        }
      } catch (error) {
        logger.error(`Error in batch video info for batch starting at ${i}:`, error);
      }
    }

    logger.info(`Retrieved info for ${results.length}/${videoIds.length} videos`);
    return results;
  }

  /**
   * Get playlist items
   */
  async getPlaylistItems(playlistId: string, options: PlaylistOptions = {}): Promise<string[]> {
    const { maxResults = 50 } = options;
    const videoIds: string[] = [];
    let nextPageToken = options.pageToken;

    try {
      do {
        const apiKey = await this.keyManager.getCurrentKey('playlistItems.list');
        const response = await this.youtube.playlistItems.list({
          part: ['snippet'],
          playlistId,
          maxResults: Math.min(maxResults - videoIds.length, 50),
          pageToken: nextPageToken,
          key: apiKey
        });

        if (!response?.data?.items) break;

        for (const item of response.data.items) {
          if (item.snippet?.resourceId?.videoId) {
            videoIds.push(item.snippet.resourceId.videoId);
          }
        }

        nextPageToken = response.data.nextPageToken || undefined;
      } while (nextPageToken && videoIds.length < maxResults);

      logger.info(`Retrieved ${videoIds.length} items from playlist: ${playlistId}`);
      return videoIds;

    } catch (error) {
      logger.error(`Error getting playlist items for ${playlistId}:`, error);
      return [];
    }
  }

  /**
   * Get video recommendations based on a seed video
   */
  async getVideoRecommendations(options: RecommendationOptions): Promise<TrackInfo[]> {
    const {
      seedVideoId,
      maxResults = 10,
      excludeBlockedChannels = true,
      minRelevanceScore = 0.3
    } = options;

    try {
      // First get the seed video info to use for related search
      const seedInfo = await this.getVideoInfo(seedVideoId);
      if (!seedInfo) {
        logger.warn(`Cannot get recommendations - seed video ${seedVideoId} not found`);
        return [];
      }

      // Create search query based on seed video
      const searchQuery = `${seedInfo.title} ${seedInfo.channelTitle}`;
      
      const searchResults = await this.searchVideos(searchQuery, {
        maxResults: maxResults * 3, // Get more to filter out blocked channels
        order: 'relevance'
      });

      // Filter and score results
      const recommendations: TrackInfo[] = [];
      for (const result of searchResults) {
        if (result.youtubeId === seedVideoId) continue; // Skip the seed video itself
        
        // Get full video info
        const videoInfo = await this.getVideoInfo(result.youtubeId);
        if (!videoInfo) continue;

        // Skip if channel is blocked and exclusion is enabled
        if (excludeBlockedChannels && await isChannelBlocked(videoInfo.channelId, videoInfo.channelTitle)) {
          continue;
        }

        // Calculate relevance score (simplified)
        const relevanceScore = this.calculateRelevanceScore(seedInfo, videoInfo);
        if (relevanceScore >= minRelevanceScore) {
          recommendations.push(videoInfo);
        }

        if (recommendations.length >= maxResults) break;
      }

      logger.info(`Found ${recommendations.length} recommendations for video: ${seedVideoId}`);
      return recommendations;

    } catch (error) {
      logger.error(`Error getting recommendations for ${seedVideoId}:`, error);
      return [];
    }
  }

  /**
   * Calculate relevance score between two videos
   */
  private calculateRelevanceScore(seed: TrackInfo, candidate: TrackInfo): number {
    let score = 0;

    // Same channel gets high score
    if (seed.channelId === candidate.channelId) {
      score += 0.5;
    }

    // Similar duration gets some points
    const durationDiff = Math.abs((seed.duration || 0) - (candidate.duration || 0));
    if (durationDiff < 60) score += 0.2; // Within 1 minute
    else if (durationDiff < 300) score += 0.1; // Within 5 minutes

    // Tag similarity
    if (seed.tags && candidate.tags) {
      const commonTags = seed.tags.filter(tag => candidate.tags!.includes(tag));
      score += (commonTags.length / Math.max(seed.tags.length, candidate.tags.length)) * 0.3;
    }

    return Math.min(score, 1.0);
  }

  /**
   * Parse ISO 8601 duration to seconds
   */
  private parseDuration(duration?: string): number {
    if (!duration) return 0;

    const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!match) return 0;

    const hours = parseInt(match[1] || '0');
    const minutes = parseInt(match[2] || '0');
    const seconds = parseInt(match[3] || '0');

    return hours * 3600 + minutes * 60 + seconds;
  }


  /**
   * Get current API usage statistics
   */
  getUsageStats(): { apiCalls: number; currentKey: string; resetTime: number } {
    return {
      apiCalls: this.apiCallCount,
      currentKey: 'hidden',
      resetTime: this.rateLimitReset
    };
  }

  /**
   * Reset API usage counter (for testing)
   */
  resetUsageStats(): void {
    this.apiCallCount = 0;
    this.rateLimitReset = Date.now() + 86400000;
  }

  /**
   * Search YouTube Music using the YouTube Music API
   */
  async searchYoutubeMusic(query: string): Promise<Array<{ youtubeId: string; title: string; thumbnail?: string; duration?: number }>> {
    try {
      // Import YouTube Music API dynamically to avoid initialization issues
      const YoutubeMusicApi = (await import('youtube-music-api')).default;
      const api = new YoutubeMusicApi();
      await api.initalize(); // Note: library has typo in method name
      
      logger.info('Searching YouTube Music for:', query);
      
      // Add J-pop context if query doesn't contain Japanese
      let searchQuery = query;
      if (!/[一-龯ぁ-んァ-ン]/.test(query)) {
        searchQuery = `${query} jpop`;
      }

      const searchResults = await api.search(searchQuery, 'song');
      
      if (!searchResults || !searchResults.content || searchResults.content.length === 0) {
        logger.info('No results from YouTube Music API');
        return [];
      }

      // Map to our standard format
      const results = searchResults.content.map((item: any) => ({
        youtubeId: item.videoId,
        title: item.name,
        thumbnail: item.thumbnails?.[0]?.url || '',
        duration: item.duration || 0
      })).filter((result: any) => !!result.youtubeId);

      logger.info(`Found ${results.length} YouTube Music results`);
      return results;
      
    } catch (error) {
      logger.error('Error searching YouTube Music:', error);
      return [];
    }
  }

  /**
   * Get YouTube Music recommendations using yt-dlp and radio playlist
   */
  async getYoutubeRecommendations(
    seedTrackId: string, 
    options: { maxResults?: number; cookiesPath?: string } = {}
  ): Promise<Array<{ youtubeId: string; title?: string }>> {
    const { maxResults = 5, cookiesPath = path.join(process.cwd(), 'youtube_cookies.txt') } = options;
    
    try {
      // Check if cookies file exists
      const fs = await import('fs');
      await fs.promises.access(cookiesPath, fs.constants.R_OK);
      
      logger.info(`Fetching YouTube Music recommendations for: ${seedTrackId}`);
      
      // Import yt-dlp execution
      const execaModule = await import('execa');
      const execa = execaModule.default;
      const ytdlpPath = path.join(process.cwd(), 'node_modules/yt-dlp-exec/bin/yt-dlp');
      
      // Get the radio/mix playlist for this track
      const radioUrl = `https://music.youtube.com/watch?v=${seedTrackId}&list=RDAMVM${seedTrackId}`;
      
      const { stdout } = await execa(ytdlpPath, [
        radioUrl,
        '--cookies', cookiesPath,
        '--flat-playlist',
        '--dump-json',
        '--no-download'
      ]);
      
      if (!stdout || stdout.trim() === '') {
        logger.info('No output from yt-dlp command');
        return [];
      }
      
      const items = stdout.split('\n')
        .filter(line => line.trim())
        .map(line => JSON.parse(line))
        .filter(item => item.id !== seedTrackId) // Exclude seed track
        .slice(0, maxResults * 2); // Get more to filter from
        
      const recommendations = items.map(item => ({
        youtubeId: item.id,
        title: item.title,
        channel: item.channel,
        channel_id: item.channel_id
      }));
      
      logger.info(`Found ${recommendations.length} raw recommendations for ${seedTrackId}`);
      return recommendations;
      
    } catch (error) {
      if ((error as any).code === 'ENOENT') {
        logger.info('YouTube cookies file not found, recommendations unavailable');
      } else {
        logger.error('Failed to get YouTube Music recommendations:', error);
      }
      return [];
    }
  }

  /**
   * Alias for getPlaylistItems that returns video info objects
   */
  async getPlaylistVideos(playlistId: string, options: PlaylistOptions = {}): Promise<Array<{videoId: string, title: string, duration?: number}>> {
    try {
      const videoIds = await this.getPlaylistItems(playlistId, options);
      const videos = await this.getBatchVideoInfo(videoIds);
      return videos.map(video => ({
        videoId: video.youtubeId,
        title: video.title || video.youtubeId,
        duration: video.duration
      }));
    } catch (error) {
      logger.error('Error getting playlist videos:', error);
      return [];
    }
  }
}

/**
 * Singleton instance
 */
let youtubeAPIManagerInstance: YouTubeAPIManager | null = null;

export function getYouTubeAPIManager(): YouTubeAPIManager {
  if (!youtubeAPIManagerInstance) {
    youtubeAPIManagerInstance = new YouTubeAPIManager();
  }
  return youtubeAPIManagerInstance;
}