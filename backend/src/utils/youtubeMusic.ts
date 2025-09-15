import YoutubeMusicApi from 'youtube-music-api';
import { prisma } from '../db.js';
import fs from 'fs';
import path from 'path';
import type { SearchResult } from './types.js';
import { google } from 'googleapis';
import { getYoutubeInfo, youtube, processImage } from './youtube.js';
import { executeYoutubeApi } from './youtubeApi.js';
import { filterBlockedMusicContent, isLikelyJapaneseSong, BLOCKED_KEYWORDS } from './contentFilter.js';
import fetch from 'node-fetch';
import { extractYoutubeId } from './validationHelpers.js';
import execa from 'execa';
import sharp from 'sharp';
import { getKeyManager } from './YouTubeKeyManager.js';

// API base URL for thumbnails
const API_BASE_URL = process.env.API_BASE_URL;

// Cache directory configuration
const CACHE_DIR = process.env.CACHE_DIR || path.join(process.cwd(), 'cache');
const THUMBNAIL_CACHE_DIR = path.join(CACHE_DIR, 'albumart');

// Initialize YouTube Music API
const api = new YoutubeMusicApi();
let apiInitialized = false;

// Add state control for recommendations
let recommendationsEnabled = false; // Default to disabled

// Helper function to ensure API is initialized
async function ensureApiInitialized() {
  if (!apiInitialized) {
    await api.initalize(); // Note: the library has a typo in the method name
    apiInitialized = true;
  }
}

/**
 * Enable or disable YouTube Music recommendations
 * @param enabled Whether to enable recommendations
 * @returns Current state of recommendations
 */
export function setRecommendationsEnabled(enabled: boolean): boolean {
  recommendationsEnabled = enabled;
  console.log(`YouTube Music recommendations ${enabled ? 'enabled' : 'disabled'}`);
  return recommendationsEnabled;
}

/**
 * Get current state of recommendations
 * @returns Whether recommendations are enabled
 */
export function isRecommendationsEnabled(): boolean {
  return recommendationsEnabled;
}

/**
 * Get the URL for a thumbnail based on the YouTube ID
 * Checks if the thumbnail exists in the cache directory first
 * @param youtubeId The YouTube ID to get the thumbnail URL for
 * @returns The URL to the thumbnail
 */
export function getThumbnailUrl(youtubeId: string): string {
  if (!youtubeId) return '';
  
  // Check if the thumbnail exists in the cache
  const cachePath = path.join(THUMBNAIL_CACHE_DIR, `${youtubeId}.jpg`);
  
  // If we have a thumbnail in cache, use the API endpoint
  return `${API_BASE_URL}/api/albumart/${youtubeId}`;
}

/**
 * Download and cache a thumbnail for a given video ID
 * @param youtubeId The YouTube video ID to cache thumbnail for
 * @param thumbnailUrl The URL of the thumbnail to download
 */
