import { google, youtube_v3 } from 'googleapis';
import path from 'path';
import fs from 'fs';
import { mkdir, access } from 'fs/promises';
import { spawn } from 'child_process';
import ffmpeg from 'ffmpeg-static';
import ffprobe from 'ffprobe-static';
import ytDlp from 'yt-dlp-exec';
import ytdl from 'ytdl-core';
import { promisify } from 'util';
import fetch from 'node-fetch';
import { prisma } from '../db.js';
import sharp from 'sharp';
import crypto from 'crypto';
import { execSync } from 'child_process';
import type { ChildProcess } from 'child_process';
import { Readable, Writable } from 'stream';
import { getRootDir } from './env.js';
import { Prisma } from '@prisma/client';
import { downloadAndCacheThumbnail, getThumbnailUrl } from './youtubeMusic.js';
import { MAX_DURATION, MIN_DURATION } from '../config.js';
import { decodeHTML } from 'entities';
import axios from 'axios';
import { getKeyManager, youtubeKeyManager } from './YouTubeKeyManager.js';
import { executeYoutubeApi } from './youtubeApi.js';
import execa from 'execa';
import { filterBlockedContent, isLikelyJapaneseSong } from './contentFilter.js';

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
    await mkdir(path.join(CACHE_DIR, 'temp'), { recursive: true });
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

const execAsync = promisify(execSync);

interface TrackInfo {
  title: string;
  artist?: string;
  thumbnail: string;
  duration: number;
  channelId?: string;
  channelTitle?: string;
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

    // Filter blocked content
    const filteredItems = filterBlockedContent(response.data.items);

