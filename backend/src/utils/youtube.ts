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
import { downloadAndCacheThumbnail, getThumbnailUrl } from './youtubeMusic.js';
import { MAX_DURATION, MIN_DURATION } from '../config.js';
import { decodeHTML } from 'entities';
import axios from 'axios';
import { getKeyManager, youtubeKeyManager } from './YouTubeKeyManager.js';
import { executeYoutubeApi } from './youtubeApi.js';
import execa from 'execa';
import { filterBlockedContent, isLikelyJapaneseSong, BLOCKED_KEYWORDS } from './contentFilter.js';
import logger from './logger.js';
import { upsertTrack, upsertChannel, getTrackWithChannel, updateTrackStats } from './trackHelpers.js';
import { upsertThumbnailCache, upsertAudioCache, getThumbnailCache, getAudioCacheWithCheck } from './cacheHelpers.js';
import { isValidYouTubeId, extractYoutubeId, validateTrackDuration, parseDuration as parseIsoDuration, sanitizeTitle, sanitizeSearchQuery } from './validationHelpers.js';

// Configure FFmpeg path
if (ffmpeg && ffprobe) {
  process.env.FFMPEG_PATH = typeof ffmpeg === 'string' ? ffmpeg : 
                           ffmpeg.default ?? undefined;
  process.env.FFPROBE_PATH = ffprobe.path;
  logger.info('Using FFmpeg from:', process.env.FFMPEG_PATH || 'Not found');
  logger.info('Using FFprobe from:', process.env.FFPROBE_PATH);
} else {
  logger.error('FFmpeg or FFprobe not found in packages');
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
    logger.error('Failed to create cache directories:', error);
  }
}

// Ensure cache directories exist on startup
ensureCacheDirectories().catch(console.error);

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
export interface SearchResult {
  youtubeId: string;
  title: string;
  thumbnail: string;
  duration: number;
}

interface VideoInfo {
  videoId: string;
  title: string;
  duration: number;
  thumbnail: string;
}

// Export the key manager getter instead of the instance
export const youtube = {
  ...youtubeClient
};

const execAsync = promisify(execSync);

export interface TrackInfo {
  youtubeId: string;
  title: string;
  artist?: string;
  thumbnail: string;
  duration: number;
  channelId?: string;
  channelTitle?: string;
  description?: string;
  tags?: string[];
  viewCount?: number;
  channel?: string;
  channel_id?: string;
  likeCount?: number;
  publishedAt?: string;
}

export async function searchYoutube(query: string): Promise<SearchResult[]> {
  try {
    // Use YouTubeAPIManager for search
    const { getYouTubeAPIManager } = await import('./youtubeApiManager.js');
    const youtubeAPI = getYouTubeAPIManager();
    
    // Construct search query with J-pop preference if no Japanese characters
    let searchQuery = query;
    if (!/[\u4e00-\u9faf\u3041-\u3093\u30a1-\u30f3]/.test(query)) {
      searchQuery = `${query} jpop japanese song`;
    }

    // Search using manager with Japanese preferences
    const results = await youtubeAPI.searchVideos(searchQuery, {
      maxResults: 10,
      order: 'relevance',
      regionCode: 'JP',
      relevanceLanguage: 'ja'
    });

    // If no results, try fallback without region restrictions
    if (results.length === 0) {
      const fallbackResults = await youtubeAPI.searchVideos(searchQuery, {
        maxResults: 10,
        order: 'relevance'
      });
      
      if (fallbackResults.length > 0) {
        return fallbackResults.map(result => ({
          youtubeId: result.youtubeId,
          title: result.title,
          thumbnail: `${API_BASE_URL}/api/albumart/${result.youtubeId}`,
          duration: result.duration || 0
        }));
      }
    }

    // Convert manager results to legacy format
    const convertedResults = results.map(result => ({
      youtubeId: result.youtubeId,
      title: result.title,
      thumbnail: `${API_BASE_URL}/api/albumart/${result.youtubeId}`,
      duration: result.duration || 0
    }));

    // Create track entries for caching
    for (const result of convertedResults) {
      try {
        const { upsertTrack } = await import('./trackHelpers.js');
        await upsertTrack({
          youtubeId: result.youtubeId,
          title: result.title,
          duration: result.duration
        });
      } catch (error) {
        logger.error(`Failed to upsert track ${result.youtubeId}:`, error);
      }
    }

    // If no results, try local cache fallback
    if (convertedResults.length === 0) {
      try {
        const { prisma } = await import('../db.js');
        const localResults = await prisma.track.findMany({
          where: {
            title: { contains: query, mode: 'insensitive' }
          },
          take: 5,
          orderBy: { updatedAt: 'desc' }
        });

        return localResults.map(track => ({
          youtubeId: track.youtubeId,
          title: track.title,
          thumbnail: `${API_BASE_URL}/api/albumart/${track.youtubeId}`,
          duration: Number(track.duration) || 0
        }));
      } catch (cacheError) {
        logger.error('Local cache fallback failed:', cacheError);
      }
    }

    return convertedResults;
  } catch (error) {
    logger.error('YouTube search failed:', error);
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
          logger.error('Failed to parse YouTube URL');
          return { videoId: undefined, isMusicUrl: false };
        }
      }

      if (!videoId || !videoId.match(/^[a-zA-Z0-9_-]{11}$/)) {
        logger.error('Invalid YouTube video ID format');
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
            logger.info(`YouTube API quota exceeded for key *****${key.slice(-5)}`);
            getKeyManager().markKeyAsQuotaExceeded(key, 'search.list');
            retries--;
            if (retries > 0) continue;
          }
        }
        logger.error('YouTube search failed:', error?.errors?.[0]?.reason || 'Unknown error');
        break;
      }
    }
    return { videoId: undefined, isMusicUrl: false };
  } catch (error) {
    logger.error('Failed to get YouTube ID');
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
      logger.error(`Error checking thumbnail quality ${quality}:`, error);
      continue;
    }
  }
  // Fallback to hqdefault if all checks fail
  return `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`;
}