export async function downloadAndCacheThumbnail(youtubeId: string, thumbnailUrl: string): Promise<void> {
  const cachePath = path.join(THUMBNAIL_CACHE_DIR, `${youtubeId}.jpg`);
  
  // Ensure cache directory exists
  await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
  
  // Check if cached thumbnail is recent (< 2 weeks old)
  try {
    const stats = await fs.promises.stat(cachePath);
    const fileAge = Date.now() - stats.mtimeMs;
    const twoWeeks = 14 * 24 * 60 * 60 * 1000;
    
    if (fileAge < twoWeeks) {
      console.log(`Using cached thumbnail for ${youtubeId}`);
      return;
    }
  } catch (error) {
    // File doesn't exist, continue with download
  }
  
  const downloadThumbnail = async (url: string, isOriginal: boolean = true): Promise<Buffer> => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download ${isOriginal ? 'original' : 'fallback'} thumbnail: ${response.statusText}`);
    }
    
    const buffer = await response.arrayBuffer();
    const imageBuffer = Buffer.from(buffer);
    
    // Process image if available, otherwise use original
    try {
      return await processImage(imageBuffer);
    } catch (processError) {
      if (isOriginal) throw processError; // Re-throw for original, fallback should accept unprocessed
      return imageBuffer;
    }
  };
  
  try {
    console.log(`Downloading thumbnail for ${youtubeId}`);
    
    // Try original URL first, then fallback
    let processedImage: Buffer;
    try {
      processedImage = await downloadThumbnail(thumbnailUrl, true);
    } catch (error) {
      console.log(`Original thumbnail failed, trying fallback`);
      const fallbackUrl = `https://i.ytimg.com/vi/${youtubeId}/maxresdefault.jpg`;
      processedImage = await downloadThumbnail(fallbackUrl, false);
    }
    
    // Write file and update database
    await fs.promises.writeFile(cachePath, processedImage);
    
    const metadata = await sharp(processedImage).metadata();
    
    await prisma.thumbnailCache.upsert({
      where: { youtubeId },
      update: {
        filePath: cachePath,
        width: metadata.width || 0,
        height: metadata.height || 0,
        updatedAt: new Date()
      },
      create: {
        youtubeId,
        filePath: cachePath,
        width: metadata.width || 0,
        height: metadata.height || 0
      }
    });
    
    console.log(`Thumbnail cached for ${youtubeId}`);
    
  } catch (error) {
    console.error(`Failed to download thumbnail for ${youtubeId}:`, error);
  }
}

/**
 * Search YouTube Music for tracks
 * @param query Search query
 * @returns Array of search results
 */
export async function searchYoutubeMusic(query: string): Promise<SearchResult[]> {
  try {
    // Use YouTubeAPIManager for YouTube Music search
    const { getYouTubeAPIManager } = await import('./youtubeApiManager.js');
    const youtubeAPI = getYouTubeAPIManager();
    
    const results = await youtubeAPI.searchYoutubeMusic(query);
    
    // Apply content filtering 
    const filteredContent = await filterBlockedMusicContent(results.map(item => ({
      videoId: item.youtubeId,
      name: item.title,
      thumbnails: item.thumbnail ? [{ url: item.thumbnail }] : [],
      duration: item.duration
    })));
    
    console.log(`Found ${results.length} results, ${filteredContent.length} after filtering`);

    // Convert back to SearchResult format
    return filteredContent.map(item => ({
      youtubeId: item.videoId,
      title: item.name,
      thumbnail: item.thumbnails?.[0]?.url || '',
      duration: item.duration || 0
    }));

  } catch (error) {
    console.error('Error searching YouTube Music:', error);
    return [];
  }
}

/**
 * Get recommendations from YouTube Music based on a seed track
 * @param seedTrackId YouTube video ID of the seed track
 * @returns Array of recommended track IDs
 */
