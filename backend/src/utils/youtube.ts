import { google, youtube_v3 } from 'googleapis';
import path from 'path';
import fs from 'fs';
import { mkdir, access } from 'fs/promises';
import { spawn, exec } from 'child_process';
import ffmpeg from 'ffmpeg-static';
import ffprobe from 'ffprobe-static';
import ytDlp from 'yt-dlp-exec';
import ytdl from 'ytdl-core';
import { promisify } from 'util';
import fetch from 'node-fetch';
import { prisma } from '../db.js';
import sharp from 'sharp';
import crypto from 'crypto';
import { exec as execa } from 'child_process';
import type { ChildProcess } from 'child_process';
import { Readable, Writable } from 'stream';
import { getRootDir } from './env.js';
import { Prisma } from '@prisma/client';
import { downloadAndCacheThumbnail, getThumbnailUrl } from './youtubeMusic.js';
import { MAX_DURATION, MIN_DURATION } from '../config.js';
import { decodeHTML } from 'entities';
import axios from 'axios';
import { getKeyManager } from './YouTubeKeyManager.js';

// Configure FFmpeg path
if (ffmpeg && ffprobe) {
  process.env.FFMPEG_PATH = ffmpeg;
  process.env.FFPROBE_PATH = ffprobe.path;
  console.log('Using FFmpeg from:', ffmpeg);
  console.log('Using FFprobe from:', ffprobe.path);
} else {
  console.error('FFmpeg or FFprobe not found in packages');
}

// Cache directory configuration
const CACHE_DIR = process.env.CACHE_DIR || path.join(process.cwd(), 'cache');
const AUDIO_CACHE_DIR = path.join(CACHE_DIR, 'audio');
const THUMBNAIL_CACHE_DIR = path.join(CACHE_DIR, 'albumart');

// Create cache directories
async function ensureCacheDirectories() {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await mkdir(AUDIO_CACHE_DIR, { recursive: true });
    await mkdir(THUMBNAIL_CACHE_DIR, { recursive: true });
  } catch (error) {
    console.error('Failed to create cache directories:', error);
  }
}

// Ensure cache directories exist on startup
ensureCacheDirectories().catch(console.error);

// YouTube API key manager
class YouTubeKeyManager {
  private keys: string[];
  private currentKeyIndex: number = 0;
  private keyUsage: Map<string, { 
    minuteCount: number; 
    minuteResetTime: number;
    dailyCount: number;
    dailyResetTime: number;
    quotaExceeded: boolean;
    quotaExceededOperations: Set<string>; // Track which operations have exceeded quota
    lastUsed: number;
  }>;
  private readonly RATE_LIMIT = 50; // Requests per minute per key
  private readonly DAILY_QUOTA = 10000; // Daily quota units per key
  private readonly MINUTE_RESET = 60000; // 1 minute in milliseconds
  private readonly DAILY_RESET = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
  private readonly QUOTA_COSTS = {
    'search.list': 100,
    'videos.list': 1,
    'playlistItems.list': 1
  };

  constructor() {
    // Get API keys from environment variables
    const apiKeys = process.env.YOUTUBE_API_KEYS?.split(',').filter(Boolean) || [];
    const singleKey = process.env.YOUTUBE_API_KEY;

    // Combine all available keys and remove duplicates
    const allKeys = [...apiKeys, ...(singleKey ? [singleKey] : [])];
    this.keys = [...new Set(allKeys)];
    
    if (this.keys.length === 0) {
      throw new Error('No YouTube API keys configured');
    }

    // Log if duplicates were found
    if (allKeys.length !== this.keys.length) {
      console.warn(`Found ${allKeys.length - this.keys.length} duplicate YouTube API keys. Duplicates have been removed.`);
    }

    this.keyUsage = new Map();
    this.initializeKeyUsage();
    
    // Start periodic cleanup of usage data
    setInterval(() => this.cleanupUsageData(), 5 * 60 * 1000); // Every 5 minutes
    
    // Log number of available keys
    console.log(`Initialized YouTube API with ${this.keys.length} API key(s)`);

    // Remove automatic validation since it's done in initializeYouTubeAPI
    // validateKeys() will be called explicitly when needed
  }

  public async validateKeys() {
    console.log('Validating YouTube API keys...');
    
    // Track validation results
    let validCount = 0;
    let invalidCount = 0;
    let quotaExceededCount = 0;
    let partiallyAvailableCount = 0;
    
    // Use Promise.all to validate all keys in parallel
    const validationPromises = this.keys.map(async (key, index) => {
      // Check if this key is already marked for any operations
      const usage = this.keyUsage.get(key);
      const hasAnyQuotaExceeded = usage?.quotaExceededOperations.size ?? 0 > 0;
      const keyPrefix = `[${index + 1}/${this.keys.length}] API key *****${key.slice(-5)}`;
      
      // If globally quota exceeded, log and skip validation
      if (usage?.quotaExceeded) {
        console.log(`${keyPrefix} is globally quota exceeded, skipping validation`);
        quotaExceededCount++;
        return false;
      }
      
      // If some operations are quota exceeded but not globally, still test it
      if (hasAnyQuotaExceeded) {
        console.log(`${keyPrefix} has quota exceeded for ${usage!.quotaExceededOperations.size} operations, testing search capability`);
        partiallyAvailableCount++;
      }
      
      try {
        // Try a simple API call to check if the key works for search
        await youtube.search.list({
          key,
          part: ['id'],
          q: 'test',
          maxResults: 1,
          type: ['video']
        });
        
        if (hasAnyQuotaExceeded) {
          console.log(`✓ ${keyPrefix} is valid for search.list and partially available (some operations limited)`);
        } else {
          console.log(`✓ ${keyPrefix} is fully valid`);
        }
        
        validCount++;
        return true;
      } catch (error: any) {
        const reason = error?.errors?.[0]?.reason;
        if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
          console.log(`✗ ${keyPrefix} quota exceeded for search.list (may still work for other operations)`);
          this.markKeyAsQuotaExceeded(key, 'search.list');
          quotaExceededCount++;
          return false;
        } else {
          console.log(`✗ ${keyPrefix} is invalid: ${reason || 'Unknown error'}`);
          this.markKeyAsQuotaExceeded(key, 'search.list');
          invalidCount++;
          return false;
        }
      }
    });

    await Promise.all(validationPromises);
    console.log(`YouTube API key validation complete: ${validCount}/${this.keys.length} keys are valid for search operations`);
    
    if (quotaExceededCount > 0) {
      console.log(`- ${quotaExceededCount} keys exceeded quota for search.list but may still work for other operations`);
    }
    
    if (partiallyAvailableCount > 0) {
      console.log(`- ${partiallyAvailableCount} keys are partially available (some operations limited)`);
    }
    
    if (invalidCount > 0) {
      console.log(`- ${invalidCount} keys appear to be invalid`);
    }

