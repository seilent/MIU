import { exec } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import path from 'path';
import { getAudioCacheWithCheck, upsertAudioCache } from './cacheHelpers.js';
import { getYouTubeAPIManager } from './youtubeApiManager.js';
import logger from './logger.js';
import { getEnv } from './env.js';

/**
 * Centralized Audio Processing Manager
 * Handles audio download, conversion, normalization, and validation
 */

const execAsync = promisify(exec);

export interface AudioProcessingOptions {
  quality?: 'high' | 'medium' | 'low';
  normalize?: boolean;
  maxDuration?: number;
  minDuration?: number;
  forceRedownload?: boolean;
  skipIfExists?: boolean;
  priority?: 'high' | 'medium' | 'low';
}

export interface AudioProcessingResult {
  success: boolean;
  filePath?: string;
  duration?: number;
  fileSize?: number;
  error?: string;
}

export interface AudioValidationResult {
  isValid: boolean;
  duration?: number;
  bitrate?: number;
  format?: string;
  issues?: string[];
}

export class AudioProcessingManager {
  private static readonly CACHE_DIR = process.env.CACHE_DIR || '/tmp/miu/cache';
  private static readonly AUDIO_CACHE_DIR = path.join(AudioProcessingManager.CACHE_DIR, 'audio');
  private static readonly TEMP_DIR = path.join(AudioProcessingManager.CACHE_DIR, 'temp');
  
  private static readonly FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
  private static readonly FFPROBE_PATH = process.env.FFPROBE_PATH || 'ffprobe';
  private static readonly YT_DLP_PATH = process.env.YT_DLP_PATH || 'yt-dlp';
  
  private static readonly MAX_DURATION = 600; // 10 minutes
  private static readonly MIN_DURATION = 30;  // 30 seconds
  private static readonly TARGET_BITRATE = '128k';

  private activeDownloads = new Set<string>();
  private youtubeAPI = getYouTubeAPIManager();

  constructor() {
    this.ensureDirectories();
  }

  /**
   * Process audio for a YouTube video (download, convert, validate)
   */
  async processAudio(youtubeId: string, options: AudioProcessingOptions = {}): Promise<AudioProcessingResult> {
    try {
      logger.info(`Processing audio for: ${youtubeId}`);

      // Check if already processing
      if (this.activeDownloads.has(youtubeId)) {
        logger.info(`Audio processing already in progress for: ${youtubeId}`);
        return { success: false, error: 'Already processing' };
      }

      // Check cache first (unless force redownload)
      if (!options.forceRedownload) {
        const cached = await getAudioCacheWithCheck(youtubeId);
        if (cached) {
          logger.info(`Using cached audio for: ${youtubeId}`);
          
          // Get file stats to return duration and fileSize
          const fileStats = await fs.stat(cached.filePath).catch(() => null);
          const duration = await this.getAudioDuration(cached.filePath).catch(() => 0);
          
          return {
            success: true,
            filePath: cached.filePath,
            duration,
            fileSize: fileStats?.size || 0
          };
        }
      }

      this.activeDownloads.add(youtubeId);

      try {
        // Step 1: Get video info and validate
        const videoInfo = await this.youtubeAPI.getVideoInfo(youtubeId);
        if (!videoInfo) {
          return { success: false, error: 'Video not found or unavailable' };
        }

        // Step 2: Validate duration constraints
        const maxDuration = options.maxDuration || AudioProcessingManager.MAX_DURATION;
        const minDuration = options.minDuration || AudioProcessingManager.MIN_DURATION;
        
        if (videoInfo.duration && (videoInfo.duration > maxDuration || videoInfo.duration < minDuration)) {
          return { 
            success: false, 
            error: `Duration ${videoInfo.duration}s is outside allowed range (${minDuration}-${maxDuration}s)` 
          };
        }

        // Step 3: Download audio
        const downloadResult = await this.downloadAudio(youtubeId, options);
        if (!downloadResult.success) {
          return downloadResult;
        }

        // Step 4: Convert and normalize if needed
        const processedFile = await this.postProcessAudio(downloadResult.filePath!, options);
        if (!processedFile.success) {
          // Clean up downloaded file
          await this.cleanupFile(downloadResult.filePath!);
          return processedFile;
        }

        // Step 5: Validate final audio
        const validation = await this.validateAudio(processedFile.filePath!);
        if (!validation.isValid) {
          await this.cleanupFile(processedFile.filePath!);
          return { 
            success: false, 
            error: `Audio validation failed: ${validation.issues?.join(', ')}` 
          };
        }

        // Step 6: Cache the result
        const fileStats = await fs.stat(processedFile.filePath!);
        await upsertAudioCache(youtubeId, processedFile.filePath!);

        logger.info(`✓ Successfully processed audio for: ${youtubeId}`);
        return {
          success: true,
          filePath: processedFile.filePath!,
          duration: validation.duration,
          fileSize: fileStats.size
        };

      } finally {
        this.activeDownloads.delete(youtubeId);
      }

    } catch (error) {
      this.activeDownloads.delete(youtubeId);
      logger.error(`Error processing audio for ${youtubeId}:`, error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      };
    }
  }