export async function getYoutubeMusicRecommendations(seedTrackId: string): Promise<Array<{ youtubeId: string }>> {
  try {
    // Check if recommendations are enabled
    if (!recommendationsEnabled) {
      console.log('YouTube Music recommendations are currently disabled');
      return [];
    }

    // Check if the seed track is Japanese
    const trackDetails = await prisma.track.findUnique({
      where: { youtubeId: seedTrackId },
      select: { title: true }
    });
    
    if (trackDetails) {
      if (!isLikelyJapaneseSong(trackDetails.title, '', [], [])) {
        console.log(`Seed track ${seedTrackId} "${trackDetails.title}" is not likely Japanese. Skipping YouTube Music recommendations.`);
        return [];
      }
    }

    // Use YouTubeAPIManager for yt-dlp based recommendations
    const { getYouTubeAPIManager } = await import('./youtubeApiManager.js');
    const youtubeAPI = getYouTubeAPIManager();
    
    const rawRecommendations = await youtubeAPI.getYoutubeRecommendations(seedTrackId, {
      maxResults: 20
    });
    
    if (rawRecommendations.length > 0) {
      // Filter recommendations through content filters
      const processedItems = rawRecommendations.map(rec => ({
        name: rec.title || '',
        artist: { name: (rec as any).channelTitle || '' },
        videoId: rec.youtubeId
      }));
      
      const filteredContent = await filterBlockedMusicContent(processedItems);
      
      // Apply Japanese-only filtering
      const japaneseContent = filteredContent.filter(item => 
        isLikelyJapaneseSong(item.name, item.artist?.name || '', [], [])
      );
      
      const recommendations = japaneseContent
        .slice(0, 20)
        .map(item => ({ youtubeId: item.videoId }));
      
      console.log(`Returning ${recommendations.length} YouTube Music recommendations after filtering`);
      return recommendations;
    }
    
    // Fallback to YouTube Music API method if yt-dlp fails
    console.log('Falling back to YouTube Music API method');
    await ensureApiInitialized();
    
    // Try radio playlist first
    try {
      const response = await api.getPlaylist(`RDAMVM${seedTrackId}`);
      
      if (response && response.content && response.content.length > 0) {
        const filteredTracks = response.content
          .filter((track: any) => track.videoId && track.videoId !== seedTrackId);
          
        const filteredContent = await filterBlockedMusicContent(filteredTracks);
        
        const japaneseContent = filteredContent.filter((track: any) => 
          isLikelyJapaneseSong(track.name || '', track.artist?.name || '', [], [])
        );
        
        return japaneseContent.map((track: any) => ({ youtubeId: track.videoId }));
      }
    } catch (error) {
      console.log(`Failed to get radio playlist, trying search fallback`);
    }
    
    // Search fallback
    if (trackDetails) {
      const searchQuery = trackDetails.title
        .replace(/【.*?】|\[.*?\]|feat\.|ft\./gi, '')
        .replace(/\(.*?\)/g, '')
        .trim();
      
      const searchResults = await api.search(`${searchQuery} Japanese`, 'song');
      
      if (searchResults && searchResults.content && searchResults.content.length > 0) {
        const filteredTracks = searchResults.content
          .filter((track: any) => track.videoId && track.videoId !== seedTrackId);
        
        const filteredContent = await filterBlockedMusicContent(filteredTracks);
        
        const japaneseContent = filteredContent.filter((track: any) => 
          isLikelyJapaneseSong(track.name || '', track.artist?.name || '', [], [])
        );
        
        return japaneseContent.slice(0, 10).map((track: any) => ({ youtubeId: track.videoId }));
      }
    }
    
    console.log('No recommendations available');
    return [];
  } catch (error) {
    console.error('YouTube Music recommendations failed:', error);
    return [];
  }
}

// Function to check if a URL is a YouTube Music URL
export function isYoutubeMusicUrl(url: string): boolean {
  return url.includes('music.youtube.com');
}

export async function resolveToRegularYoutube(input: string): Promise<{ resolvedId: string; isMusicUrl: boolean }> {
  const isMusicUrl = isYoutubeMusicUrl(input);
  
  // Extract YouTube ID from the input (whether it's a URL or just an ID)
  let youtubeId: string;
  
  if (isMusicUrl) {
    // For YouTube Music URLs, extract the video ID
    const musicUrlMatch = input.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
    if (musicUrlMatch) {
      youtubeId = musicUrlMatch[1];
    } else {
      // Try to resolve Music ID to regular YouTube ID
      const resolved = await resolveYouTubeMusicId(input);
      if (!resolved) {
        throw new Error('Could not resolve YouTube Music URL');
      }
      youtubeId = resolved;
    }
  } else {
    // For regular YouTube URLs or IDs, extract the ID
    const extractedId = extractYoutubeId(input);
    if (!extractedId) {
      throw new Error('Invalid YouTube URL or ID');
    }
    youtubeId = extractedId;
  }
  
  return {
    resolvedId: youtubeId,
    isMusicUrl
  };
}

