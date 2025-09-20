import fs from 'fs';
import { promises as fsPromises } from 'fs';
import path from 'path';
import sharp from 'sharp';
import crypto from 'crypto';
import logger from './logger.js';

// Directories
const ROOT_DIR = process.cwd();
const CACHE_DIR = path.join(ROOT_DIR, 'cache', 'backgrounds');
const ORIGINAL_DIR = path.join(CACHE_DIR, 'original');
const BLURRED_DIR = path.join(CACHE_DIR, 'blurred');

// Ensure directories exist
async function ensureDirectories() {
  await fsPromises.mkdir(CACHE_DIR, { recursive: true });
  await fsPromises.mkdir(ORIGINAL_DIR, { recursive: true });
  await fsPromises.mkdir(BLURRED_DIR, { recursive: true });
}

export interface BackgroundProcessJob {
  url: string;
  blurAmount: number;
  quality: number;
  priority: 'high' | 'normal' | 'low';
}

export class BackgroundProcessor {
  private queue: BackgroundProcessJob[] = [];
  private isProcessing = false;
  private maxConcurrent = 3; // Process up to 3 images concurrently

  /**
   * Add a job to the processing queue
   */
  async addJob(job: BackgroundProcessJob): Promise<void> {
    const filename = this.generateFilename(job.url, job.blurAmount);
    const blurredPath = path.join(BLURRED_DIR, filename);

    // Check if already processed
    try {
      await fsPromises.access(blurredPath);
      logger.info(`Background already processed: ${filename}`);
      return;
    } catch {
      // File doesn't exist, need to process
    }

    // Add to queue with priority
    if (job.priority === 'high') {
      this.queue.unshift(job);
    } else {
      this.queue.push(job);
    }

    logger.info(`Added background processing job: ${job.url} (blur: ${job.blurAmount})`);

    // Start processing if not already running
    if (!this.isProcessing) {
      this.processQueue();
    }
  }

  /**
   * Process the queue
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    this.isProcessing = true;
    logger.info(`Starting background processing queue with ${this.queue.length} jobs`);

    try {
      while (this.queue.length > 0) {
        // Process up to maxConcurrent jobs
        const jobsToProcess = this.queue.splice(0, this.maxConcurrent);

        await Promise.all(
          jobsToProcess.map(job => this.processJob(job).catch(error => {
            logger.error(`Failed to process background job: ${job.url}`, error);
          }))
        );

        // Small delay between batches to avoid overwhelming the system
        if (this.queue.length > 0) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    } catch (error) {
      logger.error('Error in background processing queue:', error);
    } finally {
      this.isProcessing = false;
      logger.info('Background processing queue completed');
    }
  }

  /**
   * Process a single job
   */
  private async processJob(job: BackgroundProcessJob): Promise<void> {
    const filename = this.generateFilename(job.url, job.blurAmount);
    const blurredPath = path.join(BLURRED_DIR, filename);

    logger.info(`Processing background: ${job.url}`);

    try {
      // Download original image
      const originalPath = await this.downloadImage(job.url);

      // Apply blur effect
      await this.applyBlur(originalPath, blurredPath, job.blurAmount, job.quality);

      logger.info(`Successfully processed background: ${filename}`);
    } catch (error) {
      logger.error(`Failed to process background ${job.url}:`, error);
      throw error;
    }
  }

  /**
   * Download an image
   */
  private async downloadImage(url: string): Promise<string> {
    const filename = crypto.createHash('sha256').update(url).digest('hex').substring(0, 16) + '.jpg';
    const filePath = path.join(ORIGINAL_DIR, filename);

    // Check if already cached
    try {
      await fsPromises.access(filePath);
      return filePath;
    } catch {
      // File doesn't exist, download it
    }

    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to download image: ${response.statusText}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      await fsPromises.writeFile(filePath, buffer);
      return filePath;
    } catch (error) {
      logger.error(`Failed to download image ${url}:`, error);
      throw error;
    }
  }

  /**
   * Apply blur effect to an image
   */
  private async applyBlur(
    inputPath: string,
    outputPath: string,
    blurAmount: number,
    quality: number
  ): Promise<void> {
    try {
      await sharp(inputPath)
        .blur(blurAmount)
        .jpeg({ quality, progressive: true })
        .toFile(outputPath);
    } catch (error) {
      logger.error(`Failed to apply blur to ${inputPath}:`, error);
      throw error;
    }
  }

  /**
   * Generate filename for cached image
   */
  private generateFilename(url: string, blurAmount: number): string {
    const hash = crypto.createHash('sha256').update(url).digest('hex').substring(0, 16);
    return `${hash}_blur${blurAmount}.jpg`;
  }

  /**
   * Pre-process popular backgrounds
   */
  async preprocessPopularBackgrounds(): Promise<void> {
    await ensureDirectories();

    // List of popular background URLs (could be fetched from database)
    const popularBackgrounds = [
      '/images/DEFAULT.jpg',
      // Add more popular backgrounds as needed
    ];

    logger.info(`Pre-processing ${popularBackgrounds.length} popular backgrounds`);

    const jobs: BackgroundProcessJob[] = popularBackgrounds.map(url => ({
      url,
      blurAmount: 80,
      quality: 85,
      priority: 'normal' as const
    }));

    // Add all jobs to queue
    for (const job of jobs) {
      await this.addJob(job);
    }
  }

  /**
   * Clear old cache files
   */
  async clearCache(olderThanDays: number = 30): Promise<void> {
    try {
      const cutoffTime = Date.now() - (olderThanDays * 24 * 60 * 60 * 1000);

      const directories = [ORIGINAL_DIR, BLURRED_DIR];

      for (const dir of directories) {
        const files = await fsPromises.readdir(dir);

        for (const file of files) {
          const filePath = path.join(dir, file);
          const stats = await fsPromises.stat(filePath);

          if (stats.mtime.getTime() < cutoffTime) {
            await fsPromises.unlink(filePath);
            logger.info(`Deleted old cache file: ${file}`);
          }
        }
      }

      logger.info(`Cache cleanup completed (older than ${olderThanDays} days)`);
    } catch (error) {
      logger.error('Error during cache cleanup:', error);
    }
  }

  /**
   * Get queue status
   */
  getQueueStatus() {
    return {
      queueLength: this.queue.length,
      isProcessing: this.isProcessing,
      maxConcurrent: this.maxConcurrent
    };
  }
}

// Export singleton instance
export const backgroundProcessor = new BackgroundProcessor();