  /**
   * Download raw audio from YouTube
   */
  private async downloadAudio(youtubeId: string, options: AudioProcessingOptions): Promise<AudioProcessingResult> {
    const tempFile = path.join(AudioProcessingManager.TEMP_DIR, `${youtubeId}_raw.%(ext)s`);
    
    try {
      logger.info(`Downloading audio for: ${youtubeId}`);

      // Determine quality settings
      const quality = options.quality || 'medium';
      let format = '';
      
      switch (quality) {
        case 'high':
          format = 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio';
          break;
        case 'low':
          format = 'worstaudio[ext=m4a]/worstaudio[ext=webm]/worstaudio';
          break;
        default: // medium
          format = 'bestaudio[height<=720][ext=m4a]/bestaudio[ext=webm]/bestaudio';
      }

      // Build yt-dlp command args array
      const ytDlpArgs = [
        '--extract-audio',
        '--audio-format', 'best',
        '--audio-quality', '0',
        '-f', format,
        '--no-playlist',
        '--no-warnings',
        '--prefer-ffmpeg',
        '--ffmpeg-location', AudioProcessingManager.FFMPEG_PATH,
        '-o', tempFile,
        `https://www.youtube.com/watch?v=${youtubeId}`
      ];

      const { stdout, stderr } = await execAsync(`${AudioProcessingManager.YT_DLP_PATH} ${ytDlpArgs.map(arg => `"${arg}"`).join(' ')}`, {
        timeout: 300000, // 5 minutes timeout
        maxBuffer: 1024 * 1024 * 10 // 10MB buffer
      });

      // Find the actual downloaded file - check for common audio formats
      const tempDir = AudioProcessingManager.TEMP_DIR;
      const files = await fs.readdir(tempDir);
      const downloadedFile = files.find(file => 
        file.startsWith(`${youtubeId}_raw.`) && 
        (file.endsWith('.m4a') || file.endsWith('.webm') || file.endsWith('.mp3') || 
         file.endsWith('.opus') || file.endsWith('.aac') || file.endsWith('.ogg'))
      );

      if (!downloadedFile) {
        logger.error(`Downloaded file not found for: ${youtubeId}`);
        logger.debug('Available files:', files.filter(f => f.startsWith(`${youtubeId}_raw.`)));
        logger.debug('yt-dlp stdout:', stdout);
        logger.debug('yt-dlp stderr:', stderr);
        return { success: false, error: 'Downloaded file not found' };
      }

      const downloadedPath = path.join(tempDir, downloadedFile);
      const stats = await fs.stat(downloadedPath);

      logger.info(`✓ Downloaded audio for ${youtubeId}: ${downloadedFile} (${Math.round(stats.size / 1024 / 1024)}MB)`);
      
      return {
        success: true,
        filePath: downloadedPath,
        fileSize: stats.size
      };

    } catch (error: any) {
      logger.error(`Download failed for ${youtubeId}:`, error);
      
      // Handle specific yt-dlp errors
      if (error.message?.includes('Video unavailable')) {
        return { success: false, error: 'Video is unavailable or private' };
      } else if (error.message?.includes('timeout')) {
        return { success: false, error: 'Download timeout' };
      }
      
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Download failed' 
      };
    }
  }

  /**
   * Post-process downloaded audio (convert, normalize)
   */
  private async postProcessAudio(inputPath: string, options: AudioProcessingOptions): Promise<AudioProcessingResult> {
    try {
      const youtubeId = path.basename(inputPath).split('_')[0];
      const outputPath = path.join(AudioProcessingManager.AUDIO_CACHE_DIR, `${youtubeId}.m4a`);

      logger.info(`Post-processing audio for: ${youtubeId}`);

      // Build FFmpeg command
      const ffmpegArgs = [
        '-i', inputPath,
        '-c:a', 'aac',
        '-b:a', AudioProcessingManager.TARGET_BITRATE,
        '-ar', '44100',
        '-ac', '2'
      ];

      // Add normalization if requested
      if (options.normalize) {
        ffmpegArgs.push(
          '-af', 'loudnorm=I=-16:TP=-1.5:LRA=7'
        );
      }

      ffmpegArgs.push('-y', outputPath);

      const ffmpegCommand = [AudioProcessingManager.FFMPEG_PATH, ...ffmpegArgs].join(' ');

      await execAsync(ffmpegCommand, {
        timeout: 120000, // 2 minutes timeout
        maxBuffer: 1024 * 1024 * 5 // 5MB buffer
      });

      // Verify output file exists and has reasonable size
      const stats = await fs.stat(outputPath);
      if (stats.size < 1024 * 100) { // Less than 100KB is suspicious
        throw new Error('Output file too small, likely corrupted');
      }

      // Clean up input file
      await this.cleanupFile(inputPath);

      logger.info(`✓ Post-processed audio for ${youtubeId}: ${Math.round(stats.size / 1024 / 1024)}MB`);

      return {
        success: true,
        filePath: outputPath,
        fileSize: stats.size
      };

    } catch (error) {
      logger.error(`Post-processing failed:`, error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Post-processing failed' 
      };
    }
  }

  /**
   * Validate audio file integrity and properties
   */
  async validateAudio(filePath: string): Promise<AudioValidationResult> {
    try {
      const ffprobeCommand = [
        AudioProcessingManager.FFPROBE_PATH,
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        filePath
      ].join(' ');

      const { stdout } = await execAsync(ffprobeCommand);
      const probe = JSON.parse(stdout);

      const audioStream = probe.streams?.find((stream: any) => stream.codec_type === 'audio');
      if (!audioStream) {
        return { isValid: false, issues: ['No audio stream found'] };
      }

      const duration = parseFloat(probe.format?.duration || '0');
      const bitrate = parseInt(audioStream.bit_rate || '0');
      const format = audioStream.codec_name;

      const issues: string[] = [];

      // Check duration
      if (duration < AudioProcessingManager.MIN_DURATION) {
        issues.push(`Duration too short: ${duration}s`);
      }
      if (duration > AudioProcessingManager.MAX_DURATION) {
        issues.push(`Duration too long: ${duration}s`);
      }

      // Check bitrate (should be reasonable)
      if (bitrate > 0 && bitrate < 64000) {
        issues.push(`Bitrate too low: ${bitrate}`);
      }

      // Check format
      if (!['aac', 'mp3', 'opus'].includes(format)) {
        issues.push(`Unsupported format: ${format}`);
      }

      return {
        isValid: issues.length === 0,
        duration,
        bitrate,
        format,
        issues: issues.length > 0 ? issues : undefined
      };

    } catch (error) {
      logger.error(`Audio validation failed:`, error);
      return { 
        isValid: false, 
        issues: [`Validation error: ${error instanceof Error ? error.message : 'Unknown error'}`] 
      };
    }
  }

  /**
   * Get audio file duration using ffprobe
   */
  async getAudioDuration(filePath: string): Promise<number> {
    try {
      const ffprobeCommand = [
        AudioProcessingManager.FFPROBE_PATH,
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        filePath
      ].join(' ');

      const { stdout } = await execAsync(ffprobeCommand);
      const probe = JSON.parse(stdout);
      
      return parseFloat(probe.format?.duration || '0');
    } catch (error) {
      logger.error(`Error getting audio duration:`, error);
      return 0;
    }
  }

  /**
   * Measure mean volume of audio file
   */
  async measureMeanVolume(filePath: string): Promise<number> {
    try {
      const ffmpegCommand = [
        AudioProcessingManager.FFMPEG_PATH,
        '-i', filePath,
        '-af', 'volumedetect',
        '-f', 'null',
        '-'
      ].join(' ');

      const { stderr } = await execAsync(ffmpegCommand);
      
      const meanVolumeMatch = stderr.match(/mean_volume: (-?\d+\.?\d*) dB/);
      return meanVolumeMatch ? parseFloat(meanVolumeMatch[1]) : -20;
    } catch (error) {
      logger.error(`Error measuring volume:`, error);
      return -20; // Default reasonable value
    }
  }

  /**
   * Clean up temporary files
   */
  private async cleanupFile(filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath);
      logger.debug(`Cleaned up file: ${filePath}`);
    } catch (error) {
      logger.warn(`Failed to cleanup file ${filePath}:`, error);
    }
  }

  /**
   * Ensure cache directories exist
   */
  private async ensureDirectories(): Promise<void> {
    try {
      await fs.mkdir(AudioProcessingManager.CACHE_DIR, { recursive: true });
      await fs.mkdir(AudioProcessingManager.AUDIO_CACHE_DIR, { recursive: true });
      await fs.mkdir(AudioProcessingManager.TEMP_DIR, { recursive: true });
    } catch (error) {
      logger.error('Failed to create cache directories:', error);
    }
  }

  /**
   * Get processing statistics
   */
  getStats(): { activeDownloads: number; queuedDownloads: string[] } {
    return {
      activeDownloads: this.activeDownloads.size,
      queuedDownloads: Array.from(this.activeDownloads)
    };
  }

  /**
   * Batch process multiple audio files
   */
  async batchProcessAudio(youtubeIds: string[], options: AudioProcessingOptions = {}): Promise<AudioProcessingResult[]> {
    const results: AudioProcessingResult[] = [];
    const batchSize = 3; // Process 3 at a time to avoid overwhelming the system

    for (let i = 0; i < youtubeIds.length; i += batchSize) {
      const batch = youtubeIds.slice(i, i + batchSize);
      const batchPromises = batch.map(id => this.processAudio(id, options));
      
      const batchResults = await Promise.allSettled(batchPromises);
      
      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          results.push(result.value);
        } else {
          results.push({ 
            success: false, 
            error: result.reason instanceof Error ? result.reason.message : 'Unknown error' 
          });
        }
      }
    }

    logger.info(`Batch processed ${results.length} audio files: ${results.filter(r => r.success).length} successful`);
    return results;
  }

  /**
   * Clean up old cached audio files
   */
  async cleanupOldCache(maxAge: number = 7 * 24 * 60 * 60 * 1000): Promise<number> {
    try {
      const files = await fs.readdir(AudioProcessingManager.AUDIO_CACHE_DIR);
      let cleanedCount = 0;
      const cutoffTime = Date.now() - maxAge;

      for (const file of files) {
        const filePath = path.join(AudioProcessingManager.AUDIO_CACHE_DIR, file);
        const stats = await fs.stat(filePath);
        
        if (stats.mtime.getTime() < cutoffTime) {
          await fs.unlink(filePath);
          cleanedCount++;
        }
      }

      if (cleanedCount > 0) {
        logger.info(`Cleaned up ${cleanedCount} old cached audio files`);
      }

      return cleanedCount;
    } catch (error) {
      logger.error('Error cleaning up old cache:', error);
      return 0;
    }
  }

  /**
   * Prefetch audio track for a YouTube ID
   */
  async prefetchTrack(youtubeId: string): Promise<boolean> {
    try {
      const result = await this.processAudio(youtubeId, { 
        skipIfExists: true,
        priority: 'low'
      });
      return result.success;
    } catch (error) {
      logger.error(`Error prefetching track ${youtubeId}:`, error);
      return false;
    }
  }
}

/**
 * Singleton instance
 */
let audioProcessingManagerInstance: AudioProcessingManager | null = null;

export function getAudioProcessingManager(): AudioProcessingManager {
  if (!audioProcessingManagerInstance) {
    audioProcessingManagerInstance = new AudioProcessingManager();
  }
  return audioProcessingManagerInstance;
}