    if (validCount === 0) {
      console.warn('WARNING: No YouTube API keys are available for search operations!');
    }
  }

  private initializeKeyUsage() {
    const now = Date.now();
    this.keys.forEach(key => {
      this.keyUsage.set(key, {
        minuteCount: 0,
        minuteResetTime: now + this.MINUTE_RESET,
        dailyCount: 0,
        dailyResetTime: now + this.DAILY_RESET,
        quotaExceeded: false,
        quotaExceededOperations: new Set<string>(),
        lastUsed: 0
      });
    });
  }

  private cleanupUsageData() {
    const now = Date.now();
    this.keyUsage.forEach((usage, key) => {
      if (now >= usage.minuteResetTime) {
        usage.minuteCount = 0;
        usage.minuteResetTime = now + this.MINUTE_RESET;
      }
      if (now >= usage.dailyResetTime) {
        usage.dailyCount = 0;
        usage.dailyResetTime = now + this.DAILY_RESET;
        usage.quotaExceeded = false;
        usage.quotaExceededOperations.clear();
      }
    });
  }

  private async findBestKey(operation: string): Promise<string | null> {
    const quotaCost = this.QUOTA_COSTS[operation as keyof typeof this.QUOTA_COSTS] || 1;
    const now = Date.now();
    
    // Try each key in sequence until we find a usable one
    for (let i = 0; i < this.keys.length; i++) {
      const currentIndex = (this.currentKeyIndex + i) % this.keys.length;
      const key = this.keys[currentIndex];
      const usage = this.keyUsage.get(key)!;

      // Skip if key is quota exceeded for this specific operation
      if (usage.quotaExceededOperations.has(operation) || usage.quotaExceeded) continue;

      // Reset counters if time has passed
      if (now >= usage.minuteResetTime) {
        usage.minuteCount = 0;
        usage.minuteResetTime = now + this.MINUTE_RESET;
      }
      if (now >= usage.dailyResetTime) {
        usage.dailyCount = 0;
        usage.dailyResetTime = now + this.DAILY_RESET;
        usage.quotaExceeded = false;
        usage.quotaExceededOperations.clear();
      }

      // Check if key is usable
      if (usage.minuteCount < this.RATE_LIMIT && 
          usage.dailyCount + quotaCost <= this.DAILY_QUOTA) {
        this.currentKeyIndex = currentIndex; // Update current key index
        return key;
      }
    }

    // If no key is immediately available, find the one that will reset soonest
    let earliestReset = Infinity;
    let bestKey: string | null = null;

    this.keys.forEach(key => {
      const usage = this.keyUsage.get(key)!;
      const resetTime = usage.quotaExceeded ? 
        usage.dailyResetTime : 
        usage.minuteResetTime;
      
      if (resetTime < earliestReset) {
        earliestReset = resetTime;
        bestKey = key;
      }
    });

    if (bestKey && earliestReset - now <= 5000) {
      // If reset is within 5 seconds, wait for it
      await new Promise(resolve => setTimeout(resolve, earliestReset - now + 100));
      return bestKey;
    }

    return null;
  }

  public async getCurrentKey(operation: string = 'search.list'): Promise<string> {
    const bestKey = await this.findBestKey(operation);
    if (bestKey) {
      const usage = this.keyUsage.get(bestKey)!;
      const quotaCost = this.QUOTA_COSTS[operation as keyof typeof this.QUOTA_COSTS] || 1;
      usage.lastUsed = Date.now();
      usage.minuteCount++;
      usage.dailyCount += quotaCost;
      return bestKey;
    }

    // If no key is available, try the next one in sequence
    this.currentKeyIndex = (this.currentKeyIndex + 1) % this.keys.length;
    return this.keys[this.currentKeyIndex];
  }

  public markKeyAsQuotaExceeded(key: string, operation: string = '') {
    const usage = this.keyUsage.get(key);
    if (usage) {
      if (operation) {
        usage.quotaExceededOperations.add(operation);
        const operationCount = usage.quotaExceededOperations.size;
        const totalOperations = Object.keys(this.QUOTA_COSTS).length;
        
        console.log(`YouTube API key *****${key.slice(-5)} quota exceeded specifically for '${operation}' operation`);
        console.log(`This key is now limited for ${operationCount}/${totalOperations} operations but may still work for others`);
      } else {
        usage.quotaExceeded = true;
        console.log(`YouTube API key *****${key.slice(-5)} completely quota exceeded for all operations`);
      }
      this.currentKeyIndex = (this.currentKeyIndex + 1) % this.keys.length;
    }
  }

  public getKeyCount(): number {
    return this.keys.length;
  }

  public getRateLimitInfo(): { available: number; total: number } {
    let available = 0;
    this.keys.forEach(key => {
      const usage = this.keyUsage.get(key);
      if (usage && !usage.quotaExceeded && usage.minuteCount < this.RATE_LIMIT) {
        available += this.RATE_LIMIT - usage.minuteCount;
      }
    });

    return {
      available,
      total: this.keys.length * this.RATE_LIMIT
    };
  }

  public async getAllKeys(): Promise<string[]> {
    return this.keys;
  }

  public async getNextKey(operation: string): Promise<string | null> {
    const bestKey = await this.findBestKey(operation);
    if (bestKey) {
      const usage = this.keyUsage.get(bestKey)!;
      const quotaCost = this.QUOTA_COSTS[operation as keyof typeof this.QUOTA_COSTS] || 1;
      usage.lastUsed = Date.now();
      usage.minuteCount++;
      usage.dailyCount += quotaCost;
      return bestKey;
    }

    // If we've tried all keys and none are available, return null
    console.log(`No available keys for operation ${operation} after trying all ${this.keys.length} keys`);
    return null;
  }
}

// Create key manager instance lazily
let keyManagerInstance: YouTubeKeyManager | null = null;

function getKeyManager(): YouTubeKeyManager {
  if (!keyManagerInstance) {
    keyManagerInstance = new YouTubeKeyManager();
  }
  return keyManagerInstance;
}

// Function to initialize the key manager at server startup
export async function initializeYouTubeAPI(): Promise<void> {
  console.log('Initializing YouTube API...');
  const manager = getKeyManager();
  try {
    // Force validation of all keys at startup
    await manager.validateKeys();
  } catch (error) {
    console.error('Error initializing YouTube API:', error);
  }
}

// Initialize YouTube API client
const youtubeClient = google.youtube('v3');

// Type definitions for YouTube API parameters
interface SearchParams {
  part: string[];
  q?: string;
  type?: string;
  maxResults?: number;
  pageToken?: string;
  regionCode?: string;
}

interface VideosParams {
  part: string[];
  id?: string[];
  maxResults?: number;
  pageToken?: string;
}

interface PlaylistItemsParams {
  part: string[];
  playlistId: string;
  maxResults?: number;
  pageToken?: string;
}

type Video = youtube_v3.Schema$Video;
interface SearchResult {
  youtubeId: string;
  title: string;
  thumbnail: string;
  duration: number;
}

// Export the key manager getter instead of the instance
export const youtube = {
  ...youtubeClient,
  keyManager: getKeyManager
};

const execAsync = promisify(exec);

interface TrackInfo {
  title: string;
  artist?: string;
  thumbnail: string;
  duration: number;
}

/**
 * Execute a YouTube API call with automatic retry on quota exceeded errors
 * @param operationType The operation type (e.g., 'search.list', 'videos.list')
 * @param apiCall Function that takes an API key and returns a Promise with the API call
 * @returns Result of the API call
 */
export async function executeYoutubeApi<T>(operationType: string, apiCall: (key: string) => Promise<T>): Promise<T> {
  try {
    // Use the key manager's executeWithRetry method
    return await getKeyManager().executeWithRetry(operationType, apiCall);
  } catch (error: any) {
    console.error(`YouTube API error for ${operationType}:`, error?.message || 'Unknown error');
    throw error;
  }
}

