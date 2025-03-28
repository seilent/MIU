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
import { filterBlockedContent, isLikelyJapaneseSong, BLOCKED_KEYWORDS } from './contentFilter.js';

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
    const filteredItems = await filterBlockedContent(response.data.items);

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
            channelId = video.snippet.channelId ?? null;
            channelTitle = video.snippet.channelTitle ?? undefined;

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
        channelId: channelId ?? undefined,
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
          channelId: channelId ?? undefined,
          channelTitle: channelTitle ?? undefined
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

// Function to handle yt-dlp errors and update if needed
async function handleYtDlpError(error: any): Promise<boolean> {
  const errorStr = error?.stderr || error?.message || '';
  
  if (errorStr.includes('Requested format is not available')) {
    console.log('Detected format error, attempting to update yt-dlp...');
    
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
        console.log(`[yt-dlp-update] ${data.toString().trim()}`);
      });
      
      process.stderr.on('data', (data) => {
        stderr += data.toString();
        console.error(`[yt-dlp-update] ${data.toString().trim()}`);
      });
      
      process.on('close', (code) => {
        if (code === 0) {
          console.log('yt-dlp update completed successfully');
          resolve(true);
        } else {
          console.error(`yt-dlp update failed with code ${code}`);
          console.error('Error output:', stderr);
          resolve(false);
        }
      });
    });
  }
  
  return false;
}

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

        // Base download options (common for all attempts)
        const baseOptions: any = {
          output: uniqueTempPath,
          extractAudio: true,
          audioFormat: 'wav', // Download as WAV first to ensure consistent processing
          noCheckCertificate: true,
          noWarnings: true,
          quiet: true,
          ffmpegLocation: ffmpeg || undefined,
          formatSort: 'proto:m3u8,abr',
          noPlaylist: true
        };

        // Add cookies if available
        if (cookiesExist) {
          baseOptions.cookies = cookiesPath;
        }

        // Attempt strategies in order:
        // 1. First try with bestaudio format
        // 2. If that fails, try with best format (which includes videos with audio)
        // 3. If that fails, try with specific format ID 18 which commonly has audio
        
        let downloadSuccessful = false;
        let actualFilePath = '';
        
        // Strategy 1: bestaudio format
        try {
          const audioOptions = { ...baseOptions, format: 'bestaudio' };
          console.log(`[${youtubeId}] Trying bestaudio format`);
          await ytDlp(youtubeUrl, audioOptions);
          downloadSuccessful = true;
        } catch (firstAttemptError: any) {
          console.log(`⚠️ [${youtubeId}] bestaudio format failed: ${firstAttemptError.message || 'Unknown error'}`);
            
          // Strategy 2: best format (can include videos with audio)
          try {
            const bestOptions = { ...baseOptions, format: 'best' };
            console.log(`[${youtubeId}] Trying best format`);
            await ytDlp(youtubeUrl, bestOptions);
            downloadSuccessful = true;
          } catch (secondAttemptError: any) {
            console.log(`⚠️ [${youtubeId}] best format failed: ${secondAttemptError.message || 'Unknown error'}`);
              
            // Strategy 3: specifically try format 18 (common mp4 with audio)
            try {
              const specificOptions = { ...baseOptions, format: '18' };
              console.log(`[${youtubeId}] Trying format 18`);
              await ytDlp(youtubeUrl, specificOptions);
              downloadSuccessful = true;
            } catch (thirdAttemptError: any) {
              console.log(`⚠️ [${youtubeId}] format 18 failed: ${thirdAttemptError.message || 'Unknown error'}`);
              throw new Error(`All download format strategies failed: ${thirdAttemptError.message || 'Unknown error'}`);
            }
          }
        }

        if (!downloadSuccessful) {
          throw new Error('All download strategies failed');
        }

        // Check for extracted audio file
        // Since extractAudio is set and audioFormat is wav, we need to check for .wav extension
        // Also check alternate extensions in case of format conversion by yt-dlp
        const possibleExtensions = ['.wav', '.m4a', '.mp3', '.aac', '.opus'];
        let fileFound = false;
        
        for (const ext of possibleExtensions) {
          try {
            const possiblePath = `${uniqueTempPath}${ext}`;
            await fs.promises.access(possiblePath, fs.constants.R_OK);
            actualFilePath = possiblePath;
            fileFound = true;
            console.log(`✓ [${youtubeId}] Found extracted audio file: ${possiblePath}`);
            break;
          } catch (e) {
            // File not found with this extension, try next
          }
        }
        
        // If no file with extensions was found, try the original file
        if (!fileFound) {
          try {
            await fs.promises.access(uniqueTempPath, fs.constants.R_OK);
            actualFilePath = uniqueTempPath;
            fileFound = true;
            console.log(`✓ [${youtubeId}] Found original file: ${uniqueTempPath}`);
          } catch (e) {
            throw new Error(`Downloaded file not found at ${uniqueTempPath} or with expected extensions`);
          }
        }

        // Verify the downloaded file exists and is not empty
        const stats = await fs.promises.stat(actualFilePath);
        if (stats.size === 0) {
          throw new Error('Downloaded file is empty');
        }

        // Apply our custom normalization logic
        console.log(`🎵 [${youtubeId}] Applying volume normalization`);
        try {
          await convertToAAC(actualFilePath, finalPath);
          console.log(`✅ [${youtubeId}] Download and normalization complete`);
        return finalPath;
        } catch (error) {
          console.error('Audio conversion failed:', error);
          throw error; // Re-throw to trigger retry logic
        } finally {
          // Clean up temp file only after normalization is complete or failed
          try {
            await fs.promises.unlink(actualFilePath);
          } catch (e) {
            // Ignore cleanup errors
          }
        }
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
        
        if (retries > 0) {
          // Try to update yt-dlp if format error is detected
          const updated = await handleYtDlpError(error);
          
          if (updated) {
            console.log(`✓ [${youtubeId}] yt-dlp was updated, retrying download...`);
            retries--; // Still decrement retries counter
            continue;  // Skip the backoff delay and retry immediately
          }
          
        retries--;

        // Clean up failed attempt
        try {
          await fs.promises.unlink(uniqueTempPath);
        } catch (e) {
          // Ignore cleanup errors
        }

          // Clean up possible audio files that might have been created
          const possibleExtensions = ['.wav', '.m4a', '.mp3', '.aac', '.opus'];
          for (const ext of possibleExtensions) {
            try {
              await fs.promises.unlink(`${uniqueTempPath}${ext}`);
            } catch (e) {
              // Ignore cleanup errors
            }
          }
          
          // Exponential backoff
          await new Promise(resolve => setTimeout(resolve, backoffDelay));
          backoffDelay *= 2; // Double the delay for next retry
        } else {
          retries--;
        }
      }
    }

    console.log(`❌ [${youtubeId}] Download failed after 3 attempts`);
    throw lastError || new Error('Download failed after retries');
  } finally {
    // Clean up temp files and remove from active downloads
    activeDownloads.delete(youtubeId);
  }
}