export async function getYoutubeInfo(videoId: string, isMusicUrl: boolean = false): Promise<TrackInfo> {
  try {
    // First check if we have the track cached
    const track = await getTrackWithChannel(videoId);

    // If we have complete cached data, use it
    if (track && track.duration > 0 && track.channelId && track.channel?.title) {
      // Update isMusicUrl if needed
      if (isMusicUrl && !track.isMusicUrl) {
        await prisma.track.update({
          where: { youtubeId: videoId },
          data: { isMusicUrl: true }
        });
      }

      // Ensure thumbnail exists
      const thumbnailCache = await getThumbnailCache(videoId);
      if (!thumbnailCache) {
        try {
          const thumbnailUrl = await getBestThumbnail(videoId);
          await downloadAndCacheThumbnail(videoId, thumbnailUrl);
        } catch (error) {
          logger.error(`Failed to download thumbnail for ${videoId}:`, error);
        }
      }

      return {
        youtubeId: videoId,
        title: track.title,
        thumbnail: getThumbnailUrl(videoId),
        duration: track.duration,
        channelId: track.channelId,
        channelTitle: track.channel.title
      };
    }

    // Use YouTubeAPIManager to get video info
    const { getYouTubeAPIManager } = await import('./youtubeApiManager.js');
    const youtubeAPI = getYouTubeAPIManager();
    
    const videoInfo = await youtubeAPI.getVideoInfo(videoId, {
      includeSnippet: true,
      includeContentDetails: true,
      includeStatistics: false
    });

    if (!videoInfo) {
      throw new Error(`Video not found: ${videoId}`);
    }

    // Download and cache thumbnail
    try {
      const thumbnailUrl = videoInfo.thumbnail || await getBestThumbnail(videoId);
      await downloadAndCacheThumbnail(videoId, thumbnailUrl);
    } catch (error) {
      logger.error(`Failed to download thumbnail for ${videoId}:`, error);
    }

    // Cache the track info
    const { upsertTrack, upsertChannel } = await import('./trackHelpers.js');
    
    // Upsert channel if we have channel info
    if (videoInfo.channelId && videoInfo.channelTitle) {
      await upsertChannel({
        id: videoInfo.channelId,
        title: videoInfo.channelTitle
      });
    }

    // Cache the track
    await upsertTrack({
      youtubeId: videoId,
      title: videoInfo.title,
      duration: videoInfo.duration || 0,
      isMusicUrl,
      channelId: videoInfo.channelId
    });

    return {
      youtubeId: videoId,
      title: videoInfo.title,
      thumbnail: getThumbnailUrl(videoId),
      duration: videoInfo.duration || 0,
      channelId: videoInfo.channelId,
      channelTitle: videoInfo.channelTitle
    };

  } catch (error) {
    logger.error(`Failed to get YouTube info for ${videoId}:`, error);
    throw error;
  }
}

// Add download lock tracking
const activeDownloads = new Map<string, Promise<string>>();