export async function searchYoutube(query: string): Promise<SearchResult[]> {
  try {
    // Construct search query
    let searchQuery = query;
    if (!/[一-龯ぁ-んァ-ン]/.test(query)) {
      // If query doesn't contain Japanese characters, add J-pop keywords
      searchQuery = `${query} jpop japanese song`;
    }

    // Use the executeYoutubeApi helper for automatic retry
    const response = await executeYoutubeApi('search.list', async (apiKey) => {
      return youtube.search.list({
        key: apiKey,
        part: ['id', 'snippet'],
        q: searchQuery,
        type: ['video'],
        maxResults: 10,
        videoCategoryId: '10', // Music category
        regionCode: 'JP', // Prioritize Japanese content
        relevanceLanguage: 'ja', // Prefer Japanese results
        fields: 'items(id/videoId,snippet/title,snippet/thumbnails)'
      });
    });

    if (!response.data.items || response.data.items.length === 0) {
      // Try again without region/language restrictions
      const fallbackResponse = await executeYoutubeApi('search.list', async (apiKey) => {
        return youtube.search.list({
          key: apiKey,
          part: ['id', 'snippet'],
          q: searchQuery,
          type: ['video'],
          maxResults: 10,
          videoCategoryId: '10',
          fields: 'items(id/videoId,snippet/title,snippet/thumbnails)'
        });
      });
      
      if (!fallbackResponse.data.items || fallbackResponse.data.items.length === 0) {
        return [];
      }
      
      response.data.items = fallbackResponse.data.items;
    }

    // Get video details for duration
    const videoIds = response.data.items
      .map(item => item.id?.videoId)
      .filter((id): id is string => !!id);

    const videoDetails = await executeYoutubeApi('videos.list', async (apiKey) => {
      return youtube.videos.list({
        key: apiKey,
        part: ['contentDetails'],
        id: videoIds
      });
    });

    const durationMap = new Map(
      videoDetails.data.items?.map(video => [
        video.id,
        parseDuration(video.contentDetails?.duration || 'PT0S')
      ]) || []
    );

    // Process results in parallel
    const results = await Promise.all(response.data.items.map(async (item) => {
      const videoId = item.id?.videoId;
      if (!videoId) return null;

      const title = (item.snippet?.title?.trim() || '').trim();
      const duration = durationMap.get(videoId) || 0;

      // Skip if duration is 0 or title is empty
      if (duration === 0 || !title) return null;

      // Try to download and cache the thumbnail
      try {
        const thumbnailUrl = await getBestThumbnail(videoId);
        await downloadAndCacheThumbnail(videoId, thumbnailUrl);
      } catch (error) {
        console.error(`Failed to download thumbnail for ${videoId}:`, error);
      }

      // Create track entry
      await prisma.track.upsert({
        where: { youtubeId: videoId },
        update: {
          title,
          duration,
          thumbnail: `${API_BASE_URL}/api/albumart/${videoId}`,
          updatedAt: new Date()
        },
        create: {
          youtubeId: videoId,
          title,
          duration,
          thumbnail: `${API_BASE_URL}/api/albumart/${videoId}`
        }
      });

      return {
        youtubeId: videoId,
        title,
        thumbnail: `${API_BASE_URL}/api/albumart/${videoId}`,
        duration
      };
    }));

    const validResults = results.filter((result): result is NonNullable<typeof result> => result !== null);

    if (validResults.length === 0) {
      // Try local cache as fallback
      try {
        const cacheDir = process.env.CACHE_DIR || path.join(process.cwd(), 'cache');
        const audioDir = path.join(cacheDir, 'audio');
        const cachedFiles = await fs.promises.readdir(audioDir);
        const youtubeIds = cachedFiles.map(file => file.replace('.m4a', ''));
        
        if (youtubeIds.length > 0) {
          const localResults = await prisma.track.findMany({
            where: {
              youtubeId: { in: youtubeIds },
              title: { contains: query, mode: 'insensitive' }
            },
            take: 5,
            orderBy: { updatedAt: 'desc' }
          });

          if (localResults.length > 0) {
            return localResults.map(track => ({
              youtubeId: track.youtubeId,
              title: track.title,
              thumbnail: `${API_BASE_URL}/api/albumart/${track.youtubeId}`,
              duration: track.duration
            }));
          }
        }
      } catch (cacheError) {
        console.error('Local cache fallback failed:', cacheError);
      }
    }

    return validResults;
  } catch (error) {
    const status = (error as any)?.code || (error as any)?.status;
    const reason = (error as any)?.errors?.[0]?.reason;
    console.error(`YouTube search failed: ${status}${reason ? ` (${reason})` : ''}`);
    return [];
  }
}

export async function getYoutubeId(query: string): Promise<{ videoId: string | undefined; isMusicUrl: boolean }> {
  try {
    // Check if it's a direct YouTube URL
    if (query.includes('youtube.com/') || query.includes('youtu.be/') || query.includes('music.youtube.com/')) {
      let videoId: string | null = null;
      let isMusicUrl = false;
      
      // Handle youtu.be format
      if (query.includes('youtu.be/')) {
        videoId = query.split('youtu.be/')[1]?.split(/[?&]/)[0];
      } else {
        try {
          const url = new URL(query);
          isMusicUrl = url.hostname === 'music.youtube.com';
          
          if (url.pathname.includes('/watch')) {
            videoId = url.searchParams.get('v');
          } else if (url.pathname.includes('/embed/')) {
            videoId = url.pathname.split('/embed/')[1]?.split(/[?&]/)[0];
          } else if (url.pathname.match(/^\/[a-zA-Z0-9_-]{11}$/)) {
            videoId = url.pathname.substring(1);
          }
        } catch (error) {
          console.error('Failed to parse YouTube URL');
          return { videoId: undefined, isMusicUrl: false };
        }
      }

      if (!videoId || !videoId.match(/^[a-zA-Z0-9_-]{11}$/)) {
        console.error('Invalid YouTube video ID format');
        return { videoId: undefined, isMusicUrl: false };
      }

      return { videoId, isMusicUrl };
    }

    // If not a URL, search YouTube
    let retries = 3;
    while (retries > 0) {
      try {
        const apiKey = await getKeyManager().getCurrentKey();
        const response = await youtube.search.list({
          key: apiKey,
          part: ['id'],
          q: query,
          type: ['video'],
          maxResults: 1
        });

        const videoId = response.data.items?.[0]?.id?.videoId;
        return { videoId: videoId || undefined, isMusicUrl: false };
      } catch (error: any) {
        if (error?.response?.status === 403) {
          const key = error.config?.params?.key;
          const reason = error?.errors?.[0]?.reason;
          
          if (reason === 'quotaExceeded' && key) {
            console.log(`YouTube API quota exceeded for key *****${key.slice(-5)}`);
            getKeyManager().markKeyAsQuotaExceeded(key, 'search.list');
            retries--;
            if (retries > 0) continue;
          }
        }
        console.error('YouTube search failed:', error?.errors?.[0]?.reason || 'Unknown error');
        break;
      }
    }
    return { videoId: undefined, isMusicUrl: false };
  } catch (error) {
    console.error('Failed to get YouTube ID');
    return { videoId: undefined, isMusicUrl: false };
  }
}

// Export the function for use in other modules
export async function processImage(inputBuffer: Buffer): Promise<Buffer> {
  try {
    let image = sharp(inputBuffer);
    const { width, height } = await image.metadata();
    if (!width || !height) {
      throw new Error('Could not get image dimensions');
    }

    try {
      const trimmedImage = await image
        .trim({ 
          threshold: 50,
          background: { r: 50, g: 50, b: 50 }
        })
        .toBuffer();

      image = sharp(trimmedImage);
      const trimmedMetadata = await image.metadata();
      if (!trimmedMetadata.width || !trimmedMetadata.height) {
        throw new Error('Could not get dimensions after trim');
      }

      const size = Math.min(trimmedMetadata.width, trimmedMetadata.height);
      const left = Math.floor((trimmedMetadata.width - size) / 2);
      const top = Math.floor((trimmedMetadata.height - size) / 2);

      return await image
        .extract({
          left,
          top,
          width: size,
          height: size
        })
        .jpeg({
          quality: 95,
          progressive: true
        })
        .toBuffer();
    } catch (trimError) {
      throw trimError;
    }
  } catch (error) {
    try {
      return await sharp(inputBuffer)
        .resize(720, 720, {
          fit: 'cover',
          position: 'center'
        })
        .jpeg({
          quality: 95,
          progressive: true
        })
        .toBuffer();
    } catch (fallbackError) {
      throw error;
    }
  }
}

const API_BASE_URL = process.env.API_URL || 'http://localhost:3000';

const THUMBNAIL_QUALITIES = [
  'maxresdefault.jpg',  // 1920x1080
  'sddefault.jpg',      // 640x480
  'hqdefault.jpg',      // 480x360
  'mqdefault.jpg',      // 320x180
  'default.jpg'         // 120x90
];

async function getBestThumbnail(youtubeId: string): Promise<string> {
  for (const quality of THUMBNAIL_QUALITIES) {
    const url = `https://i.ytimg.com/vi/${youtubeId}/${quality}`;
    try {
      const response = await fetch(url, { method: 'HEAD' });
      if (response.ok) {
        return url;
      }
    } catch (error) {
      console.error(`Error checking thumbnail quality ${quality}:`, error);
      continue;
    }
  }
  // Fallback to hqdefault if all checks fail
  return `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`;
}