// Function to resolve a YouTube Music ID to a regular YouTube ID
export async function resolveYouTubeMusicId(musicId: string): Promise<string | null> {
  console.log('=== Downloading and caching audio ===');
  console.log(`Using original youtubeId for cache: ${musicId}`);
  
  // With cookies, we can use the original Music ID directly
  // First verify with yt-dlp that the video is actually available
  const ytdlpPath = path.join(process.cwd(), 'node_modules/yt-dlp-exec/bin/yt-dlp');
  
  // Check if cookies file exists in the backend directory
  const cookiesPath = path.join(process.cwd(), 'youtube_cookies.txt');
  let cookiesExist = false;
  try {
    await fs.promises.access(cookiesPath, fs.constants.R_OK);
    cookiesExist = true;
    console.log(`Using cookies for authentication`);
  } catch (error) {
    console.log(`No cookies file found, proceeding without authentication`);
  }
  
  try {
    // Prepare command arguments
    const args = [
      musicId,
      '--no-download',
      '--no-warnings',
      '--quiet'
    ];
    
    // Add cookies if available
    if (cookiesExist) {
      args.push('--cookies', cookiesPath);
    }
    
    await execa(ytdlpPath, args);
    
    console.log(`Using resolvedId for content: ${musicId}`);
    
    // With cookies, we can use the original Music ID directly
    return musicId;
  } catch (error: any) {
    const errorMessage = error?.stderr || error?.message || 'Unknown error';
    
    // Check if cookies file exists (need to check again in this scope)
    let cookiesExist = false;
    try {
      await fs.promises.access(cookiesPath, fs.constants.R_OK);
      cookiesExist = true;
    } catch (e) {
      // No cookies file found
    }
    
    // If the error is about premium content and we don't have cookies, log a specific message
    if (errorMessage.includes('Premium') && !cookiesExist) {
      console.log('❌ This content requires YouTube Music Premium and no cookies file was found');
    } else {
      console.log('✗ Video is not available via yt-dlp:', errorMessage);
    }
    
    // If we have cookies but still got an error, the video might not be available
    // Try to find an alternative video as a fallback
    return await searchBasedFallback(musicId);
  }
}

/**
 * Fallback method that searches YouTube for the track
 * @param musicId Original music ID (for logging)
 * @param title Optional title if available
 * @returns Alternative video ID or null
 */