// Function to handle yt-dlp errors and update if needed
async function handleYtDlpError(error: any): Promise<boolean> {
  const errorStr = error?.stderr || error?.message || '';
  
  if (errorStr.includes('Requested format is not available')) {
    logger.info('Detected format error, attempting to update yt-dlp...');
    
    return new Promise<boolean>((resolve) => {
      const updateScript = path.join(__dirname, '../../scripts/update-yt-dlp.ts');
      
      // Execute the update script
      const process = spawn('npx', ['tsx', updateScript, '--force'], {
        stdio: ['ignore', 'pipe', 'pipe']
      });
      
      let stdout = '';
      let stderr = '';
      
      process.stdout.on('data', (data) => {
        stdout += data.toString();
        logger.info(`[yt-dlp-update] ${data.toString().trim()}`);
      });
      
      process.stderr.on('data', (data) => {
        stderr += data.toString();
        logger.error(`[yt-dlp-update] ${data.toString().trim()}`);
      });
      
      process.on('close', (code) => {
        if (code === 0) {
          logger.info('yt-dlp update completed successfully');
          resolve(true);
        } else {
          logger.error(`yt-dlp update failed with code ${code}`);
          logger.error('Error output:', stderr);
          resolve(false);
        }
      });
    });
  }
  
  return false;
}

export async function downloadYoutubeAudio(youtubeId: string, isMusicUrl: boolean = false): Promise<string> {
  try {
    // Use AudioProcessingManager for audio processing
    const { getAudioProcessingManager } = await import('./audioProcessingManager.js');
    const audioProcessor = getAudioProcessingManager();
    
    const result = await audioProcessor.processAudio(youtubeId, {
      quality: 'medium',
      normalize: true,
      maxDuration: 600, // 10 minutes
      minDuration: 30   // 30 seconds
    });

    if (!result.success || !result.filePath) {
      throw new Error(result.error || 'Failed to process audio');
    }

    logger.info(`✅ [${youtubeId}] Audio download complete: ${result.filePath}`);
    return result.filePath;

  } catch (error) {
    logger.error(`❌ [${youtubeId}] Download failed:`, error);
    throw error;
  }
}