export async function getYoutubeInfo(videoId: string, isMusicUrl: boolean = false): Promise<TrackInfo> {
  try {
    // First check if we have the track
    const track = await prisma.track.findUnique({
      where: { youtubeId: videoId }
    });

    // If we have the track and it has valid duration, check if thumbnail exists
    if (track && track.duration > 0) {
      // Update isMusicUrl if needed
      if (isMusicUrl && !track.isMusicUrl) {
        await prisma.track.update({
          where: { youtubeId: videoId },
          data: { isMusicUrl: true }
        });
      }
      
      // Verify thumbnail exists
      const thumbnailCache = await prisma.thumbnailCache.findUnique({
        where: { youtubeId: videoId }
      });

      let thumbnailExists = false;
      if (thumbnailCache) {
        try {
          await fs.promises.access(thumbnailCache.filePath);
          thumbnailExists = true;
        } catch (error) {
          await prisma.thumbnailCache.delete({
            where: { youtubeId: videoId }
          });
        }
      }

      // Download thumbnail if missing
      if (!thumbnailExists) {
        try {
          const thumbnailUrl = await getBestThumbnail(videoId);
          await downloadAndCacheThumbnail(videoId, thumbnailUrl);
        } catch (error) {
          console.error(`Failed to download thumbnail for ${videoId}`);
        }
      }

      return {
        title: track.title,
        thumbnail: getThumbnailUrl(videoId),
        duration: track.duration
      };
    }

    // If we get here, we need to fetch from YouTube API
    let retries = 3;
    while (retries > 0) {
      try {
        const apiKey = await getKeyManager().getCurrentKey('videos.list');
        const response = await youtube.videos.list({
          key: apiKey,
          part: ['snippet', 'contentDetails'],
          id: [videoId]
        });

        const video = response.data.items?.[0];
        if (!video) {
          throw new Error('Video not found');
        }

        // Parse duration from ISO 8601 format
        const duration = parseDuration(video.contentDetails?.duration || 'PT0S');
        const title = video.snippet?.title || 'Unknown Title';
        const thumbnail = video.snippet?.thumbnails?.maxres?.url ||
                        video.snippet?.thumbnails?.high?.url ||
                        video.snippet?.thumbnails?.medium?.url ||
                        video.snippet?.thumbnails?.default?.url ||
                        '';

        // Download and cache the thumbnail
        try {
          await downloadAndCacheThumbnail(videoId, thumbnail);
        } catch (error) {
          console.error(`Failed to download thumbnail for ${videoId}:`, error);
        }

        // Cache the track info - remove thumbnail field
        await prisma.track.upsert({
          where: { youtubeId: videoId },
          update: {
            title,
            duration,
            isMusicUrl
          },
          create: {
            youtubeId: videoId,
            title,
            duration,
            isMusicUrl
          }
        });

        return { title, thumbnail, duration };
      } catch (error: any) {
        if (error?.response?.status === 403) {
          const key = error.config?.params?.key;
          const reason = error?.errors?.[0]?.reason;
          
          if (reason === 'quotaExceeded' && key) {
            console.log(`YouTube API quota exceeded for key *****${key.slice(-5)}`);
            getKeyManager().markKeyAsQuotaExceeded(key, 'videos.list');
            retries--;
            if (retries > 0) continue;
          }
        }
        console.error(`YouTube info fetch failed for ${videoId}:`, error?.errors?.[0]?.reason || 'Unknown error');
        break;
      }
    }
    throw new Error('Failed to fetch video info after retries');
  } catch (error) {
    console.error(`Failed to get YouTube info for ${videoId}`);
    throw error;
  }
}

// Add download lock tracking
const activeDownloads = new Map<string, Promise<string>>();

export async function downloadYoutubeAudio(youtubeId: string): Promise<string> {
  if (!youtubeId) {
    throw new Error('YouTube ID is required');
  }

  // Check if download is already in progress
  const existingDownload = activeDownloads.get(youtubeId);
  if (existingDownload) {
    console.log(`⏳ [${youtubeId}] Download already in progress, waiting...`);
    return existingDownload;
  }

  const cacheDir = process.env.CACHE_DIR || path.join(process.cwd(), 'cache');
  const audioDir = path.join(cacheDir, 'audio');

  // Ensure directories exist
  await fs.promises.mkdir(audioDir, { recursive: true });

  const finalPath = path.join(audioDir, `${youtubeId}.m4a`);
  const tempPath = path.join(audioDir, `${youtubeId}.temp.m4a`);
  const uniqueTempPath = path.join(audioDir, `${youtubeId}.${Date.now()}.temp.m4a`);

  // Create download promise
  const downloadPromise = (async () => {
    try {
      // If file already exists and is not empty, return it
      try {
        const stats = await fs.promises.stat(finalPath);
        if (stats.size > 0) {
          return finalPath;
        }
      } catch (error) {
        // File doesn't exist, continue with download
      }

      // Clean up any existing temp files
      try {
        await fs.promises.unlink(tempPath);
      } catch (error) {
        // Ignore errors if file doesn't exist
      }
      try {
        await fs.promises.unlink(`${tempPath}.part`);
      } catch (error) {
        // Ignore errors if file doesn't exist
      }

      // Add retry logic for download
      let retries = 3;
      let lastError: Error | null = null;
      let backoffDelay = 1000;

      while (retries > 0) {
        try {
          // Construct YouTube URL
          const youtubeUrl = `https://www.youtube.com/watch?v=${youtubeId}`;
          console.log(`⬇️ [${youtubeId}] Starting download`);

          // Download with yt-dlp using unique temp path
          await ytDlp(youtubeUrl, {
            output: uniqueTempPath,
            extractAudio: true,
            audioFormat: 'm4a',
            format: 'bestaudio[ext=m4a]',
            noCheckCertificate: true,
            noWarnings: true,
            quiet: true,
            preferFreeFormats: true,
            ffmpegLocation: ffmpeg || undefined
          });

          // Verify the downloaded file exists and is not empty
          const stats = await fs.promises.stat(uniqueTempPath);
          if (stats.size === 0) {
            throw new Error('Downloaded file is empty');
          }

          // Move temp file to final location
          await fs.promises.rename(uniqueTempPath, finalPath);
          console.log(`✅ [${youtubeId}] Download complete`);
          return finalPath;
        } catch (error: any) {
          lastError = error;
          const errorMessage = error?.stderr || error?.message || 'Unknown error';
          
          // Extract just the yt-dlp error message if present
          const ytdlpError = errorMessage.match(/ERROR: \[youtube\].*?: (.*?)(\n|$)/)?.[1];
          
          // Check if video is unavailable - no need to retry in this case
          if (errorMessage.includes('Video unavailable') || 
              errorMessage.includes('This video is not available') ||
              errorMessage.includes('This video has been removed')) {
            console.log(`❌ [${youtubeId}] Video unavailable`);
            throw new Error(`Video unavailable: ${youtubeId}`);
          }
          
          console.log(`⚠️ [${youtubeId}] Attempt ${4 - retries}/3 failed: ${ytdlpError || errorMessage}`);
          retries--;

          // Clean up failed attempt
          try {
            await fs.promises.unlink(uniqueTempPath);
          } catch (e) {
            // Ignore cleanup errors
          }

          if (retries > 0) {
            // Exponential backoff
            await new Promise(resolve => setTimeout(resolve, backoffDelay));
            backoffDelay *= 2; // Double the delay for next retry
          }
        }
      }

      console.log(`❌ [${youtubeId}] Download failed after 3 attempts`);
      throw lastError || new Error('Download failed after retries');
    } finally {
      // Always clean up temp files and remove from active downloads
      try {
        await fs.promises.unlink(uniqueTempPath);
      } catch (error) {
        // Ignore cleanup errors
      }
      activeDownloads.delete(youtubeId);
    }
  })();

  // Store the promise in active downloads
  activeDownloads.set(youtubeId, downloadPromise);

  return downloadPromise;
}

async function convertToAAC(inputPath: string, outputPath: string): Promise<void> {
  return new Promise(async (resolve, reject) => {
    try {
      // First pass: run volumedetect filter to measure max_volume
      let stderrData = '';
      const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';

      // Volume detection pass
      try {
        await new Promise<void>((res, rej) => {
          const process = spawn(ffmpeg!, [
            '-hide_banner',
            '-loglevel', 'error',
            '-i', inputPath,
            '-af', 'volumedetect',
            '-f', 'null',
            nullDevice
          ]);

          process.stderr.on('data', (data: Buffer) => {
            stderrData += data.toString();
          });

          process.on('error', (error) => {
            console.error('FFmpeg volume detection error:', error);
            rej(error);
          });

          process.on('close', (code: number) => {
            if (code === 0) res();
            else rej(new Error(`FFmpeg volume detection exited with code ${code}`));
          });
        });
      } catch (error) {
        console.warn('Volume detection failed, proceeding with default volume:', error);
        stderrData = 'max_volume: 0 dB'; // Default to no adjustment if detection fails
      }

      // Parse volume data
      const match = stderrData.match(/max_volume:\s*(-?\d+(\.\d+)?) dB/);
      const maxVolume = match ? parseFloat(match[1]) : 0;
      const gain = -1 - maxVolume; // Target -1dB

      // Conversion pass
      await new Promise<void>((res, rej) => {
        const process = spawn(ffmpeg!, [
          '-hide_banner',
          '-loglevel', 'error',
          '-i', inputPath,
          '-c:a', 'aac',
          '-b:a', '256k',
          '-ar', '48000',
          '-ac', '2',
          '-af', `volume=${gain}dB`,
          '-movflags', '+faststart',
          '-y',
          outputPath
        ]);

        let conversionError = '';

        process.stderr.on('data', (data: Buffer) => {
          conversionError += data.toString();
        });

        process.on('error', (error) => {
          console.error('FFmpeg conversion error:', error);
          rej(error);
        });

        process.on('close', (code: number) => {
          if (code === 0) res();
          else {
            if (conversionError) {
              console.error('FFmpeg error output:', conversionError);
            }
            rej(new Error(`FFmpeg conversion exited with code ${code}`));
          }
        });
      });

      resolve();
    } catch (error) {
      console.error('Audio conversion failed:', error);
      reject(error);
    }
  });
}