async function searchBasedFallback(musicId: string, title?: string): Promise<string | null> {
  if (!title) {
    console.log('✗ No title available for search fallback');
    return null;
  }
  
  console.log(`Attempting search fallback for "${title}"`);
  
  try {
    const youtubeApi = google.youtube('v3');
    const searchResponse = await executeYoutubeApi('search.list', async (apiKey) => {
      return youtubeApi.search.list({
        key: apiKey,
        part: ['snippet'],
        q: title,
        type: ['video'],
        maxResults: 5
      });
    });

    const videos = searchResponse.data.items;
    if (!videos || videos.length === 0) {
      console.log('✗ No search results found');
      return null;
    }

    // Get the first result's video ID
    const regularYoutubeId = videos[0].id?.videoId;
    if (!regularYoutubeId) {
      console.log('✗ No video ID in search results');
      return null;
    }

    // Verify the found video is available
    try {
      const ytdlpPath = path.join(process.cwd(), 'node_modules/yt-dlp-exec/bin/yt-dlp');
      await execa(ytdlpPath, [
        regularYoutubeId,
        '--no-download',
        '--no-warnings',
        '--quiet'
      ]);
      
      console.log(`✓ Found alternative video from search: ${regularYoutubeId}`);
      
      // Get the video title from search results to log it
      const videoTitle = videos[0].snippet?.title;
      console.log(`Alternative video title: "${videoTitle}"`);
      
      // Download and cache thumbnail using the ORIGINAL music ID
      await cacheVideoThumbnail(regularYoutubeId, musicId);
      
      return regularYoutubeId;
    } catch (verifyError: unknown) {
      const errorMessage = verifyError instanceof Error ? verifyError.message : 'Unknown error';
      console.log(`✗ Alternative video ${regularYoutubeId} is not available:`, errorMessage);
      
      // Try next video in search results
      const ytdlpPath = path.join(process.cwd(), 'node_modules/yt-dlp-exec/bin/yt-dlp');
      for (let i = 1; i < videos.length; i++) {
        const altVideoId = videos[i].id?.videoId;
        if (!altVideoId) continue;
        
        // Check if this is an instrumental version - skip if it is
        const altTitle = videos[i].snippet?.title || '';
        if (isInstrumentalTrack(altTitle)) {
          console.log(`Skipping instrumental track: ${altTitle}`);
          continue;
        }
        
        try {
          await execa(ytdlpPath, [
            altVideoId,
            '--no-download',
            '--no-warnings',
            '--quiet'
          ]);
          
          console.log(`✓ Found alternative video from search (result #${i+1}): ${altVideoId}`);
          
          // Download and cache thumbnail using the ORIGINAL music ID
          await cacheVideoThumbnail(altVideoId, musicId);
          
          return altVideoId;
        } catch (nextVerifyError) {
          console.log(`✗ Alternative video ${altVideoId} is not available`);
        }
      }
      
      console.log('✗ None of the search results are available');
      return null;
    }
  } catch (searchError: any) {
    // Check if this is a quota exceeded error
    const reason = searchError?.errors?.[0]?.reason;
    if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
      console.log('❌ API quota exceeded during search fallback');
      const currentKey = await getKeyManager().getCurrentKey('search');
      getKeyManager().markKeyAsQuotaExceeded(currentKey, 'search');
      
      // Try again with a different key if available
      const keys = await getKeyManager().getAllKeys();
      if (keys.length > 1) {
        console.log('Trying again with a different API key...');
        return searchBasedFallback(musicId, title);
      }
    }
    
    console.error('Error during search fallback:', searchError);
    return null;
  }
}

/**
 * Helper function to check if a track is an instrumental version
 * @param title The track title
 * @returns True if the track is likely an instrumental version
 */
function isInstrumentalTrack(title: string): boolean {
  // Use the shared BLOCKED_KEYWORDS from contentFilter
  const instrumentalKeywords = [
    'instrumental', 'インストゥルメンタル', 'インスト',
    'karaoke', 'カラオケ',
    'backing track', 'off vocal', 'オフボーカル',
    'no lyrics', 'no vocal', 'ノーボーカル'
  ];
  
  const lowerTitle = title.toLowerCase();
  
  // First check if the title contains any instrumental keywords from the common list
  if (BLOCKED_KEYWORDS.some(keyword => 
    lowerTitle.includes(keyword.toLowerCase()) && 
    (keyword === 'instrumental' || keyword === 'インストゥルメンタル' || 
     keyword === 'karaoke' || keyword === 'カラオケ')
  )) {
    return true;
  }
  
  // Then check for specific instrumental-only keywords
  return instrumentalKeywords.some(keyword => 
    lowerTitle.includes(keyword.toLowerCase())
  );
}

/**
 * Helper function to download and cache video thumbnail using the original Music ID
 * @param videoId The actual video ID used for fetching the thumbnail
 * @param originalMusicId The original Music ID to use as the cache key
 */