async function measureMeanVolume(inputPath: string): Promise<{ mean: number; max: number }> {
  try {
    // Use AudioProcessingManager for volume measurement
    const { getAudioProcessingManager } = await import('./audioProcessingManager.js');
    const audioProcessor = getAudioProcessingManager();
    
    const meanVolume = await audioProcessor.measureMeanVolume(inputPath);
    
    // AudioProcessingManager returns just the mean, but this function expects mean and max
    // For backward compatibility, return the same value for both
    return {
      mean: meanVolume,
      max: meanVolume + 6 // Estimate max as mean + 6dB (typical difference)
    };
  } catch (error) {
    throw new Error(`Failed to measure volume: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

async function normalizeAudio(inputPath: string, outputPath: string, volumeAdjustment: number, outputFormat: 'wav' | 'aac' = 'wav', needsLimiting: boolean = false): Promise<void> {
  return new Promise((resolve, reject) => {
    // Build filter string based on whether limiting is needed
    const filterString = needsLimiting 
      ? `volume=${volumeAdjustment}dB,alimiter=limit=0.891:level=disabled:attack=5:release=50:level_in=1:level_out=1`
      : `volume=${volumeAdjustment}dB`;

    // Base FFmpeg arguments
    const args = [
          '-hide_banner',
      '-y',  // Force overwrite
          '-i', inputPath,
      '-af', filterString
    ];

    // Add output format specific arguments
    if (outputFormat === 'aac') {
      args.push(
          '-c:a', 'aac',
          '-b:a', '256k',
          '-ar', '48000',
          '-ac', '2',
        '-movflags', '+faststart'
      );
    } else {
      // For WAV, use high quality settings
      args.push(
        '-c:a', 'pcm_s16le',  // 16-bit PCM
        '-ar', '48000',       // 48kHz sample rate
        '-ac', '2'            // Stereo
      );
    }

    // Add output path
    args.push(outputPath);

    const ffmpeg = spawn('ffmpeg', args);

    let stderr = '';
    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffmpeg.on('close', (code) => {
      if (code !== 0) {
        logger.error('FFmpeg stderr output:', stderr);
        reject(new Error(`FFmpeg process exited with code ${code}`));
        return;
      }
      resolve();
    });

    ffmpeg.on('error', (err) => {
      logger.error('FFmpeg stderr output:', stderr);
      reject(new Error(`FFmpeg process error: ${err.message}`));
    });
  });
}

async function convertToAAC(inputPath: string, outputPath: string): Promise<void> {
  try {
    // First check if the input is already in our target range
    const inputMetrics = await measureMeanVolume(inputPath);
    const inputMean = inputMetrics.mean;
    const inputMax = inputMetrics.max;

    logger.info(`Input file metrics: mean=${inputMean.toFixed(2)}dB, max=${inputMax.toFixed(2)}dB`);

    // Extract YouTube ID from input path for parallel-safe naming
    const youtubeId = inputPath.split('/').pop()?.split('.')[0] || 'unknown';

    // If input is already in our target range (-14 to -13 dB), we can potentially skip normalization
    if (inputMean >= -14 && inputMean <= -13) {
      logger.info('Mean volume already in target range');
      // Check if we need limiting
      if (inputMax <= -1) {
        logger.info('Max volume is already good, direct encoding to AAC');
        await normalizeAudio(inputPath, outputPath, 0, 'aac', false);
      } else {
        logger.info('Max volume too high, applying limiter during encoding');
        await normalizeAudio(inputPath, outputPath, 0, 'aac', true);
      }
      const finalMetrics = await measureMeanVolume(outputPath);
      logger.info('\nFinal result:');
      logger.info(`Mean: ${finalMetrics.mean.toFixed(2)}dB (target: -14 to -13 dB)`);
      logger.info(`Max: ${finalMetrics.max.toFixed(2)}dB (target: below -1 dB)`);
      return;
    }

    // Calculate initial volume adjustment to reach target mean
    const targetMean = -13.5; // Center of our target range
    let volumeAdjustment = targetMean - inputMean;
    let bestResult = { mean: inputMean, max: inputMax, volumeAdjustment, needsLimiting: false };
    let bestScore = Number.MAX_VALUE;

    // Phase 1: Get mean volume right (no limiting, WAV output)
    const maxAttempts = 5;
    let attempt = 1;
    let meanAchieved = false;
    let normalizedWavPath = '';
    
    while (attempt <= maxAttempts && !meanAchieved) {
      logger.info(`\nAttempt ${attempt}: volume=${volumeAdjustment.toFixed(2)}dB`);
      
      // Use parallel-safe attempt filename for WAV
      const attemptPath = `${outputPath.replace('.m4a', '')}.${youtubeId}.attempt${attempt}.wav`;
      
      // Process without limiting, output as WAV
      await normalizeAudio(inputPath, attemptPath, volumeAdjustment, 'wav', false);
      
      // Check result
      const result = await measureMeanVolume(attemptPath);
      logger.info(`Result: mean=${result.mean.toFixed(2)}dB, max=${result.max.toFixed(2)}dB`);
      
      // Calculate score based on how close mean is to target
      const meanDiff = Math.abs(result.mean - targetMean);
      const currentScore = meanDiff;
      
      // Update best result if this attempt is better
      if (currentScore < bestScore) {
        bestScore = currentScore;
        bestResult = { ...result, volumeAdjustment, needsLimiting: result.max > -1 };
        normalizedWavPath = attemptPath;
        
        // If mean is in range, we're done with phase 1
        if (result.mean >= -14 && result.mean <= -13) {
          logger.info('Achieved target mean range!');
          meanAchieved = true;
          break;
        }
      }
      
      // Clean up current attempt file if not the best
      if (currentScore >= bestScore && attemptPath !== normalizedWavPath) {
        await fs.promises.unlink(attemptPath).catch(() => {});
      }
      
      // Adjust volume for next attempt if needed
      if (result.mean < -14) {
        volumeAdjustment += 0.8; // Too quiet, increase volume
      } else if (result.mean > -13) {
        volumeAdjustment -= 0.8; // Too loud, decrease volume
      }
      
      attempt++;
    }

    // Clean up any remaining attempt files except the best one
    for (let i = 1; i <= maxAttempts; i++) {
      const attemptPath = `${outputPath.replace('.m4a', '')}.${youtubeId}.attempt${i}.wav`;
      if (attemptPath !== normalizedWavPath) {
        await fs.promises.unlink(attemptPath).catch(() => {});
      }
    }

    if (!normalizedWavPath) {
      throw new Error('Failed to achieve target mean volume range');
    }

    // Phase 2: Final encoding to AAC, with limiting if needed
    logger.info('\nFinal encoding phase:');
    const needsLimiting = bestResult.max > -1;
    if (needsLimiting) {
      logger.info('Applying limiter during final encoding');
    } else {
      logger.info('No limiting needed for final encoding');
    }

    // Encode the best normalized WAV to AAC
    await normalizeAudio(normalizedWavPath, outputPath, 0, 'aac', needsLimiting);

    // Clean up the intermediate WAV file
    await fs.promises.unlink(normalizedWavPath).catch(() => {});

    // Verify final result
    const finalMetrics = await measureMeanVolume(outputPath);
    logger.info('\nFinal result:');
    logger.info(`Mean: ${finalMetrics.mean.toFixed(2)}dB (target: -14 to -13 dB)`);
    logger.info(`Max: ${finalMetrics.max.toFixed(2)}dB (target: below -1 dB)`);
    logger.info(`Initial volume adjustment: ${bestResult.volumeAdjustment.toFixed(2)}dB`);
    logger.info(`Limiting applied: ${needsLimiting}`);
    } catch (error) {
    logger.error('Error in convertToAAC:', error);
    throw error;
    }
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
      logger.error('Invalid playlist URL:', url);
      return [];
    }

    // Use YouTubeAPIManager for playlist operations
    const { getYouTubeAPIManager } = await import('./youtubeApiManager.js');
    const youtubeAPI = getYouTubeAPIManager();
    
    const results = await youtubeAPI.getPlaylistVideos(playlistId, {
      maxResults: 200 // Get up to 200 videos from playlist
    });
    
    const videoIds = results.map(result => result.videoId);
    logger.info(`Found ${videoIds.length} videos in playlist`);
    return videoIds;
  } catch (error) {
    logger.error('Failed to fetch playlist:', error);
    return [];
  }
}

export async function getAudioFileDuration(filePath: string): Promise<number> {
    try {
        // Use AudioProcessingManager for duration measurement
        const { getAudioProcessingManager } = await import('./audioProcessingManager.js');
        const audioProcessor = getAudioProcessingManager();
        
        return await audioProcessor.getAudioDuration(filePath);
    } catch (error) {
        logger.error('Failed to get audio duration:', error);
        throw error;
    }
}

/**
 * Get YouTube recommendations for a seed track
 * @param seedTrackId The YouTube ID of the seed track
 * @returns Array of recommended track IDs
 */
export async function getYoutubeRecommendations(seedTrackId: string): Promise<Array<{ youtubeId: string; title?: string }>> {
  try {
    // Check if the seed track is valid
    const seedTrack = await getTrackWithChannel(seedTrackId);
    if (!seedTrack) {
      logger.info(`Seed track ${seedTrackId} not found in database`);
      return [];
    }

    // Don't use blocked tracks or channels as seeds
    if (seedTrack.status === 'BLOCKED') {
      logger.info(`Seed track ${seedTrackId} is blocked, skipping recommendations`);
      return [];
    }

    if (seedTrack.channel?.isBlocked) {
      logger.info(`Seed track ${seedTrackId} is from blocked channel, skipping recommendations`);
      return [];
    }
    
    if (!isValidDuration(seedTrack.duration)) {
      logger.info(`Seed track ${seedTrackId} has invalid duration, skipping recommendations`);
      return [];
    }

    // Check if we already have recommendations
    const existingSeedRecs = await prisma.youtubeRecommendation.findMany({
      where: { seedTrackId },
      select: { youtubeId: true }
    });
    
    const existingRecIds = new Set(existingSeedRecs.map(rec => rec.youtubeId));
    
    if (existingRecIds.size >= 5) {
      logger.info(`Already have ${existingRecIds.size} recommendations for seed ${seedTrackId}`);
      return Array.from(existingRecIds).map(id => ({ youtubeId: id }));
    }

    // Use YouTubeAPIManager to get raw recommendations
    const { getYouTubeAPIManager } = await import('./youtubeApiManager.js');
    const youtubeAPI = getYouTubeAPIManager();
    
    const rawRecommendations = await youtubeAPI.getYoutubeRecommendations(seedTrackId, {
      maxResults: 20 // Get more to filter from
    });
    
    if (rawRecommendations.length === 0) {
      logger.info('No YouTube Music recommendations available');
      return Array.from(existingRecIds).map(id => ({ youtubeId: id }));
    }

    // Filter recommendations through various checks
    const filteredRecommendations: Array<{ youtubeId: string; title?: string }> = [];
    
    for (const rec of rawRecommendations) {
      if (filteredRecommendations.length >= 5) break;
      
      // Check if track is blocked
      const track = await getTrackWithChannel(rec.youtubeId);
      if (track?.status === 'BLOCKED') continue;
      
      // Check if channel is blocked
      const channelBlocked = await isChannelBlocked(
        track?.channel?.id,
        track?.channel?.title
      );
      if (channelBlocked) continue;
      
      // Check for blocked keywords
      const title = (rec.title || '').toLowerCase();
      if (BLOCKED_KEYWORDS.some(keyword => title.includes(keyword.toLowerCase()))) {
        continue;
      }
      
      // Check if it's likely Japanese content
      if (!isLikelyJapaneseSong(rec.title || '', track?.channel?.title || '', [], [])) {
        continue;
      }
      
      // Check if already exists in recommendations database
      const existingRecs = await prisma.youtubeRecommendation.findFirst({
        where: { youtubeId: rec.youtubeId }
      });
      if (existingRecs) continue;
      
      filteredRecommendations.push({
        youtubeId: rec.youtubeId,
        title: rec.title
      });
    }

    // Store new recommendations in database
    for (const rec of filteredRecommendations) {
      try {
        await prisma.youtubeRecommendation.create({
          data: {
            seedTrackId,
            youtubeId: rec.youtubeId,
            wasPlayed: false,
            title: rec.title || 'Unknown'
          }
        });
        
        existingRecIds.add(rec.youtubeId);
        logger.info(`  • ${rec.youtubeId} (${rec.title || 'Unknown'})`);
      } catch (dbError) {
        logger.error(`Failed to store recommendation ${rec.youtubeId}:`, dbError);
      }
    }

    const finalCount = await prisma.youtubeRecommendation.count({
      where: { seedTrackId }
    });
    
    logger.info(`✓ Complete: ${finalCount} total recommendations for ${seedTrackId}`);
    return Array.from(existingRecIds).map(id => ({ youtubeId: id }));

  } catch (error) {
    logger.error(`Error getting recommendations for ${seedTrackId}:`, error);
    return [];
  }
}

/**
 * Check if a duration is valid according to MIN_DURATION and MAX_DURATION
 */
async function isChannelBlocked(channelId?: string, channelName?: string): Promise<boolean> {
  if (!channelId && !channelName) return false;
  
  // First try by ID
  if (channelId) {
    const byId = await prisma.channel.findUnique({
      where: { id: channelId },
      select: { isBlocked: true }
    });
    if (byId) return byId.isBlocked;
  }

  // Fallback to name check
  if (channelName) {
    const normalized = channelName.toLowerCase().trim();
    const byName = await prisma.channel.findFirst({
      where: {
        title: { equals: normalized, mode: 'insensitive' },
        isBlocked: true
      }
    });
    return !!byName;
  }

  return false;
}

function isValidDuration(duration: number): boolean {
  if (!duration) return false;
  return duration >= MIN_DURATION && duration <= MAX_DURATION;
}

/**
 * Refresh the YouTube recommendations pool in the database
 * This is a background job that runs periodically to ensure we have recommendations
 * and validates existing tracks
 */
export async function refreshYoutubeRecommendationsPool(): Promise<void> {
  try {
    logger.info('=== Starting YouTube Recommendations Refresh ===');
    
    // First validate some tracks to ensure our database is clean
    logger.info('Validating tracks...');
    const validatedCount = await validateTracksAvailability(20); // Limit to 20 tracks per run
    logger.info(`✓ Validated ${validatedCount} tracks`);
    
    // Get seed tracks that have fewer than MIN_RECOMMENDATIONS recommendations
    const MIN_RECOMMENDATIONS = 5;
    
    logger.info('Finding tracks needing recommendations...');
    // Find tracks with insufficient recommendations, excluding blocked tracks and tracks from blocked channels
    // Order by recommendation count ascending to prioritize tracks with fewer recommendations
    const tracksNeedingRecommendations = await prisma.$queryRaw<Array<{ youtubeId: string, recommendationCount: number, title: string }>>`
      SELECT t."youtubeId", t."title", COUNT(r."youtubeId") as "recommendationCount"
      FROM "Track" t
      LEFT JOIN "YoutubeRecommendation" r ON t."youtubeId" = r."seedTrackId"
      LEFT JOIN "Channel" c ON t."channelId" = c."id"
      WHERE t."isActive" = true
      AND t."status" != 'BLOCKED'
      AND (c."id" IS NULL OR c."isBlocked" = false)
      AND t."duration" >= ${MIN_DURATION}
      AND t."duration" <= ${MAX_DURATION}
      GROUP BY t."youtubeId", t."title"
      HAVING COUNT(r."youtubeId") < ${MIN_RECOMMENDATIONS}
      ORDER BY "recommendationCount" ASC, RANDOM()
      LIMIT 10
    `;
    
    if (tracksNeedingRecommendations.length === 0) {
      logger.info('✓ No tracks need recommendations at this time');
      return;
    }
    
    logger.info(`Found ${tracksNeedingRecommendations.length} tracks needing recommendations:`);
    
    // Process each track with a delay between requests to avoid rate limiting
    for (const trackInfo of tracksNeedingRecommendations) {
      try {
        logger.info(`\n▶ Processing: ${trackInfo.youtubeId} (${trackInfo.title}) - ${trackInfo.recommendationCount}/${MIN_RECOMMENDATIONS}`);
        
        const recommendations = await getYoutubeRecommendations(trackInfo.youtubeId);
        
        // Verify the recommendations were actually stored by querying the database again
        const updatedCount = await prisma.youtubeRecommendation.count({
          where: {
            seedTrackId: trackInfo.youtubeId
          }
        });
        
        if (updatedCount > trackInfo.recommendationCount) {
          logger.info(`✓ Added ${Number(updatedCount) - Number(trackInfo.recommendationCount)} recommendations, now at ${updatedCount}/${MIN_RECOMMENDATIONS}`);
        } else {
          logger.info(`⚠ No new recommendations added, still at ${updatedCount}/${MIN_RECOMMENDATIONS}`);
        }
        
        // Introduce delay between API calls to reduce quota usage
        if (trackInfo !== tracksNeedingRecommendations[tracksNeedingRecommendations.length - 1]) {
          const delayTime = 2000 + Math.random() * 3000; // 2-5 second random delay
          const delaySeconds = Math.round(delayTime/1000);
          logger.info(`Waiting ${delaySeconds}s before next request...`);
          await new Promise(resolve => setTimeout(resolve, delayTime));
        }
      } catch (error) {
        logger.error(`❌ Error processing ${trackInfo.youtubeId}:`, error);
        // Continue with next track despite error
      }
    }
    
    logger.info('\n=== Finished YouTube Recommendations Refresh ===');
  } catch (error) {
    logger.error('Error in refreshYoutubeRecommendationsPool:', error);
  }
}

export async function getVideoInfo(videoId: string): Promise<VideoInfo | null> {
  try {
    if (!videoId) {
      logger.error('No video ID provided');
      return null;
    }

    // Check cache first
    const track = await getTrackWithChannel(videoId);

    if (track && track.title) {
      // Update last accessed time
      await prisma.track.update({
        where: { youtubeId: videoId },
        data: { updatedAt: new Date() }
      });

      // Get thumbnail URL
      const thumbnailUrl = getThumbnailUrl(videoId);

      return {
        videoId: track.youtubeId,
        title: track.title,
        duration: track.duration,
        thumbnail: thumbnailUrl
      };
    }

    // Check if cookies file exists first
    const cookiesPath = path.join(process.cwd(), 'youtube_cookies.txt');
    let cookiesExist = false;
    try {
      await fs.promises.access(cookiesPath, fs.constants.R_OK);
      cookiesExist = true;
      logger.info(`Using cookies to get video info for ${videoId}`);
    } catch (error) {
      logger.info(`No cookies file found for video info ${videoId}, will try without cookies`);
    }

    // Define ytdlpPath at the top level of the function
    const ytdlpPath = path.join(process.cwd(), 'node_modules/yt-dlp-exec/bin/yt-dlp');

    // Always try yt-dlp first, with or without cookies
    try {
      // Prepare command arguments
      const args = [
        `https://www.youtube.com/watch?v=${videoId}`,
        '--dump-json',
        '--no-download',
        '--no-warning',
        '--quiet'
      ];
      
      // Add cookies if available
      if (cookiesExist) {
        args.push('--cookies', cookiesPath);
      }
      
      // Get video metadata using yt-dlp
      const { stdout } = await execa(ytdlpPath, args);
      
      if (stdout) {
        const videoData = JSON.parse(stdout);
        const title = videoData.title || '';
        const duration = parseInt(videoData.duration) || 0;
        const thumbnail = videoData.thumbnail || await getBestThumbnail(videoId);
        const channelId = videoData.channel_id;
        const channelTitle = videoData.channel || videoData.uploader;
        
        // Store channel info if available
        if (channelId && channelTitle) {
          await upsertChannel({
            id: channelId,
            title: channelTitle
          });
        }
        
        // Save to database for future cache hits
        await upsertTrack({
          youtubeId: videoId,
          title,
          duration,
          channelId: channelId || undefined
        });
        
        // Download thumbnail if needed
        await downloadAndCacheThumbnail(videoId, thumbnail);
        
        return {
          videoId,
          title,
          duration,
          thumbnail: getThumbnailUrl(videoId)
        };
      }
    } catch (ytdlpError) {
      logger.info(`Failed to get info using yt-dlp for ${videoId}:`, ytdlpError);
      
      // If cookies exist but yt-dlp failed, try again with YouTube Music URL
      if (cookiesExist) {
        try {
          const { stdout } = await execa(ytdlpPath, [
            `https://music.youtube.com/watch?v=${videoId}`,
            '--cookies', cookiesPath,
            '--dump-json',
            '--no-download',
            '--no-warning',
            '--quiet'
          ]);
          
          if (stdout) {
            const videoData = JSON.parse(stdout);
            const title = videoData.title || '';
            const duration = parseInt(videoData.duration) || 0;
            const thumbnail = videoData.thumbnail || await getBestThumbnail(videoId);
            const channelId = videoData.channel_id;
            const channelTitle = videoData.channel || videoData.uploader;
            
            // Store channel info if available
            if (channelId && channelTitle) {
              await upsertChannel({
                id: channelId,
                title: channelTitle
              });
            }
            
            // Save to database for future cache hits
            await upsertTrack({
              youtubeId: videoId,
              title,
              duration,
              channelId: channelId || undefined,
              isMusicUrl: true
            });
            
            // Download thumbnail if needed
            await downloadAndCacheThumbnail(videoId, thumbnail);
            
            return {
              videoId,
              title,
              duration,
              thumbnail: getThumbnailUrl(videoId)
            };
          }
        } catch (musicError) {
          logger.info(`Failed to get info from YouTube Music for ${videoId}:`, musicError);
        }
      }
    }

    // Only fall back to YouTube API as last resort
    logger.info(`Falling back to YouTube API for ${videoId}`);
    const videoDetails = await executeYoutubeApi('videos.list', async (apiKey) => {
      return youtube.videos.list({
        key: apiKey,
        part: ['snippet', 'contentDetails'],
        id: [videoId]
      });
    });

    if (!videoDetails.data.items || videoDetails.data.items.length === 0) {
      logger.error(`No video details found for ID: ${videoId}`);
      return null;
    }

    const video = videoDetails.data.items[0];
    const title = video.snippet?.title || '';
    const duration = parseDuration(video.contentDetails?.duration || 'PT0S');
    const channelId = video.snippet?.channelId;
    const channelTitle = video.snippet?.channelTitle;
    const thumbnailUrl = await getBestThumbnail(videoId);

    // Store channel info if available
    if (channelId && channelTitle) {
      await upsertChannel({
        id: channelId,
        title: channelTitle
      });
    }

    // Save to database for future cache hits
    await upsertTrack({
      youtubeId: videoId,
      title,
      duration,
      channelId: channelId || undefined
    });

    return {
      videoId,
      title,
      duration,
      thumbnail: thumbnailUrl
    };
  } catch (error) {
    logger.error(`Error getting video info for ${videoId}:`, error);
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
    logger.info('Starting track validation...');
    
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
      logger.info('No tracks need validation');
      return 0;
    }
    
    logger.info(`Found ${tracks.length} tracks to validate`);
    let validatedCount = 0;
    
    // Check if cookies file exists
    const cookiesPath = path.join(process.cwd(), 'youtube_cookies.txt');
    let cookiesExist = false;
    try {
      await access(cookiesPath, fs.constants.R_OK);
      cookiesExist = true;
      logger.info('Using cookies for track validation');
    } catch (error) {
      logger.info('No cookies file found, validation may be limited');
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
        
        // Verify channel is not blocked (in case channel was blocked since last validation)
        const currentTrack = await getTrackWithChannel(track.youtubeId);

        const channelBlocked = await isChannelBlocked(
          currentTrack?.channel?.id,
          currentTrack?.channel?.title
        );

        if (channelBlocked) {
          logger.info(`✗ Track's channel is now blocked: ${track.title} (${track.youtubeId})`);
          throw new Error('Channel is blocked');
        }
        
        // Update the track's validation timestamp
        await prisma.track.update({
          where: { youtubeId: track.youtubeId },
          data: { 
            lastValidated: new Date(),
            isActive: true // Ensure it's marked as active
          }
        });
        
        logger.info(`✓ Validated track: ${track.title} (${track.youtubeId})`);
        validatedCount++;
      } catch (error) {
        logger.info(`✗ Track is no longer available: ${track.title} (${track.youtubeId})`);
        
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
    
    logger.info(`Validation complete. Validated ${validatedCount} tracks`);
    return validatedCount;
  } catch (error) {
    logger.error('Failed to validate tracks:', error);
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
    logger.info(`Starting cleanup of excess recommendations (keeping max ${maxRecommendationsPerSeed} per seed track)...`);
    
    // Get all seed tracks that have recommendations
    const seedTracks = await prisma.$queryRaw<Array<{ seedTrackId: string, count: number }>>`
      SELECT "seedTrackId", COUNT(*) as count
      FROM "YoutubeRecommendation"
      GROUP BY "seedTrackId"
      HAVING COUNT(*) > ${maxRecommendationsPerSeed}
      ORDER BY COUNT(*) DESC
    `;
    
    if (seedTracks.length === 0) {
      logger.info('No seed tracks have excess recommendations');
      return 0;
    }
    
    logger.info(`Found ${seedTracks.length} seed tracks with excess recommendations`);
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
        
        logger.info(`Removed ${result.count} excess recommendations for seed track ${seedTrack.seedTrackId}`);
        totalRemoved += result.count;
      } catch (error) {
        logger.error(`Error cleaning up recommendations for seed track ${seedTrack.seedTrackId}:`, error);
      }
    }
    
    logger.info(`Cleanup complete. Removed ${totalRemoved} excess recommendations`);
    return totalRemoved;
  } catch (error) {
    logger.error('Failed to clean up excess recommendations:', error);
    return 0;
  }
}

// Function to initialize the key manager at server startup
export async function initializeYouTubeAPI(): Promise<void> {
  logger.info('Initializing YouTube API...');
  const manager = getKeyManager();
  try {
    // Force validation of all keys at startup
    await manager.validateKeys();
  } catch (error) {
    logger.error('Error initializing YouTube API:', error);
  }
}