export function parseDuration(duration: string): number {
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;

  const [, hours, minutes, seconds] = match;
  return (
    (parseInt(hours || '0') * 3600) +
    (parseInt(minutes || '0') * 60) +
    parseInt(seconds || '0')
  );
}

function parseTitle(title: string): { title: string; artist?: string } {
  // Just return the full title without parsing
  return { title: cleanTitle(title.trim()) };
}

function cleanTitle(title: string): string {
  // Remove common Japanese video tags
  const tagsToRemove = [
    /【[^】]*】/g,     // Remove 【tag】
    /\[[^\]]*\]/g,    // Remove [tag]
    /「[^」]*」/g,     // Remove 「tag」
    /\([^)]*\)/g,     // Remove (tag)
    /［[^］]*］/g,     // Remove ［tag］
    /〔[^〕]*〕/g,     // Remove 〔tag〕
    /『[^』]*』/g,     // Remove 『tag』
    /\s*[/／]\s*/g,   // Replace slashes with ' - '
  ];

  let cleanedTitle = title;
  
  // Apply each removal pattern
  tagsToRemove.forEach(pattern => {
    cleanedTitle = cleanedTitle.replace(pattern, ' ');
  });

  // Replace multiple spaces with single space
  cleanedTitle = cleanedTitle.replace(/\s+/g, ' ');

  // Replace slashes with ' - '
  cleanedTitle = cleanedTitle.replace(/\s*[/／]\s*/g, ' - ');

  // Trim and return
  return cleanedTitle.trim();
}

export async function getPlaylistItems(url: string): Promise<string[]> {
  try {
    // Extract playlist ID from URL
    const playlistId = url.match(/[?&]list=([^&]+)/)?.[1];
    if (!playlistId) {
      console.error('Invalid playlist URL:', url);
      return [];
    }

    console.log('Fetching playlist items for:', playlistId);
    const videoIds: string[] = [];
    let nextPageToken: string | undefined;

    do {
      const apiKey = await getKeyManager().getCurrentKey('playlistItems.list');
      const response = await youtube.playlistItems.list({
        key: apiKey,
        part: ['contentDetails'],
        playlistId: playlistId,
        maxResults: 50,
        pageToken: nextPageToken
      });

      if (!response.data.items) {
        break;
      }

      // Extract video IDs
      const items = response.data.items;
      for (const item of items) {
        const videoId = item.contentDetails?.videoId;
        if (videoId) {
          videoIds.push(videoId);
        }
      }

      // Handle nextPageToken type safely
      nextPageToken = response.data.nextPageToken || undefined;
    } while (nextPageToken);

    console.log(`Found ${videoIds.length} videos in playlist`);
    return videoIds;
  } catch (error) {
    const status = (error as any)?.code || (error as any)?.status;
    const reason = (error as any)?.errors?.[0]?.reason;
    console.error(`Failed to fetch playlist: ${status}${reason ? ` (${reason})` : ''}`);
    return [];
  }
}

export async function getAudioFileDuration(filePath: string): Promise<number> {
    return new Promise((resolve, reject) => {
        const ffprobeProcess = spawn(ffprobe.path, [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            filePath
        ]);

        let output = '';
        ffprobeProcess.stdout.on('data', (data) => {
            output += data.toString();
        });

        ffprobeProcess.stderr.on('data', (data) => {
            console.error('ffprobe error:', data.toString());
        });

        ffprobeProcess.on('error', (err) => {
            console.error('Failed to spawn ffprobe:', err);
            console.error('FFprobe path:', ffprobe.path);
            console.error('File path:', filePath);
            reject(err);
        });

        ffprobeProcess.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`ffprobe process exited with code ${code}`));
                return;
            }
            const duration = parseFloat(output.trim());
            resolve(duration);
        });
    });
}

/**
 * Get YouTube recommendations for a seed track
 * @param seedTrackId The YouTube ID of the seed track
 * @returns Array of recommended track IDs
 */
export async function getYoutubeRecommendations(seedTrackId: string): Promise<Array<{ youtubeId: string }>> {
  try {
    // First verify if the seed track exists and is available
    let seedTrackDetails: youtube_v3.Schema$Video | null = null;
    try {
      const apiKey = await getKeyManager().getCurrentKey('videos.list');
      const checkResponse = await youtube.videos.list({
        key: apiKey,
        part: ['id', 'snippet', 'topicDetails'],
        id: [seedTrackId]
      });

      if (!checkResponse.data?.items?.length) {
        console.error(`Seed track ${seedTrackId} is unavailable`);
        return [];
      }
      
      seedTrackDetails = checkResponse.data.items[0];
    } catch (error: any) {
      console.error(`Failed to verify seed track ${seedTrackId}:`, error?.errors?.[0]?.reason || 'Unknown error');
      return [];
    }

    // Extract useful information from the seed track for better search
    const videoTitle = seedTrackDetails!.snippet?.title || '';
    const channelId = seedTrackDetails!.snippet?.channelId || '';
    const channelTitle = seedTrackDetails!.snippet?.channelTitle || '';
    const tags = seedTrackDetails!.snippet?.tags || [];
    const topicCategories = seedTrackDetails!.topicDetails?.topicCategories || [];
    
    // Check if the seed track is likely Japanese before proceeding
    const isJapaneseSeed = isLikelyJapaneseSong(videoTitle, channelTitle, tags);
    
    if (!isJapaneseSeed) {
      console.log(`Seed track ${seedTrackId} "${videoTitle}" is not likely Japanese. Skipping recommendations.`);
      return [];
    }
    
    console.log(`Finding recommendations for Japanese song: ${videoTitle} by ${channelTitle}`);
    console.log(`Tags: ${tags.join(', ')}`);
    console.log(`Topics: ${topicCategories.join(', ')}`);

    // Check if we already have recommendations for this seed track in the database
    const existingRecs: Array<{ youtubeId: string }> = await prisma.$queryRaw`
      SELECT "youtubeId" FROM "YoutubeRecommendation"
      WHERE "seedTrackId" = ${seedTrackId}
    `;

    // If we have enough recommendations in the database, use those
    if (existingRecs.length >= 5) {
      console.log(`Using ${existingRecs.length} existing recommendations for ${seedTrackId} from database`);
      return existingRecs;
    }
    
    // Recommendations strategies in order of preference:
    // 1. Same artist's other videos (from Topic channel or official channel)
    // 2. Related artists from tags (searching for their Topic channels)
    // 3. General search with genre tags + "official" or "Topic" filter
    
    let recommendations: Array<{ youtubeId: string }> = [];
    const keyManager = getKeyManager();
    
    // Strategy 1: Get videos from the same artist
    if (channelId && recommendations.length < 5) {
      const sameArtistRecs = await getRecommendationsFromSameArtist(
        seedTrackId,
        channelId,
        channelTitle
      );
      
      if (sameArtistRecs.length > 0) {
        recommendations = recommendations.concat(sameArtistRecs);
        console.log(`Found ${sameArtistRecs.length} recommendations from same artist: ${channelTitle}`);
      }
    }
    
    // Strategy 2: Get videos from related artists found in tags
    if (tags.length > 0 && recommendations.length < 5) {
      // Extract artist names from tags (usually these are Japanese names)
      const artistTags = tags.filter(tag => 
        // Filter for likely artist names (usually not English genre names)
        !/^[a-zA-Z\s\-]+$/.test(tag) && 
        // Exclude common genre keywords
        !['jpop', 'j-pop', 'jrock', 'j-rock', 'vocaloid', 'anime'].includes(tag.toLowerCase())
      );
      
      if (artistTags.length > 0) {
        console.log(`Searching for related artists from tags: ${artistTags.join(', ')}`);
        
        for (const artistTag of artistTags) {
          if (recommendations.length >= 5) break;
          
          const relatedArtistRecs = await getRecommendationsFromRelatedArtist(
            seedTrackId,
            artistTag,
            keyManager
          );
          
          if (relatedArtistRecs.length > 0) {
            recommendations = recommendations.concat(relatedArtistRecs.slice(0, 5 - recommendations.length));
            console.log(`Found ${relatedArtistRecs.length} recommendations from related artist: ${artistTag}`);
          }
        }
      }
    }
    
    // Strategy 3: Get videos using genre tags with official/Topic filter
    if (recommendations.length < 5) {
      // Extract genre tags - these are usually English words like "J-Rock", "Pop", etc.
      const genreTags = tags.filter(tag => 
        /^[a-zA-Z\s\-]+$/.test(tag) || 
        ['jpop', 'j-pop', 'jrock', 'j-rock', 'vocaloid', 'anime'].includes(tag.toLowerCase())
      );
      
      if (genreTags.length > 0) {
        console.log(`Searching for similar genre with tags: ${genreTags.join(', ')}`);
        
        const genreBasedRecs = await getRecommendationsFromGenre(
          seedTrackId,
          genreTags,
          keyManager
        );
        
        if (genreBasedRecs.length > 0) {
          recommendations = recommendations.concat(genreBasedRecs.slice(0, 5 - recommendations.length));
          console.log(`Found ${genreBasedRecs.length} recommendations from genre search`);
        }
      }
    }
    
    // Store recommendations in the database
    if (recommendations.length > 0) {
      try {
        // Filter recommendations by duration before storing
        const validatedRecommendations = await validateRecommendationDurations(recommendations);
        
        if (validatedRecommendations.length === 0) {
          console.log(`No recommendations with valid durations found for ${seedTrackId}`);
          return existingRecs;
        }
        
        const recommendationsToStore = validatedRecommendations.map(rec => ({
          youtubeId: rec.youtubeId,
          seedTrackId: seedTrackId,
          relevanceScore: 0.9, // High relevance for official content
          isJapanese: true, // We've already verified the seed is Japanese
          wasPlayed: false,
          createdAt: new Date(),
          updatedAt: new Date()
        }));
        
        await prisma.$executeRaw`
          INSERT INTO "YoutubeRecommendation" ("youtubeId", "seedTrackId", "relevanceScore", "isJapanese", "wasPlayed", "createdAt", "updatedAt")
          VALUES ${Prisma.join(
            recommendationsToStore.map(rec => 
              Prisma.sql`(${rec.youtubeId}, ${rec.seedTrackId}, ${rec.relevanceScore || 0}, ${rec.isJapanese || false}, false, now(), now())`
            )
          )}
          ON CONFLICT ("youtubeId") DO NOTHING
        `;
        
        console.log(`Stored ${recommendationsToStore.length} new recommendations with valid durations for ${seedTrackId}`);
        
        return validatedRecommendations;
      } catch (storeError) {
        console.error('Error storing recommendations:', storeError);
      }
    }
    
    return recommendations.length > 0 ? recommendations : existingRecs;
    
  } catch (error) {
    console.error('Error in getYoutubeRecommendations:', error);
    return [];
  }
}

