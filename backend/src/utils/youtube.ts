import { google } from 'googleapis';
import { youtube_v3 } from 'googleapis';
import path from 'path';
import fs from 'fs';
import { mkdir, access } from 'fs/promises';
import { spawn } from 'child_process';
import ffmpeg from 'ffmpeg-static';
import ffprobe from 'ffprobe-static';
import ytDlp from 'yt-dlp-exec';
import ytdl from 'ytdl-core';
import { exec } from 'child_process';
import { promisify } from 'util';
import fetch from 'node-fetch';
import { prisma } from '../db.js';
import sharp from 'sharp';
import crypto from 'crypto';
import { exec as execa } from 'child_process';
import type { ChildProcess } from 'child_process';
import { Readable, Writable } from 'stream';
import { getRootDir } from './env.js';

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
    const apiKeys = process.env.YOUTUBE_API_KEYS?.split(',') || [];
    const singleKey = process.env.YOUTUBE_API_KEY;

    // Combine all available keys
    this.keys = [...new Set([...apiKeys, ...(singleKey ? [singleKey] : [])])];
    
    if (this.keys.length === 0) {
      throw new Error('No YouTube API keys configured');
    }

    this.keyUsage = new Map();
    this.initializeKeyUsage();
    
    // Start periodic cleanup of usage data
    setInterval(() => this.cleanupUsageData(), 5 * 60 * 1000); // Every 5 minutes
    
    // Log number of available keys
    console.log(`Initialized YouTube API with ${this.keys.length} API key(s)`);

    // Validate keys on startup
    this.validateKeys().catch(error => {
      console.error('Error validating YouTube API keys:', error);
    });
  }

  private async validateKeys() {
    console.log('Validating YouTube API keys...');
    const validationPromises = this.keys.map(async (key) => {
      try {
        // Try a simple API call to check if the key works and isn't rate limited
        await youtube.search.list({
          key,
          part: ['id'],
          q: 'test',
          maxResults: 1,
          type: ['video']
        });
        console.log(`✓ API key *****${key.slice(-5)} is valid`);
        return true;
      } catch (error: any) {
        const reason = error?.errors?.[0]?.reason;
        if (reason === 'quotaExceeded') {
          console.log(`✗ API key *****${key.slice(-5)} is quota exceeded`);
          this.markKeyAsQuotaExceeded(key);
          return false;
        } else if (reason === 'dailyLimitExceeded') {
          console.log(`✗ API key *****${key.slice(-5)} has reached daily limit`);
          this.markKeyAsQuotaExceeded(key);
          return false;
        } else {
          console.log(`✗ API key *****${key.slice(-5)} is invalid:`, reason || 'Unknown error');
          this.markKeyAsQuotaExceeded(key);
          return false;
        }
      }
    });

    const results = await Promise.all(validationPromises);
    const validKeys = results.filter(result => result).length;
    console.log(`YouTube API key validation complete: ${validKeys}/${this.keys.length} keys are valid`);

    if (validKeys === 0) {
      console.error('WARNING: All YouTube API keys are invalid or quota exceeded!');
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

      // Skip if key is quota exceeded
      if (usage.quotaExceeded) continue;

      // Reset counters if time has passed
      if (now >= usage.minuteResetTime) {
        usage.minuteCount = 0;
        usage.minuteResetTime = now + this.MINUTE_RESET;
      }
      if (now >= usage.dailyResetTime) {
        usage.dailyCount = 0;
        usage.dailyResetTime = now + this.DAILY_RESET;
        usage.quotaExceeded = false;
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

  public markKeyAsQuotaExceeded(key: string) {
    const usage = this.keyUsage.get(key);
    if (usage) {
      usage.quotaExceeded = true;
      console.log(`YouTube API key *****${key.slice(-5)} quota exceeded, switching to next key`);
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
}

// Create key manager instance lazily
let keyManagerInstance: YouTubeKeyManager | null = null;

function getKeyManager(): YouTubeKeyManager {
  if (!keyManagerInstance) {
    keyManagerInstance = new YouTubeKeyManager();
  }
  return keyManagerInstance;
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

export async function searchYoutube(query: string): Promise<SearchResult[]> {
  try {
    // First try YouTube API search
    const apiKey = await getKeyManager().getCurrentKey('search.list');
    
    // Construct search query
    let searchQuery = query;
    if (!/[一-龯ぁ-んァ-ン]/.test(query)) {
      // If query doesn't contain Japanese characters, add J-pop keywords
      searchQuery = `${query} jpop japanese song`;
    }

    const response = await youtube.search.list({
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

    if (!response.data.items || response.data.items.length === 0) {
      // Try again without region/language restrictions
      const fallbackResponse = await youtube.search.list({
        key: apiKey,
        part: ['id', 'snippet'],
        q: searchQuery,
        type: ['video'],
        maxResults: 10,
        videoCategoryId: '10',
        fields: 'items(id/videoId,snippet/title,snippet/thumbnails)'
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

    const videoDetails = await youtube.videos.list({
      key: apiKey,
      part: ['contentDetails'],
      id: videoIds
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
            getKeyManager().markKeyAsQuotaExceeded(key);
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

// Function to detect and remove black borders
async function processImage(inputBuffer: Buffer): Promise<Buffer> {
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

async function downloadAndCacheThumbnail(videoId: string, thumbnailUrl: string): Promise<void> {
  try {
    // Ensure cache directory exists
    await mkdir(THUMBNAIL_CACHE_DIR, { recursive: true });
    
    // Define paths
    const tempDownloadPath = path.join(THUMBNAIL_CACHE_DIR, `${videoId}.download.jpg`);
    const tempProcessPath = path.join(THUMBNAIL_CACHE_DIR, `${videoId}.processing.jpg`);
    const finalPath = path.join(THUMBNAIL_CACHE_DIR, `${videoId}.jpg`);
    
    // Download the image to temporary file
    const response = await fetch(thumbnailUrl);
    if (!response.ok) {
      throw new Error(`Failed to download thumbnail. Status: ${response.status}`);
    }
    
    const buffer = await response.arrayBuffer();
    const imageBuffer = Buffer.from(buffer);

    // Write the original image to temp download path
    await fs.promises.writeFile(tempDownloadPath, imageBuffer);

    // Process image
    const processedImage = await processImage(imageBuffer);
    
    // Write processed image to temp processing path
    await fs.promises.writeFile(tempProcessPath, processedImage);

    // Get final image metadata
    const metadata = await sharp(processedImage).metadata();

    // Move the processed image to final location
    try {
      await fs.promises.unlink(finalPath);
    } catch (error) {
      // Ignore if file doesn't exist
    }
    await fs.promises.rename(tempProcessPath, finalPath);
    
    // Update database entry using upsert
    await prisma.thumbnailCache.upsert({
      where: { youtubeId: videoId },
      update: {
        filePath: finalPath,
        width: metadata.width || 0,
        height: metadata.height || 0
      },
      create: {
        youtubeId: videoId,
        filePath: finalPath,
        width: metadata.width || 0,
        height: metadata.height || 0
      }
    });

    // Clean up temp download file
    try {
      await fs.promises.unlink(tempDownloadPath);
    } catch (error) {
      // Ignore cleanup errors
    }
  } catch (error) {
    // Clean up any temp files on error
    const tempDownloadPath = path.join(THUMBNAIL_CACHE_DIR, `${videoId}.download.jpg`);
    const tempProcessPath = path.join(THUMBNAIL_CACHE_DIR, `${videoId}.processing.jpg`);
    try {
      await fs.promises.unlink(tempDownloadPath);
    } catch (e) {}
    try {
      await fs.promises.unlink(tempProcessPath);
    } catch (e) {}
    
    console.error('Error downloading thumbnail:', error);
    throw error;
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
        thumbnail: track.thumbnail,
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

        // Cache the track info
        await prisma.track.upsert({
          where: { youtubeId: videoId },
          update: {
            title,
            thumbnail,
            duration,
            isMusicUrl
          },
          create: {
            youtubeId: videoId,
            title,
            thumbnail,
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
            getKeyManager().markKeyAsQuotaExceeded(key);
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
      let backoffDelay = 1000; // Start with 1 second delay

      while (retries > 0) {
        try {
          // Download with yt-dlp using unique temp path
          await ytDlp(youtubeId, {
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
            console.log(`❌ [${youtubeId}] Video is unavailable`);
            throw error; // Propagate error without retrying
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
      throw new Error('Download failed after retries');
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
    try {
      const apiKey = await getKeyManager().getCurrentKey('videos.list');
      const checkResponse = await youtube.videos.list({
        key: apiKey,
        part: ['id'],
        id: [seedTrackId]
      });

      if (!checkResponse.data?.items?.length) {
        console.error(`Seed track ${seedTrackId} is unavailable`);
        return [];
      }
    } catch (error: any) {
      console.error(`Failed to verify seed track ${seedTrackId}:`, error?.errors?.[0]?.reason || 'Unknown error');
      return [];
    }

    // Get API key for search
    const apiKey = await getKeyManager().getCurrentKey('search.list');
    
    // Use the YouTube API to get related videos
    const response = await youtube.search.list({
      key: apiKey,
      part: ['id', 'snippet'],
      q: `related:${seedTrackId}`,
      type: ['video'],
      maxResults: 25,
      regionCode: 'JP',
      relevanceLanguage: 'ja'
    });
    
    if (!response.data?.items || response.data.items.length === 0) {
      // Try again without region/language restrictions
      const fallbackResponse = await youtube.search.list({
        key: apiKey,
        part: ['id', 'snippet'],
        q: `related:${seedTrackId}`,
        type: ['video'],
        maxResults: 25
      });
      
      if (!fallbackResponse.data?.items || fallbackResponse.data.items.length === 0) {
        return [];
      }
      
      response.data.items = fallbackResponse.data.items;
    }
    
    // Filter out videos with blocked keywords
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
      'nico', 'niconico', 'ニコニコ'
    ];
    
    const filteredItems = response.data.items?.filter(item => {
      const title = (item.snippet?.title || '').toLowerCase();
      return !blockedKeywords.some(keyword => title.includes(keyword.toLowerCase()));
    }) || [];
    
    // Get video details for duration filtering and availability check
    const videoIds = filteredItems
      .map(item => item.id?.videoId)
      .filter((id): id is string => !!id);
      
    if (videoIds.length === 0) {
      return [];
    }
    
    // Verify videos are available and check duration
    const videoDetails = await youtube.videos.list({
      key: apiKey,
      part: ['contentDetails', 'status'],
      id: videoIds
    });
    
    // Filter by duration and availability
    const MAX_DURATION = 420; // 7 minutes
    
    const validVideos = videoDetails.data?.items?.filter(video => {
      // Check if video is available
      if (!video.status?.uploadStatus || video.status.uploadStatus !== 'processed' || 
          !video.status?.privacyStatus || video.status.privacyStatus !== 'public') {
        return false;
      }

      // Check duration
      const duration = parseDuration(video.contentDetails?.duration || 'PT0S');
      return duration > 0 && duration <= MAX_DURATION;
    }) || [];
    
    const validIds = new Set(validVideos.map(video => video.id));
    
    // Map to the required format, ensuring no duplicates
    const uniqueIds = [...new Set(filteredItems
      .filter(item => item.id?.videoId && validIds.has(item.id.videoId))
      .map(item => item.id!.videoId!))];

    const recommendations = uniqueIds.map(id => ({ youtubeId: id }));
    
    if (recommendations.length > 0) {
      console.log(`Found ${recommendations.length} valid recommendations for ${seedTrackId}`);
    }
    return recommendations;
  } catch (error: any) {
    console.error('Failed to get recommendations:', error?.errors?.[0]?.reason || 'Unknown error');
    return [];
  }
} 