async function cacheVideoThumbnail(videoId: string, originalMusicId: string): Promise<void> {
  try {
    // Get video info from YouTube API to create track entry
    const info = await getYoutubeInfo(videoId);
    if (!info) return;

    // Get best quality thumbnail URL
    const youtubeApi = google.youtube('v3');
    const apiKey = await getKeyManager().getCurrentKey('videos.list');
    
    const videoResponse = await youtubeApi.videos.list({
      key: apiKey,
      part: ['snippet'],
      id: [videoId]
    });

    const video = videoResponse.data.items?.[0];
    if (!video || !video.snippet) return;
    
    const thumbnails = video.snippet.thumbnails || {};
    const bestThumbnail = thumbnails.maxres?.url || 
                          thumbnails.high?.url || 
                          thumbnails.medium?.url || 
                          thumbnails.default?.url;

    if (bestThumbnail) {
      // Download and cache the thumbnail using the ORIGINAL music ID
      await downloadAndCacheThumbnail(originalMusicId, bestThumbnail);
      
      // Create track entry for the original music ID
      await prisma.track.upsert({
        where: { youtubeId: originalMusicId },
        update: {
          title: info.title,
          duration: info.duration,
          resolvedYtId: videoId, // Use resolvedYtId instead of resolvedId
          updatedAt: new Date()
        },
        create: {
          youtubeId: originalMusicId,
          title: info.title,
          duration: info.duration,
          resolvedYtId: videoId // Use resolvedYtId instead of resolvedId
        }
      });
      
      console.log(`✓ Cached thumbnail and created track entry for ${originalMusicId} (resolved to ${videoId})`);
    }
  } catch (error) {
    console.error(`Failed to cache thumbnail for ${originalMusicId}:`, error);
  }
}

/**
 * Search for alternative video ID using title and channel info
 * @param title The title from oEmbed
 * @param channelId The channel ID from oEmbed
 * @param originalMusicId The original YouTube Music ID
 * @returns The alternative video ID if found, null otherwise
 */
async function findAlternativeVideoId(title: string, channelId: string, originalMusicId: string): Promise<string | null> {
  try {
    console.log(`\nSearching for alternative video from channel: ${channelId}`);
    
    const youtubeApi = google.youtube('v3');
    
    // Search for videos with the exact title from the same channel
    try {
      const searchResponse = await executeYoutubeApi('search.list', async (apiKey) => {
        return youtubeApi.search.list({
          key: apiKey,
          part: ['id', 'snippet'],
          q: title,
          type: ['video'],
          channelId: channelId,
          maxResults: 5
        });
      });

      const videos = searchResponse.data.items;
      if (!videos || videos.length === 0) {
        console.log('✗ No videos found from the same channel');
        return null;
      }

      // Filter out instrumental versions first
      const nonInstrumentalVideos = videos.filter(video => {
        const videoTitle = video.snippet?.title || '';
        return !isInstrumentalTrack(videoTitle);
      });
      
      // Use non-instrumental videos if available, otherwise use all videos
      const targetVideos = nonInstrumentalVideos.length > 0 ? nonInstrumentalVideos : videos;
      
      // Get the first result from the same channel that's available
      for (const video of targetVideos) {
        const videoId = video.id?.videoId;
        if (!videoId) continue;

        const foundTitle = video.snippet?.title || '';
        
        // Verify the video is accessible
        try {
          // First verify with yt-dlp that the video is actually available
          const ytdlpPath = path.join(process.cwd(), 'node_modules/yt-dlp-exec/bin/yt-dlp');
          
          // Check if cookies file exists
          const cookiesPath = path.join(process.cwd(), 'youtube_cookies.txt');
          let cookiesExist = false;
          try {
            await fs.promises.access(cookiesPath, fs.constants.R_OK);
            cookiesExist = true;
          } catch (error) {
            // No cookies file found
          }
          
          // Prepare command arguments
          const args = [
            videoId,
            '--no-download',
            '--no-warnings',
            '--quiet'
          ];
          
          // Add cookies if available
          if (cookiesExist) {
            args.push('--cookies', cookiesPath);
          }
          
          await execa(ytdlpPath, args);
          
          // Get video info from YouTube API
          await cacheVideoThumbnail(videoId, originalMusicId);
          
          console.log(`✓ Found alternative video: ${videoId} (${foundTitle})`);
          return videoId;
        } catch (verifyError) {
          // Check if the error is about premium content
          const errorMessage = verifyError instanceof Error ? verifyError.message : 'Unknown error';
          
          // Check if cookies file exists (need to check again in this scope)
          const cookiesPath = path.join(process.cwd(), 'youtube_cookies.txt');
          let cookiesExist = false;
          try {
            await fs.promises.access(cookiesPath, fs.constants.R_OK);
            cookiesExist = true;
          } catch (e) {
            // No cookies file found
          }
          
          // If the error is about premium content and we don't have cookies, log a specific message
          if (errorMessage.includes('Premium') && !cookiesExist) {
            console.log(`✗ Failed to verify video ${videoId}: This content requires YouTube Music Premium and no cookies file was found`);
          } else {
            console.log(`✗ Failed to verify video ${videoId}`);
          }
          continue;
        }
      }
    } catch (searchError: any) {
      // Check if this is a quota exceeded error
      const reason = searchError?.errors?.[0]?.reason;
      if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
        console.error('Error searching for alternative video:', searchError);
        const currentKey = await getKeyManager().getCurrentKey('search');
        getKeyManager().markKeyAsQuotaExceeded(currentKey, 'search');
        
        // Try again with a different key if available
        const keys = await getKeyManager().getAllKeys();
        if (keys.length > 1) {
          console.log('Trying again with a different API key...');
          return findAlternativeVideoId(title, channelId, originalMusicId);
        } else {
          console.log('❌ All API keys are quota exceeded');
          return null;
        }
      } else {
        console.error('Error searching for videos:', searchError);
        return null;
      }
    }
  } catch (error) {
    console.error('Error finding alternative video:', error);
    return null;
  }
  
  return null;
}