/**
 * Validate YouTube recommendations by checking their durations
 * @param recommendations Array of recommendation objects with youtubeIds
 * @returns Array of recommendations that have valid durations
 */
async function validateRecommendationDurations(
  recommendations: Array<{ youtubeId: string }>
): Promise<Array<{ youtubeId: string }>> {
  const validatedRecommendations: Array<{ youtubeId: string }> = [];
  
  // Get all the YouTube IDs
  const youtubeIds = recommendations.map(rec => rec.youtubeId);
  if (youtubeIds.length === 0) return [];
  
  try {
    // Check for durations of these videos in our database first
    const existingTracks = await prisma.track.findMany({
      where: {
        youtubeId: { in: youtubeIds }
      },
      select: {
        youtubeId: true,
        duration: true
      }
    });
    
    // Create a map of existing tracks for quick lookup
    const existingTracksMap = new Map(
      existingTracks.map(track => [track.youtubeId, track.duration])
    );
    
    // Filter out the IDs we already have duration information for
    const validExistingIds = existingTracks
      .filter(track => isValidDuration(track.duration))
      .map(track => track.youtubeId);
    
    // Add valid existing tracks to our result
    validExistingIds.forEach(id => {
      validatedRecommendations.push({ youtubeId: id });
    });
    
    // Find IDs we need to fetch from YouTube API
    const idsToFetch = youtubeIds.filter(id => !existingTracksMap.has(id));
    
    if (idsToFetch.length > 0) {
      const keyManager = getKeyManager();
      const apiKey = await keyManager.getCurrentKey('videos.list');
      
      // Fetch videos in chunks to avoid exceeding API limits
      const chunkSize = 50; // YouTube API allows up to 50 IDs per request
      for (let i = 0; i < idsToFetch.length; i += chunkSize) {
        const chunk = idsToFetch.slice(i, i + chunkSize);
        
        try {
          const response = await youtube.videos.list({
            key: apiKey,
            part: ['contentDetails', 'snippet'],
            id: chunk
          });
          
          if (response.data.items && response.data.items.length > 0) {
            // Process each video's duration
            for (const video of response.data.items) {
              const videoId = video.id as string;
              const duration = parseDuration(video.contentDetails?.duration || 'PT0S');
              const title = video.snippet?.title || 'Unknown';
              
              // Store in database for future reference
              await prisma.track.upsert({
                where: { youtubeId: videoId },
                update: {
                  title,
                  duration
                },
                create: {
                  youtubeId: videoId,
                  title,
                  duration,
                  isMusicUrl: false
                }
              });
              
              if (isValidDuration(duration)) {
                console.log(`Video ${videoId} (${title}) has valid duration: ${duration} seconds`);
                validatedRecommendations.push({ youtubeId: videoId });
              } else {
                console.log(`Video ${videoId} (${title}) has invalid duration: ${duration} seconds (min: ${MIN_DURATION}, max: ${MAX_DURATION})`);
              }
            }
          }
        } catch (error: any) {
          console.error(`Error fetching video details: ${error?.message || error}`);
          
          if (error?.errors?.[0]?.reason === 'quotaExceeded') {
            keyManager.markKeyAsQuotaExceeded(apiKey, 'videos.list');
            // Try with a different key in the next chunk
          }
        }
      }
    }
    
    return validatedRecommendations;
    
  } catch (error) {
    console.error('Error validating recommendation durations:', error);
    return [];
  }
}

/**
 * Check if a duration is valid according to MIN_DURATION and MAX_DURATION
 */
function isValidDuration(duration: number): boolean {
  if (!duration) return false;
  return duration >= MIN_DURATION && duration <= MAX_DURATION;
}

/**
 * Get recommendations from the same artist's channel
 */
async function getRecommendationsFromSameArtist(
  seedTrackId: string,
  channelId: string,
  channelTitle: string
): Promise<Array<{ youtubeId: string }>> {
  try {
    console.log(`Getting recommendations from channel ${channelTitle} (${channelId})`);
    
    // Search for videos from the same channel using the executeYoutubeApi helper
    const searchResponse = await executeYoutubeApi('search.list', async (apiKey) => {
      return youtube.search.list({
        key: apiKey,
        part: ['id', 'snippet'],
        channelId: channelId,
        type: ['video'],
        videoCategoryId: '10', // Music category
        maxResults: 20
      });
    });
    
    if (!searchResponse?.data?.items || searchResponse.data.items.length === 0) {
      console.log(`No videos found from channel ${channelTitle}`);
      return [];
    }
    
    console.log(`Found ${searchResponse.data.items.length} videos from channel ${channelTitle}`);
    
    // Filter out the current video
    const filteredItems = searchResponse.data.items.filter(item => 
      item.id?.videoId !== seedTrackId
    );
    
    // Filter out videos with blocked keywords
    const contentFiltered = filterBlockedContent(filteredItems);
    
    if (contentFiltered.length === 0) {
      console.log(`No valid results found from channel ${channelTitle} after filtering`);
      return [];
    }
    
    // Map to the required format and return
    return contentFiltered.map(item => ({ 
      youtubeId: item.id?.videoId || '' 
    })).filter(rec => rec.youtubeId !== '');
    
  } catch (error: any) {
    console.error(`Error getting recommendations from channel ${channelTitle}:`, error?.message || 'Unknown error');
    return [];
  }
}