async function measureMeanVolume(inputPath: string): Promise<{ mean: number; max: number }> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
            '-hide_banner',
            '-i', inputPath,
            '-af', 'volumedetect',
            '-f', 'null',
      '-'
    ]);

    let stderr = '';
    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffmpeg.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`FFmpeg process exited with code ${code}`));
        return;
      }

      const meanMatch = stderr.match(/mean_volume:\s*(-?\d+(\.\d+)?)/);
      const maxMatch = stderr.match(/max_volume:\s*(-?\d+(\.\d+)?)/);

      if (!meanMatch || !maxMatch) {
        reject(new Error('Could not parse volume info'));
        return;
      }

      resolve({
        mean: parseFloat(meanMatch[1]),
        max: parseFloat(maxMatch[1])
      });
    });

    ffmpeg.on('error', (err) => {
      reject(new Error(`FFmpeg process error: ${err.message}`));
          });
        });
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
        console.error('FFmpeg stderr output:', stderr);
        reject(new Error(`FFmpeg process exited with code ${code}`));
        return;
      }
      resolve();
    });

    ffmpeg.on('error', (err) => {
      console.error('FFmpeg stderr output:', stderr);
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

    console.log(`Input file metrics: mean=${inputMean.toFixed(2)}dB, max=${inputMax.toFixed(2)}dB`);

    // Extract YouTube ID from input path for parallel-safe naming
    const youtubeId = inputPath.split('/').pop()?.split('.')[0] || 'unknown';

    // If input is already in our target range (-14 to -13 dB), we can potentially skip normalization
    if (inputMean >= -14 && inputMean <= -13) {
      console.log('Mean volume already in target range');
      // Check if we need limiting
      if (inputMax <= -1) {
        console.log('Max volume is already good, direct encoding to AAC');
        await normalizeAudio(inputPath, outputPath, 0, 'aac', false);
      } else {
        console.log('Max volume too high, applying limiter during encoding');
        await normalizeAudio(inputPath, outputPath, 0, 'aac', true);
      }
      const finalMetrics = await measureMeanVolume(outputPath);
      console.log('\nFinal result:');
      console.log(`Mean: ${finalMetrics.mean.toFixed(2)}dB (target: -14 to -13 dB)`);
      console.log(`Max: ${finalMetrics.max.toFixed(2)}dB (target: below -1 dB)`);
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
      console.log(`\nAttempt ${attempt}: volume=${volumeAdjustment.toFixed(2)}dB`);
      
      // Use parallel-safe attempt filename for WAV
      const attemptPath = `${outputPath.replace('.m4a', '')}.${youtubeId}.attempt${attempt}.wav`;
      
      // Process without limiting, output as WAV
      await normalizeAudio(inputPath, attemptPath, volumeAdjustment, 'wav', false);
      
      // Check result
      const result = await measureMeanVolume(attemptPath);
      console.log(`Result: mean=${result.mean.toFixed(2)}dB, max=${result.max.toFixed(2)}dB`);
      
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
          console.log('Achieved target mean range!');
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
    console.log('\nFinal encoding phase:');
    const needsLimiting = bestResult.max > -1;
    if (needsLimiting) {
      console.log('Applying limiter during final encoding');
    } else {
      console.log('No limiting needed for final encoding');
    }

    // Encode the best normalized WAV to AAC
    await normalizeAudio(normalizedWavPath, outputPath, 0, 'aac', needsLimiting);

    // Clean up the intermediate WAV file
    await fs.promises.unlink(normalizedWavPath).catch(() => {});

    // Verify final result
    const finalMetrics = await measureMeanVolume(outputPath);
    console.log('\nFinal result:');
    console.log(`Mean: ${finalMetrics.mean.toFixed(2)}dB (target: -14 to -13 dB)`);
    console.log(`Max: ${finalMetrics.max.toFixed(2)}dB (target: below -1 dB)`);
    console.log(`Initial volume adjustment: ${bestResult.volumeAdjustment.toFixed(2)}dB`);
    console.log(`Limiting applied: ${needsLimiting}`);
    } catch (error) {
    console.error('Error in convertToAAC:', error);
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
export async function getYoutubeRecommendations(seedTrackId: string): Promise<Array<{ youtubeId: string; title?: string }>> {
  try {
    // Define this variable at the top level so it's available in all error handlers
    let seedRecIds: Set<string> = new Set();
    
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
    
    // Check if the seed track has a valid duration
    if (!isValidDuration(seedTrack.duration)) {
      console.log(`Seed track ${seedTrackId} has invalid duration (${seedTrack.duration}s), skipping recommendations`);
      return [];
    }

    // Check if we already have recommendations for this seed track
    try {
      const existingSeedRecs = await prisma.youtubeRecommendation.findMany({
        where: { seedTrackId },
        select: { youtubeId: true }
      });
      seedRecIds = new Set(existingSeedRecs.map(rec => rec.youtubeId));
      
      if (seedRecIds.size >= 5) {
        console.log(`Already have ${seedRecIds.size} recommendations for seed ${seedTrackId}, returning those`);
        return Array.from(seedRecIds).map(id => ({ youtubeId: id }));
      }
    } catch (dbError) {
      console.error(`Error checking existing recommendations for ${seedTrackId}:`, dbError);
      // Continue with fetching recommendations
    }

    // First check if cookies file exists for YouTube Music recommendations
    const cookiesPath = path.join(process.cwd(), 'youtube_cookies.txt');
    let cookiesExist = false;
    try {
      await access(cookiesPath, fs.constants.R_OK);
      cookiesExist = true;
      console.log(`▶ Fetching recommendations for ${seedTrackId}`);
    } catch (error) {
      console.log('No cookies file found, YouTube Music recommendations may not work');
      return Array.from(seedRecIds).map(id => ({ youtubeId: id }));
    }
    
    // Get recommendations from YouTube Music
      try {
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
          console.log('No output from yt-dlp command');
        return Array.from(seedRecIds).map(id => ({ youtubeId: id }));
        }
        
        const items = stdout.split('\n')
          .filter(line => line.trim())
          .map(line => JSON.parse(line));
        
        // Filter out the seed track and blocked tracks/channels
        const filteredItems: any[] = [];
        for (const item of items) {
          if (item.id === seedTrackId) continue;

          // Check if the title contains any blocked keywords
          const title = (item.title || '').toLowerCase();
          if (BLOCKED_KEYWORDS.some(keyword => title.includes(keyword.toLowerCase()))) {
            continue;
          }

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
            [],  // No tags available from yt-dlp output
            []   // No additional fields
          );
        });
        
        if (japaneseTracks.length > 0) {
        // Get all YoutubeRecommendation IDs in a single efficient query
        const existingRecs = await prisma.$queryRaw<Array<{ youtubeId: string }>>`
          SELECT DISTINCT "youtubeId" FROM "YoutubeRecommendation"
        `;
        
        // Create set for fast lookup
        const allExistingRecIds = new Set(existingRecs.map(rec => rec.youtubeId));
        
        // Filter out tracks that are already in the database ANYWHERE
        const newJapaneseTracks = japaneseTracks.filter(track => !allExistingRecIds.has(track.id));
        
        // If we have new recommendations, limit to 5
        // If not, we'll use existing recommendations if there are enough
        if (newJapaneseTracks.length > 0) {
          // Calculate how many recommendations we still need to reach MIN_RECOMMENDATIONS (5)
          const requiredNewRecs = Math.min(5 - seedRecIds.size, newJapaneseTracks.length);
          
          // Limit to just the number of recommendations needed
          const limitedTracks = newJapaneseTracks.slice(0, requiredNewRecs);
          
          // Map to the required format
          const recommendations = limitedTracks.map(track => ({ 
            youtubeId: track.id,
            title: track.title
          }));
    
    // Store recommendations in the database
    for (const rec of recommendations) {
      try {
              // We already filtered out existing recommendations earlier, so we can directly create
              console.log(`  • ${rec.youtubeId} (${rec.title || 'Unknown'})`);
          await prisma.youtubeRecommendation.create({
            data: {
              seedTrackId,
              youtubeId: rec.youtubeId,
                    wasPlayed: false,
                    title: rec.title || 'Unknown'
            }
          });
              
              // Also add to our local set of seed recommendations
              seedRecIds.add(rec.youtubeId);
      } catch (dbError) {
              console.error(`Failed to store recommendation ${rec.youtubeId}:`, dbError);
        // Continue with next recommendation despite error
        continue;
      }
    }
    
          // Verify recommendations were stored
          const storedCount = await prisma.youtubeRecommendation.count({
      where: {
              seedTrackId: seedTrackId
            }
          });
          console.log(`✓ Complete: Stored ${storedCount} recommendations for ${seedTrackId}`);
          
          return recommendations;
        } else if (seedRecIds.size >= 5) {
          // If we have no new recommendations but enough existing ones, use those
          console.log(`Using ${seedRecIds.size} existing recommendations for ${seedTrackId}`);
          return Array.from(seedRecIds).map(id => ({ youtubeId: id }));
        } else {
          // Not enough recommendations found
          console.log(`Not enough recommendations found for ${seedTrackId}`);
          return Array.from(seedRecIds).map(id => ({ youtubeId: id }));
        }
      }
      
      console.log('No Japanese tracks found in YouTube Music recommendations');
      return Array.from(seedRecIds).map(id => ({ youtubeId: id }));
    } catch (ytdlpError) {
      console.error('Failed to get recommendations using yt-dlp:', ytdlpError);
      return Array.from(seedRecIds).map(id => ({ youtubeId: id }));
          }
        } catch (error) {
    console.error(`Error getting recommendations for ${seedTrackId}:`, error);
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
 * Refresh the YouTube recommendations pool in the database
 * This is a background job that runs periodically to ensure we have recommendations
 * and validates existing tracks
 */
export async function refreshYoutubeRecommendationsPool(): Promise<void> {
  try {
    console.log('=== Starting YouTube Recommendations Refresh ===');
    
    // First validate some tracks to ensure our database is clean
    console.log('Validating tracks...');
    const validatedCount = await validateTracksAvailability(20); // Limit to 20 tracks per run
    console.log(`✓ Validated ${validatedCount} tracks`);
    
    // Get seed tracks that have fewer than MIN_RECOMMENDATIONS recommendations
    const MIN_RECOMMENDATIONS = 5;
    
    console.log('Finding tracks needing recommendations...');
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
      console.log('✓ No tracks need recommendations at this time');
      return;
    }
    
    console.log(`Found ${tracksNeedingRecommendations.length} tracks needing recommendations:`);
    
    // Process each track with a delay between requests to avoid rate limiting
    for (const trackInfo of tracksNeedingRecommendations) {
      try {
        console.log(`\n▶ Processing: ${trackInfo.youtubeId} (${trackInfo.title}) - ${trackInfo.recommendationCount}/${MIN_RECOMMENDATIONS}`);
        
        const recommendations = await getYoutubeRecommendations(trackInfo.youtubeId);
        
        // Verify the recommendations were actually stored by querying the database again
        const updatedCount = await prisma.youtubeRecommendation.count({
          where: {
            seedTrackId: trackInfo.youtubeId
          }
        });
        
        if (updatedCount > trackInfo.recommendationCount) {
          console.log(`✓ Added ${Number(updatedCount) - Number(trackInfo.recommendationCount)} recommendations, now at ${updatedCount}/${MIN_RECOMMENDATIONS}`);
        } else {
          console.log(`⚠ No new recommendations added, still at ${updatedCount}/${MIN_RECOMMENDATIONS}`);
        }
        
        // Introduce delay between API calls to reduce quota usage
        if (trackInfo !== tracksNeedingRecommendations[tracksNeedingRecommendations.length - 1]) {
          const delayTime = 2000 + Math.random() * 3000; // 2-5 second random delay
          const delaySeconds = Math.round(delayTime/1000);
          console.log(`Waiting ${delaySeconds}s before next request...`);
          await new Promise(resolve => setTimeout(resolve, delayTime));
        }
      } catch (error) {
        console.error(`❌ Error processing ${trackInfo.youtubeId}:`, error);
        // Continue with next track despite error
      }
    }
    
    console.log('\n=== Finished YouTube Recommendations Refresh ===');
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
    const track = await prisma.track.findUnique({
      where: { youtubeId: videoId },
      include: {
        channel: true
      }
    });

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

    // Try to use yt-dlp with cookies first to avoid API usage
    try {
      // Check if cookies file exists
      const cookiesPath = path.join(process.cwd(), 'youtube_cookies.txt');
      let cookiesExist = false;
      try {
        await fs.promises.access(cookiesPath, fs.constants.R_OK);
        cookiesExist = true;
        console.log(`Using cookies to get video info for ${videoId}`);
      } catch (error) {
        console.log(`No cookies file found for video info ${videoId}, may fall back to API`);
      }

      if (cookiesExist) {
        const ytdlpPath = path.join(process.cwd(), 'node_modules/yt-dlp-exec/bin/yt-dlp');
        
        // Get video metadata using yt-dlp
        const { stdout } = await execa(ytdlpPath, [
          `https://www.youtube.com/watch?v=${videoId}`,
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
          
          // Save to database for future cache hits
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
          
          // Download thumbnail if needed
          await downloadAndCacheThumbnail(videoId, thumbnail);
          
          return {
            videoId,
            title,
            duration,
            thumbnail: getThumbnailUrl(videoId)
          };
        }
      }
    } catch (ytdlpError) {
      console.log(`Failed to get info using yt-dlp for ${videoId}, falling back to API:`, ytdlpError);
    }

    // Fall back to YouTube API if yt-dlp method failed
    console.log(`Using YouTube API to get video details for ${videoId}`);
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
    const channelId = video.snippet?.channelId;
    const channelTitle = video.snippet?.channelTitle;
    const thumbnailUrl = await getBestThumbnail(videoId);

    // Store channel info if available
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

    // Save to database for future cache hits
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