// Function to calculate similarity between two titles
function calculateTitleSimilarity(title1: string, title2: string): number {
  console.log('\nCalculating title similarity:');
  
  // Clean both titles
  const clean1 = cleanTitle(title1);
  const clean2 = cleanTitle(title2);
  
  console.log(`Cleaned title 1: "${clean1}"`);
  console.log(`Cleaned title 2: "${clean2}"`);
  
  // If either title is empty after cleaning, they're not similar
  if (!clean1 || !clean2) {
    console.log('One or both titles are empty after cleaning');
    return 0;
  }
  
  // Direct match after cleaning
  if (clean1 === clean2) {
    console.log('Exact match after cleaning');
    return 1;
  }
  
  // Check if one title contains the other
  if (clean1.includes(clean2) || clean2.includes(clean1)) {
    console.log('One title contains the other');
    return 0.9;
  }
  
  // Split into words and check overlap
  const words1 = clean1.split(/\s+/);
  const words2 = clean2.split(/\s+/);
  
  console.log(`Title 1 words: [${words1.join(', ')}]`);
  console.log(`Title 2 words: [${words2.join(', ')}]`);
  
  // If one title has only one word, require exact match
  if (words1.length === 1 || words2.length === 1) {
    console.log('One title has only one word, requiring exact match');
    return clean1 === clean2 ? 1 : 0;
  }
  
  // Count matching words
  const matchingWords = words1.filter(word => 
    words2.some(w2 => {
      const exactMatch = w2 === word;
      const partialMatch = word.length > 2 && w2.includes(word) || 
                          w2.length > 2 && word.includes(w2);
      if (exactMatch) console.log(`Exact word match: "${word}"`);
      if (partialMatch) console.log(`Partial word match: "${word}" ~ "${w2}"`);
      return exactMatch || partialMatch;
    })
  );
  
  // Calculate similarity score
  const similarityScore = matchingWords.length / Math.max(words1.length, words2.length);
  console.log(`Similarity score: ${similarityScore}`);
  return similarityScore;
}

// Function to clean the title for better comparison
function cleanTitle(title: string): string {
  return title.replace(/【.*?】|\[.*?\]|feat\.|ft\./gi, '').replace(/\(.*?\)/g, '').trim();
}