/**
 * Get recommendations from a related artist found in tags
 */
async function getRecommendationsFromRelatedArtist(
  seedTrackId: string,
  artistName: string,
  keyManager: YouTubeKeyManager
): Promise<Array<{ youtubeId: string }>> {
  try {
    // Try all available API keys for search until we find one that works
    const allApiKeys = await keyManager.getAllKeys();
    
    let attemptsCount = 0;
    const maxAttempts = allApiKeys.length;
    
    while (attemptsCount < maxAttempts) {
      let currentApiKey: string | null = null;
      
      try {
        // Get next API key for search
        currentApiKey = await keyManager.getNextKey('search.list');
        if (!currentApiKey) {
          console.error('No available API keys for YouTube search');
          break;
        }
        
        console.log(`Searching for artist "${artistName}" with API key ${currentApiKey.slice(-5)} (attempt ${attemptsCount + 1}/${maxAttempts})`);
        
        // First try to find the artist's Topic channel
        const artistSearchTerm = `${artistName} "Topic"`;
        const artistSearchResponse = await youtube.search.list({
          key: currentApiKey,
          part: ['id', 'snippet'],
          q: artistSearchTerm,
          type: ['channel'],
          maxResults: 3
        });
        
        // Look for Topic channels first
        const topicChannels = artistSearchResponse.data.items?.filter(item => 
          item.snippet?.channelTitle?.includes('Topic') || 
          item.snippet?.title?.includes('Topic')
        ) || [];
        
        // If no Topic channel found, look for official channels
        const officialChannels = topicChannels.length > 0 ? [] : (
          artistSearchResponse.data.items?.filter(item =>
            item.snippet?.channelTitle?.includes('Official') ||
            item.snippet?.channelTitle?.includes('official') ||
            item.snippet?.title?.includes('Official') ||
            item.snippet?.title?.includes('official')
          ) || []
        );
        
        const artistChannels = topicChannels.length > 0 ? topicChannels : officialChannels;
        
        if (artistChannels.length > 0) {
          const artistChannelId = artistChannels[0].id?.channelId;
          const artistChannelTitle = artistChannels[0].snippet?.title || '';
          
          console.log(`Found artist channel: ${artistChannelTitle} (${artistChannelId})`);
          
          // Now search for videos from this artist's channel
          const videosResponse = await youtube.search.list({
            key: currentApiKey,
            part: ['id', 'snippet'],
            channelId: artistChannelId,
            type: ['video'],
            videoCategoryId: '10', // Music category
            maxResults: 10
          });
          
          if (videosResponse.data.items && videosResponse.data.items.length > 0) {
            console.log(`Found ${videosResponse.data.items.length} videos from artist ${artistName}`);
            
            // Filter out videos with blocked keywords
            const contentFiltered = filterBlockedContent(videosResponse.data.items);
            
            if (contentFiltered.length > 0) {
              // Map to the required format and return
              return contentFiltered.map(item => ({ 
                youtubeId: item.id?.videoId || '' 
              })).filter(rec => rec.youtubeId !== '');
            }
          }
        } else {
          // If we couldn't find a proper channel, try direct search for the artist's videos
          console.log(`No artist channel found for ${artistName}, trying direct video search`);
          
          const videoSearchTerm = `${artistName} "official" OR "Topic" OR "MV"`;
          const directSearchResponse = await youtube.search.list({
            key: currentApiKey,
            part: ['id', 'snippet'],
            q: videoSearchTerm,
            type: ['video'],
            videoCategoryId: '10', // Music category
            regionCode: 'JP',
            relevanceLanguage: 'ja',
            maxResults: 10
          });
          
          if (directSearchResponse.data.items && directSearchResponse.data.items.length > 0) {
            console.log(`Found ${directSearchResponse.data.items.length} videos directly for artist ${artistName}`);
            
            // Filter out videos with blocked keywords
            const contentFiltered = filterBlockedContent(directSearchResponse.data.items);
            
            if (contentFiltered.length > 0) {
              // Map to the required format and return
              return contentFiltered.map(item => ({ 
                youtubeId: item.id?.videoId || '' 
              })).filter(rec => rec.youtubeId !== '');
            }
          }
        }
        
        // If we couldn't get results, try next key
        console.log(`No valid results found for artist ${artistName}, trying next key`);
        attemptsCount++;
        
      } catch (error: any) {
        const reason = error?.errors?.[0]?.reason;
        if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
          console.log(`API key ${currentApiKey?.slice(-5)} exceeded quota for 'search.list' operation (${reason}), marking as limited and trying next key`);
          if (currentApiKey) {
            keyManager.markKeyAsQuotaExceeded(currentApiKey, 'search.list');
          }
        } else {
          // Other error, not quota related
          console.error(`YouTube API error for key ${currentApiKey?.slice(-5)}: ${reason || 'Unknown error'}`);
        }
        // Increment attempt count to avoid getting stuck
        attemptsCount++;
      }
    }
    
    return [];
  } catch (error) {
    console.error('Error in getRecommendationsFromRelatedArtist:', error);
    return [];
  }
}

/**
 * Get recommendations based on genre tags
 */
async function getRecommendationsFromGenre(
  seedTrackId: string,
  genreTags: string[],
  keyManager: YouTubeKeyManager
): Promise<Array<{ youtubeId: string }>> {
  try {
    // Try all available API keys for search until we find one that works
    const allApiKeys = await keyManager.getAllKeys();
    
    let attemptsCount = 0;
    const maxAttempts = allApiKeys.length;
    
    while (attemptsCount < maxAttempts) {
      let currentApiKey: string | null = null;
      
      try {
        // Get next API key for search
        currentApiKey = await keyManager.getNextKey('search.list');
        if (!currentApiKey) {
          console.error('No available API keys for YouTube search');
          break;
        }
        
        // Construct a search query using genre tags + official/Topic
        const searchQuery = `(${genreTags.join(' OR ')}) ("Official" OR "official" OR "Topic")`;
        
        console.log(`Searching for genre with query: ${searchQuery} (attempt ${attemptsCount + 1}/${maxAttempts})`);
        
        const searchResponse = await youtube.search.list({
          key: currentApiKey,
          part: ['id', 'snippet'],
          q: searchQuery,
          type: ['video'],
          videoCategoryId: '10', // Music category
          regionCode: 'JP',
          relevanceLanguage: 'ja',
          maxResults: 15
        });
        
        if (searchResponse.data.items && searchResponse.data.items.length > 0) {
          console.log(`Found ${searchResponse.data.items.length} videos from genre search`);
          
          // Filter out the current video
          const filteredItems = searchResponse.data.items.filter(item => 
            item.id?.videoId !== seedTrackId
          );
          
          // Further filter results to official content only
          const officialItems = filteredItems.filter(item => {
            const channelTitle = item.snippet?.channelTitle || '';
            const videoTitle = item.snippet?.title || '';
            
            return (
              // Topic channels are automatically generated by YouTube Music
              channelTitle.includes('Topic') ||
              // Official channels often include "official" in the name
              channelTitle.includes('Official') ||
              channelTitle.includes('official') ||
              // Videos with "Official" in the title are likely official releases
              videoTitle.includes('Official') ||
              videoTitle.includes('official') ||
              // Videos marked as MV (Music Video) are often official
              videoTitle.includes('MV') ||
              videoTitle.includes('M/V') ||
              // Japanese official videos often include (Official Video) in title
              videoTitle.includes('(Official Video)') ||
              videoTitle.includes('【Official】')
            );
          });
          
          // Filter out videos with blocked keywords
          const contentFiltered = filterBlockedContent(officialItems);
          
          if (contentFiltered.length > 0) {
            // Map to the required format and return
            return contentFiltered.map(item => ({ 
              youtubeId: item.id?.videoId || '' 
            })).filter(rec => rec.youtubeId !== '');
          }
        }
        
        // If we couldn't get results, try next key
        console.log(`No valid results found for genre search, trying next key`);
        attemptsCount++;
        
      } catch (error: any) {
        const reason = error?.errors?.[0]?.reason;
        if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
          console.log(`API key ${currentApiKey?.slice(-5)} exceeded quota for 'search.list' operation (${reason}), marking as limited and trying next key`);
          if (currentApiKey) {
            keyManager.markKeyAsQuotaExceeded(currentApiKey, 'search.list');
          }
        }
        // Increment attempt count to avoid getting stuck
        attemptsCount++;
      }
    }
    
    return [];
  } catch (error) {
    console.error('Error in getRecommendationsFromGenre:', error);
    return [];
  }
}