    // Get video details for duration
    const videoIds = filteredItems
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
    const results = await Promise.all(filteredItems.map(async (item) => {
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
          updatedAt: new Date()
        },
        create: {
          youtubeId: videoId,
          title,
          duration
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
        const response = await executeYoutubeApi('search.list', async (apiKey) => {
          return youtube.search.list({
            key: apiKey,
            part: ['id'],
            q: query,
            type: ['video'],
            maxResults: 1
          });
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
      where: { youtubeId: videoId },
      include: {
        channel: true
      }
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

      // Check if we need to fetch channel info even though we have track cache
      let channelId = track.channelId;
      let channelTitle = track.channel?.title;

      // If we don't have channel info, fetch it from YouTube API
      if (!channelId || !channelTitle) {
        try {
          console.log(`Track ${videoId} has cache but missing channel info, fetching from API...`);
          const apiKey = await getKeyManager().getCurrentKey('videos.list');
          const response = await youtube.videos.list({
            key: apiKey,
            part: ['snippet'],
            id: [videoId]
          });

          const video = response.data.items?.[0];
          if (video && video.snippet) {
            channelId = video.snippet.channelId;
            channelTitle = video.snippet.channelTitle;

            // Update track with channel info
            if (channelId) {
              // First upsert the channel
              await prisma.channel.upsert({
                where: { id: channelId },
                create: {
                  id: channelId,
                  title: channelTitle || 'Unknown Channel'
                },
                update: {
                  title: channelTitle || 'Unknown Channel'
                }
              });

              // Then update the track
              await prisma.track.update({
                where: { youtubeId: videoId },
                data: {
                  channelId
                }
              });
            }
          }
        } catch (error) {
          console.error(`Failed to fetch channel info for ${videoId}:`, error);
        }
      }

      return {
        title: track.title,
        thumbnail: getThumbnailUrl(videoId),
        duration: track.duration,
        channelId,
        channelTitle
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
        const channelId = video.snippet?.channelId;
        const channelTitle = video.snippet?.channelTitle;
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

        // If we have channel info, upsert the channel
        if (channelId) {
          await prisma.channel.upsert({
            where: { id: channelId },
            create: {
              id: channelId,
              title: channelTitle || 'Unknown Channel'
            },
            update: {
              title: channelTitle || 'Unknown Channel'
            }
          });
        }

        // Cache the track info
        await prisma.track.upsert({
          where: { youtubeId: videoId },
          update: {
            title,
            duration,
            isMusicUrl,
            channelId
          },
          create: {
            youtubeId: videoId,
            title,
            duration,
            isMusicUrl,
            channelId
          }
        });

        return { 
          title, 
          thumbnail, 
          duration,
          channelId,
          channelTitle
        };
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

export async function downloadYoutubeAudio(youtubeId: string, isMusicUrl: boolean = false): Promise<string> {
  // Create a unique temp path to avoid conflicts with parallel downloads
  let uniqueTempPath = '';
  
  try {
    await ensureCacheDirectories();
    
    // Define paths
    const cacheDir = path.join(process.cwd(), 'cache', 'audio');
    const tempDir = path.join(process.cwd(), 'cache', 'temp');
    const finalPath = path.join(cacheDir, `${youtubeId}.m4a`);
    const tempPath = path.join(tempDir, `${youtubeId}.m4a`);
    
    // Check if file already exists in cache
    try {
      const stats = await fs.promises.stat(finalPath);
      if (stats.size > 0) {
        console.log(`✓ [${youtubeId}] Using cached audio`);
        return finalPath;
      }
    } catch (error) {
      // File doesn't exist, continue with download
    }
    
    // Set the unique temp path
    uniqueTempPath = `${tempPath}.${Date.now()}`;
    
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

    // Check if cookies file exists
    const cookiesPath = path.join(process.cwd(), 'youtube_cookies.txt');
    let cookiesExist = false;
    try {
      await fs.promises.access(cookiesPath, fs.constants.R_OK);
      cookiesExist = true;
      console.log(`✓ [${youtubeId}] Using cookies for authentication`);
    } catch (error) {
      console.log(`⚠️ [${youtubeId}] No cookies file found, proceeding without authentication`);
    }

    while (retries > 0) {
      try {
        // Construct YouTube URL - use music.youtube.com directly if it's a music URL
        const youtubeUrl = isMusicUrl 
          ? `https://music.youtube.com/watch?v=${youtubeId}`
          : `https://www.youtube.com/watch?v=${youtubeId}`;
        
        console.log(`⬇️ [${youtubeId}] Starting download from ${isMusicUrl ? 'YouTube Music' : 'YouTube'}`);

        // Download with yt-dlp using unique temp path
        const options: any = {
          output: uniqueTempPath,
          extractAudio: true,
          audioFormat: 'wav', // Download as WAV first
          format: 'bestaudio',
          noCheckCertificate: true,
          noWarnings: true,
          quiet: true,
          ffmpegLocation: ffmpeg || undefined,
          formatSort: 'proto:m3u8,abr',
          noPlaylist: true
        };

        // Add cookies if available
        if (cookiesExist) {
          options.cookies = cookiesPath;
        }

        await ytDlp(youtubeUrl, options);

        // yt-dlp might add an extra .wav extension, so check both paths
        let actualFilePath = uniqueTempPath;
        try {
          await fs.promises.access(uniqueTempPath, fs.constants.R_OK);
        } catch (error) {
          // Try with extra .wav extension
          const altPath = `${uniqueTempPath}.wav`;
          try {
            await fs.promises.access(altPath, fs.constants.R_OK);
            actualFilePath = altPath;
            console.log(`✓ [${youtubeId}] Found file with extra extension: ${altPath}`);
          } catch (e) {
            throw new Error(`Downloaded file not found at ${uniqueTempPath} or ${altPath}`);
          }
        }

        // Verify the downloaded file exists and is not empty
        const stats = await fs.promises.stat(actualFilePath);
        if (stats.size === 0) {
          throw new Error('Downloaded file is empty');
        }

        // Apply our custom normalization logic
        console.log(`🎵 [${youtubeId}] Applying volume normalization`);
        await convertToAAC(actualFilePath, finalPath);
        console.log(`✅ [${youtubeId}] Download and normalization complete`);
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
    try {
      await fs.promises.unlink(`${uniqueTempPath}.m4a`);
    } catch (error) {
      // Ignore cleanup errors
    }
    activeDownloads.delete(youtubeId);
  }
}

async function convertToAAC(inputPath: string, outputPath: string): Promise<void> {
  return new Promise(async (resolve, reject) => {
    try {
      // First pass: run volumedetect filter to measure volume characteristics
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
        stderrData = 'mean_volume: -13.0 dB\nmax_volume: 0.0 dB'; // Default to safe values if detection fails
      }

      // Parse volume data
      const meanMatch = stderrData.match(/mean_volume:\s*(-?\d+(\.\d+)?) dB/);
      const maxMatch = stderrData.match(/max_volume:\s*(-?\d+(\.\d+)?) dB/);
      const meanVolume = meanMatch ? parseFloat(meanMatch[1]) : -13.0;
      const maxVolume = maxMatch ? parseFloat(maxMatch[1]) : 0.0;

      // Base FFmpeg arguments
      const baseArgs = [
        '-i', inputPath,
        '-c:a', 'aac',
        '-b:a', '256k',
        '-ar', '48000',
        '-ac', '2',
        '-movflags', '+faststart',
        outputPath
      ];

      // Determine audio processing based on mean volume
      let audioFilters = [];
      
      if (meanVolume >= -14 && meanVolume <= -13) {
        console.log(`📊 [${inputPath}] Mean volume ${meanVolume.toFixed(1)}dB is within target range (-14dB to -13dB), skipping normalization`);
      } else if (meanVolume > -13) {
        const gain = -13 - meanVolume;
        console.log(`📊 [${inputPath}] Mean volume ${meanVolume.toFixed(1)}dB is too loud, reducing by ${gain.toFixed(1)}dB`);
        audioFilters.push(`volume=${gain}dB`);
      } else if (meanVolume < -14) {
        const gain = -13 - meanVolume;
        console.log(`📊 [${inputPath}] Mean volume ${meanVolume.toFixed(1)}dB is too quiet, boosting by ${gain.toFixed(1)}dB with compression`);
        audioFilters.push(`volume=${gain}dB,acompressor=threshold=-1dB:ratio=2:attack=5:release=100`);
      }

      // Add audio filters if needed
      if (audioFilters.length > 0) {
        baseArgs.splice(2, 0, '-af', audioFilters.join(','));
      }

      // Run FFmpeg conversion
      await new Promise<void>((res, rej) => {
        const process = spawn(ffmpeg!, baseArgs);

        process.on('error', (error) => {
          console.error('FFmpeg conversion error:', error);
          rej(error);
        });

        process.on('close', (code) => {
          if (code === 0) res();
          else rej(new Error(`FFmpeg conversion exited with code ${code}`));
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
    // First check if the seed track is blocked
    const seedTrack = await prisma.track.findUnique({
      where: { youtubeId: seedTrackId },
      include: { channel: true }
    });

    if (!seedTrack) {
      console.log(`Seed track ${seedTrackId} not found in database`);
      return [];
    }

    // Don't use blocked tracks as seeds
    if (seedTrack.status === 'BLOCKED') {
      console.log(`Seed track ${seedTrackId} is blocked, skipping recommendations`);
      return [];
    }

    // Don't use tracks from blocked channels as seeds
    if (seedTrack.channel?.isBlocked) {
      console.log(`Seed track ${seedTrackId} is from blocked channel ${seedTrack.channel.id}, skipping recommendations`);
      return [];
    }

    // First check if cookies file exists for YouTube Music recommendations
    const cookiesPath = path.join(process.cwd(), 'youtube_cookies.txt');
    let cookiesExist = false;
    try {
      await access(cookiesPath, fs.constants.R_OK);
      cookiesExist = true;
      console.log('Using cookies for YouTube Music recommendations');
    } catch (error) {
      console.log('No cookies file found, using standard YouTube API for recommendations');
    }
    
    // If cookies exist, try to get recommendations from YouTube Music first
    if (cookiesExist) {
      try {
        const ytdlpPath = path.join(process.cwd(), 'node_modules/yt-dlp-exec/bin/yt-dlp');
        
        // Get the radio/mix playlist for this track
        const radioUrl = `https://music.youtube.com/watch?v=${seedTrackId}&list=RDAMVM${seedTrackId}`;
        
        console.log(`Fetching YouTube Music recommendations for ${seedTrackId}`);
        
        const { stdout } = await execa(ytdlpPath, [
          radioUrl,
          '--cookies', cookiesPath,
          '--flat-playlist',
          '--dump-json',
          '--no-download'
        ]);
        
        if (!stdout || stdout.trim() === '') {
          console.log('No output from yt-dlp command');
          throw new Error('No output from yt-dlp command');
        }
        
        const items = stdout.split('\n')
          .filter(line => line.trim())
          .map(line => JSON.parse(line));
        
        console.log(`Found ${items.length} tracks in the recommendation playlist`);
        
        // Filter out the seed track and blocked tracks/channels
        const filteredItems = [];
        for (const item of items) {
          if (item.id === seedTrackId) continue;

          // Check if track is blocked
          const track = await prisma.track.findUnique({
            where: { youtubeId: item.id },
            include: { channel: true }
          });

          if (track?.status === 'BLOCKED') continue;
          if (track?.channel?.isBlocked) continue;

          // Check if channel is blocked even if track doesn't exist
          if (item.channel_id) {
            const channel = await prisma.channel.findUnique({
              where: { id: item.channel_id }
            });
            if (channel?.isBlocked) continue;
          }

          filteredItems.push(item);
        }
        
        // Filter for Japanese tracks and exclude Chinese content
        const japaneseTracks = filteredItems.filter(item => {
          return isLikelyJapaneseSong(
            item.title || '', 
            item.channel || '', 
            []  // No tags available from yt-dlp output
          );
        });
        
        console.log(`${japaneseTracks.length} tracks identified as likely Japanese`);
        
        if (japaneseTracks.length > 0) {
          // Limit to 5 recommendations per seed track
          const limitedTracks = japaneseTracks.slice(0, 5);
          
          // Map to the required format
          const recommendations = limitedTracks.map(track => ({ 
            youtubeId: track.id 
          }));
          
          // Store recommendations in the database
          for (const rec of recommendations) {
            try {
              // Check if this video is already recommended
              const existingRec = await prisma.youtubeRecommendation.findUnique({
                where: {
                  youtubeId: rec.youtubeId
                }
              });

              if (!existingRec) {
                // Only create if this video hasn't been recommended before
                await prisma.youtubeRecommendation.create({
                  data: {
                    seedTrackId,
                    youtubeId: rec.youtubeId,
                    wasPlayed: false
                  }
                });
              }
              // Skip if already exists - we don't want duplicate recommendations
            } catch (dbError) {
              console.error(`Failed to store recommendation ${rec.youtubeId} for seed ${seedTrackId}:`, dbError);
              // Continue with next recommendation despite error
              continue;
            }
          }
          
          console.log(`Returning ${recommendations.length} YouTube Music recommendations (limited to 5)`);
          return recommendations;
        }
        
        console.log('No Japanese tracks found in YouTube Music recommendations, falling back to standard method');
      } catch (ytdlpError) {
        console.error('Failed to get recommendations using yt-dlp:', ytdlpError);
        console.log('Falling back to standard YouTube API method');
      }
    }
    
    // If YouTube Music method failed or no cookies, use the standard YouTube API method
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
    
    // Store recommendations in the database
    for (const rec of recommendations) {
      try {
        // Check if this video is already recommended
        const existingRec = await prisma.youtubeRecommendation.findUnique({
          where: {
            youtubeId: rec.youtubeId
          }
        });

        if (!existingRec) {
          // Only create if this video hasn't been recommended before
          await prisma.youtubeRecommendation.create({
            data: {
              seedTrackId,
              youtubeId: rec.youtubeId,
              wasPlayed: false
            }
          });
        }
        // Skip if already exists - we don't want duplicate recommendations
      } catch (dbError) {
        console.error(`Failed to store recommendation ${rec.youtubeId} for seed ${seedTrackId}:`, dbError);
        // Continue with next recommendation despite error
        continue;
      }
    }
    
    // Validate recommendations to ensure they're available
    const validatedRecommendations = await validateRecommendationDurations(recommendations);
    
    return validatedRecommendations;
  } catch (error) {
    console.error(`Error getting recommendations for ${seedTrackId}:`, error);
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
  try {
    console.log(`Starting validation of ${recommendations.length} recommendations`);
    const validatedRecommendations: Array<{ youtubeId: string }> = [];
    
    // Get all the YouTube IDs
    const youtubeIds = recommendations.map(rec => rec.youtubeId);
    if (youtubeIds.length === 0) return [];
    
    // Check for durations of these videos in our database first
    const existingTracks = await prisma.track.findMany({
      where: {
        youtubeId: { in: youtubeIds }
      },
      select: {
        youtubeId: true,
        duration: true,
        channelId: true
      }
    });
    
    // Create a map of existing tracks for quick lookup
    const existingTracksMap = new Map(
      existingTracks.map(track => [track.youtubeId, track])
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
      // Fetch videos in chunks to avoid exceeding API limits
      const chunkSize = 50; // YouTube API allows up to 50 IDs per request
      for (let i = 0; i < idsToFetch.length; i += chunkSize) {
        const chunk = idsToFetch.slice(i, i + chunkSize);
        
        try {
          const response = await executeYoutubeApi('videos.list', async (apiKey) => {
            return youtube.videos.list({
              key: apiKey,
              part: ['contentDetails', 'snippet'],
              id: chunk
            });
          });
          
          if (response.data.items && response.data.items.length > 0) {
            // Process each video's duration and channel info
            for (const video of response.data.items) {
              const videoId = video.id as string;
              const duration = parseDuration(video.contentDetails?.duration || 'PT0S');
              const title = video.snippet?.title || 'Unknown';
              const channelId = video.snippet?.channelId;
              const channelTitle = video.snippet?.channelTitle;
              
              // If we have channel info, create/update the channel first
              if (channelId && channelTitle) {
                await prisma.channel.upsert({
                  where: { id: channelId },
                  create: {
                    id: channelId,
                    title: channelTitle
                  },
                  update: {
                    title: channelTitle
                  }
                });
              }
              
              // Store in database for future reference
              await prisma.track.upsert({
                where: { youtubeId: videoId },
                update: {
                  title,
                  duration,
                  channelId,
                  updatedAt: new Date()
                },
                create: {
                  youtubeId: videoId,
                  title,
                  duration,
                  channelId
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
        } catch (error) {
          console.error('Error fetching video details:', error);
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
 * Refresh the YouTube recommendations pool in the database
 * This is a background job that runs periodically to ensure we have recommendations
 * and validates existing tracks
 */
export async function refreshYoutubeRecommendationsPool(): Promise<void> {
  try {
    console.log('=== Starting YouTube Recommendations Pool Refresh ===');
    
    // First validate some tracks to ensure our database is clean
    console.log('\n--- Validating Existing Tracks ---');
    const validatedCount = await validateTracksAvailability(20); // Limit to 20 tracks per run
    console.log(`Validated ${validatedCount} tracks`);
    
    // Get seed tracks that have fewer than MIN_RECOMMENDATIONS recommendations
    const MIN_RECOMMENDATIONS = 5;
    
    console.log('\n--- Finding Tracks Needing Recommendations ---');
    // Find tracks with insufficient recommendations, excluding blocked tracks and tracks from blocked channels
    const tracksNeedingRecommendations = await prisma.$queryRaw<Array<{ youtubeId: string, recommendationCount: number }>>`
      SELECT t."youtubeId", COUNT(r."youtubeId") as "recommendationCount"
      FROM "Track" t
      LEFT JOIN "YoutubeRecommendation" r ON t."youtubeId" = r."seedTrackId"
      LEFT JOIN "Channel" c ON t."channelId" = c."id"
      WHERE t."isActive" = true
      AND t."status" != 'BLOCKED'
      AND (c."id" IS NULL OR c."isBlocked" = false)
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
        console.log(`\nFetching recommendations for ${trackInfo.youtubeId} (current count: ${trackInfo.recommendationCount})`);
        
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
    
    console.log('\n=== Finished refreshing YouTube recommendations pool ===');
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
 * Validate tracks in the database to ensure they are still available
 * @param limit Maximum number of tracks to validate in one run
 * @returns Number of tracks validated
 */
export async function validateTracksAvailability(limit: number = 50): Promise<number> {
  try {
    console.log('Starting track validation...');
    
    // Get tracks that haven't been validated recently
    const tracks = await prisma.track.findMany({
      where: {
        isActive: true,
        OR: [
          { lastValidated: null },
          { lastValidated: { lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } } // Older than 30 days
        ]
      },
      take: limit
    });
    
    if (tracks.length === 0) {
      console.log('No tracks need validation');
      return 0;
    }
    
    console.log(`Found ${tracks.length} tracks to validate`);
    let validatedCount = 0;
    
    // Check if cookies file exists
    const cookiesPath = path.join(process.cwd(), 'youtube_cookies.txt');
    let cookiesExist = false;
    try {
      await access(cookiesPath, fs.constants.R_OK);
      cookiesExist = true;
      console.log('Using cookies for track validation');
    } catch (error) {
      console.log('No cookies file found, validation may be limited');
    }
    
    // Validate each track
    for (const track of tracks) {
      try {
        const ytdlpPath = path.join(process.cwd(), 'node_modules/yt-dlp-exec/bin/yt-dlp');
        
        // Construct the URL based on whether it's a music URL
        const url = track.isMusicUrl
          ? `https://music.youtube.com/watch?v=${track.youtubeId}`
          : `https://www.youtube.com/watch?v=${track.youtubeId}`;
        
        // Prepare command arguments
        const args = [
          url,
          '--no-download',
          '--no-warnings',
          '--quiet'
        ];
        
        // Add cookies if available
        if (cookiesExist) {
          args.push('--cookies', cookiesPath);
        }
        
        // Check if the track is available
        await execa(ytdlpPath, args);
        
        // Update the track's validation timestamp
        await prisma.track.update({
          where: { youtubeId: track.youtubeId },
          data: { 
            lastValidated: new Date(),
            isActive: true // Ensure it's marked as active
          }
        });
        
        console.log(`✓ Validated track: ${track.title} (${track.youtubeId})`);
        validatedCount++;
      } catch (error) {
        console.log(`✗ Track is no longer available: ${track.title} (${track.youtubeId})`);
        
        // Mark the track as inactive
        await prisma.track.update({
          where: { youtubeId: track.youtubeId },
          data: { 
            isActive: false,
            lastValidated: new Date()
          }
        });
      }
      
      // Add a small delay between validations to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    console.log(`Validation complete. Validated ${validatedCount} tracks`);
    return validatedCount;
  } catch (error) {
    console.error('Failed to validate tracks:', error);
    return 0;
  }
}

/**
 * Clean up excess recommendations in the database
 * Keeps only the specified number of recommendations per seed track
 * @param maxRecommendationsPerSeed Maximum number of recommendations to keep per seed track
 * @returns Number of recommendations removed
 */
export async function cleanupExcessRecommendations(maxRecommendationsPerSeed: number = 5): Promise<number> {
  try {
    console.log(`Starting cleanup of excess recommendations (keeping max ${maxRecommendationsPerSeed} per seed track)...`);
    
    // Get all seed tracks that have recommendations
    const seedTracks = await prisma.$queryRaw<Array<{ seedTrackId: string, count: number }>>`
      SELECT "seedTrackId", COUNT(*) as count
      FROM "YoutubeRecommendation"
      GROUP BY "seedTrackId"
      HAVING COUNT(*) > ${maxRecommendationsPerSeed}
      ORDER BY COUNT(*) DESC
    `;
    
    if (seedTracks.length === 0) {
      console.log('No seed tracks have excess recommendations');
      return 0;
    }
    
    console.log(`Found ${seedTracks.length} seed tracks with excess recommendations`);
    let totalRemoved = 0;
    
    // Process each seed track
    for (const seedTrack of seedTracks) {
      try {
        // Get all recommendations for this seed track
        const recommendations = await prisma.youtubeRecommendation.findMany({
          where: { seedTrackId: seedTrack.seedTrackId },
          orderBy: { createdAt: 'asc' } // Keep the oldest recommendations
        });
        
        // Calculate how many to remove
        const toRemove = recommendations.length - maxRecommendationsPerSeed;
        if (toRemove <= 0) continue;
        
        // Get the IDs to remove (keep the first maxRecommendationsPerSeed)
        const idsToRemove = recommendations
          .slice(maxRecommendationsPerSeed)
          .map(rec => rec.youtubeId);
        
        // Remove the excess recommendations
        const result = await prisma.youtubeRecommendation.deleteMany({
          where: {
            youtubeId: { in: idsToRemove },
            seedTrackId: seedTrack.seedTrackId
          }
        });
        
        console.log(`Removed ${result.count} excess recommendations for seed track ${seedTrack.seedTrackId}`);
        totalRemoved += result.count;
      } catch (error) {
        console.error(`Error cleaning up recommendations for seed track ${seedTrack.seedTrackId}:`, error);
      }
    }
    
    console.log(`Cleanup complete. Removed ${totalRemoved} excess recommendations`);
    return totalRemoved;
  } catch (error) {
    console.error('Failed to clean up excess recommendations:', error);
    return 0;
  }
}