/**
 * Filter out videos with blocked keywords
 */
function filterBlockedContent(items: youtube_v3.Schema$SearchResult[]): youtube_v3.Schema$SearchResult[] {
  const blockedKeywords = [
    'cover', 'カバー',
    '歌ってみた', 'うたってみた',
    'vocaloid', 'ボーカロイド', 'ボカロ',
    'hatsune', 'miku', '初音ミク',
    'live', 'ライブ', 'concert', 'コンサート',
    'remix', 'リミックス',
    'acoustic', 'アコースティック',
    'instrumental', 'インストゥルメンタル',
    'karaoke', 'カラオケ',
    'nightcore',
    'kagamine', 'rin', 'len', '鏡音リン', '鏡音レン',
    'luka', 'megurine', '巡音ルカ',
    'kaito', 'kaiko', 'meiko', 'gumi', 'gackpo', 'ia',
    'utau', 'utauloid', 'utaite',
    'nico', 'niconico', 'ニコニコ',
    'short', 'shorts', 'ショート', 'tiktok', 'tik tok', 'reels',
    'mv reaction', 'reaction', 'リアクション',
    'tutorial', 'lesson', 'how to', 'music theory',
    'guitar', 'drum', 'piano', 'tabs', 'off vocal',
    'ギター', 'ドラム', 'ピアノ', 'オフボーカル'
  ];
  
  return items.filter(item => {
    const title = (item.snippet?.title || '').toLowerCase();
    const channelTitle = (item.snippet?.channelTitle || '').toLowerCase();
    
    // Check for blocked keywords in both title and channel name
    return !blockedKeywords.some(keyword => 
      title.includes(keyword.toLowerCase()) || 
      channelTitle.includes(keyword.toLowerCase())
    );
  });
}

/**
 * Refresh the YouTube recommendations pool in the database
 * This is a background job that runs periodically to ensure we have recommendations
 */
export async function refreshYoutubeRecommendationsPool(): Promise<void> {
  try {
    // Get seed tracks that have fewer than MIN_RECOMMENDATIONS recommendations
    const MIN_RECOMMENDATIONS = 5;
    
    // Find tracks with insufficient recommendations
    const tracksNeedingRecommendations = await prisma.$queryRaw<Array<{ youtubeId: string, recommendationCount: number }>>`
      SELECT t."youtubeId", COUNT(r."youtubeId") as "recommendationCount"
      FROM "Track" t
      LEFT JOIN "YoutubeRecommendation" r ON t."youtubeId" = r."seedTrackId"
      GROUP BY t."youtubeId"
      HAVING COUNT(r."youtubeId") < ${MIN_RECOMMENDATIONS}
      ORDER BY "recommendationCount" ASC
      LIMIT 10
    `;
    
    if (tracksNeedingRecommendations.length === 0) {
      console.log('No tracks need recommendations at this time');
      return;
    }
    
    console.log(`Found ${tracksNeedingRecommendations.length} tracks needing recommendations`);
    
    // Process each track with a delay between requests to avoid rate limiting
    for (const trackInfo of tracksNeedingRecommendations) {
      try {
        console.log(`Fetching recommendations for ${trackInfo.youtubeId} (current count: ${trackInfo.recommendationCount})`);
        
        const recommendations = await getYoutubeRecommendations(trackInfo.youtubeId);
        console.log(`Got ${recommendations.length} recommendations for ${trackInfo.youtubeId}`);
        
        // Introduce delay between API calls to reduce quota usage
        if (trackInfo !== tracksNeedingRecommendations[tracksNeedingRecommendations.length - 1]) {
          const delayTime = 2000 + Math.random() * 3000; // 2-5 second random delay
          await new Promise(resolve => setTimeout(resolve, delayTime));
        }
      } catch (error) {
        console.error(`Error getting recommendations for ${trackInfo.youtubeId}:`, error);
        // Continue with next track despite error
      }
    }
    
    console.log('Finished refreshing YouTube recommendations pool');
  } catch (error) {
    console.error('Error in refreshYoutubeRecommendationsPool:', error);
  }
}

export async function getVideoInfo(videoId: string): Promise<VideoInfo | null> {
  try {
    if (!videoId) {
      console.error('No video ID provided');
      return null;
    }

    // Check cache first
    let trackInfo = await prisma.track.findUnique({
      where: { youtubeId: videoId }
    });

    if (trackInfo && trackInfo.title) {
      // Update last accessed time
      await prisma.track.update({
        where: { youtubeId: videoId },
        data: { updatedAt: new Date() }
      });

      return {
        videoId: trackInfo.youtubeId,
        title: trackInfo.title,
        duration: trackInfo.duration,
        thumbnail: trackInfo.thumbnail
      };
    }

    // Use YouTube API to get video details
    const videoDetails = await executeYoutubeApi('videos.list', async (apiKey) => {
      return youtube.videos.list({
        key: apiKey,
        part: ['snippet', 'contentDetails'],
        id: [videoId]
      });
    });

    if (!videoDetails.data.items || videoDetails.data.items.length === 0) {
      console.error(`No video details found for ID: ${videoId}`);
      return null;
    }

    const video = videoDetails.data.items[0];
    const title = video.snippet?.title || '';
    const duration = parseDuration(video.contentDetails?.duration || 'PT0S');
    const thumbnailUrl = getBestThumbnail(videoId, video.snippet?.thumbnails);

    // Save to database for future cache hits
    await prisma.track.upsert({
      where: { youtubeId: videoId },
      update: {
        title,
        duration,
        thumbnail: thumbnailUrl,
        updatedAt: new Date()
      },
      create: {
        youtubeId: videoId,
        title,
        duration,
        thumbnail: thumbnailUrl
      }
    });

    return {
      videoId,
      title,
      duration,
      thumbnail: thumbnailUrl
    };
  } catch (error) {
    console.error(`Error getting video info for ${videoId}:`, error);
    return null;
  }
}

/**
 * Check if a song is likely Japanese based on title, channel, and tags
 * @param title The video title
 * @param channel The channel title
 * @param tags The video tags
 * @returns True if the song is likely Japanese
 */
function isLikelyJapaneseSong(title: string, channel: string, tags: string[]): boolean {
  // Check for Japanese characters in title or channel
  const japaneseRegex = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF\uFF65-\uFF9F]/;
  if (japaneseRegex.test(title) || japaneseRegex.test(channel)) {
    return true;
  }
  
  // Check for Japanese keywords in title
  const japaneseKeywords = [
    'jpop', 'j-pop', 'jrock', 'j-rock', 
    'anime', 'japanese', 'japan', 
    'tokyo', 'osaka', 'kyoto',
    'utada', 'hikaru', 'yonezu', 'kenshi', 
    'radwimps', 'yorushika', 'yoasobi', 'lisa', 'ado',
    'eve', 'reol', 'zutomayo', 'vaundy', 'tuyu', 'tsuyu',
    'aimer', 'minami', 'mafumafu', 'kenshi', 'fujii', 'kana',
    'daoko', 'aimyon', 'miku', 'hatsune', 'vocaloid',
    'babymetal', 'kyary', 'pamyu', 'perfume', 'akb48',
    'nogizaka', 'keyakizaka', 'sakurazaka', 'hinatazaka'
  ];
  
  const lowerTitle = title.toLowerCase();
  const lowerChannel = channel.toLowerCase();
  
  if (japaneseKeywords.some(keyword => lowerTitle.includes(keyword) || lowerChannel.includes(keyword))) {
    return true;
  }
  
  // Check for Japanese keywords in tags
  if (tags && tags.length > 0) {
    const japaneseTags = [
      'jpop', 'j-pop', 'jrock', 'j-rock', 'japanese', 'japan', 
      'anime', 'アニメ', '日本', '邦楽'
    ];
    
    if (tags.some(tag => {
      const lowerTag = tag.toLowerCase();
      return japaneseRegex.test(tag) || japaneseTags.some(jTag => lowerTag.includes(jTag));
    })) {
      return true;
    }
  }
  
  // Check if channel is a Japanese artist's topic channel
  if (channel.includes('Topic') && (
    japaneseRegex.test(channel) || 
    japaneseKeywords.some(keyword => lowerChannel.includes(keyword))
  )) {
    return true;
  }
  
  return false;
} 