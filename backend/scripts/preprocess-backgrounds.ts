#!/usr/bin/env node

import { backgroundProcessor } from '../src/utils/backgroundProcessor.js';
import logger from '../src/utils/logger.js';
import { prisma } from '../src/db.js';

async function main() {
  try {
    logger.info('Starting background pre-processing...');

    // Initialize directories
    await backgroundProcessor.preprocessPopularBackgrounds();

    // Get popular tracks from database and pre-process their album art
    const popularTracks = await prisma.track.findMany({
      where: {
        requests: {
          some: {}
        }
      },
      include: {
        requests: true
      },
      orderBy: {
        requests: {
          _count: 'desc'
        }
      },
      take: 50 // Top 50 most requested tracks
    });

    logger.info(`Found ${popularTracks.length} popular tracks to pre-process`);

    for (const track of popularTracks) {
      const baseUrl = process.env.API_URL || 'http://localhost:3000';
      const albumArtUrl = `${baseUrl}/api/albumart/${track.youtubeId}`;

      await backgroundProcessor.addJob({
        url: albumArtUrl,
        blurAmount: 80,
        quality: 85,
        priority: 'high'
      });
    }

    logger.info('Background pre-processing queued successfully');

    // Wait for processing to complete (or timeout after 5 minutes)
    const startTime = Date.now();
    const timeout = 5 * 60 * 1000; // 5 minutes

    while (backgroundProcessor.getQueueStatus().queueLength > 0) {
      if (Date.now() - startTime > timeout) {
        logger.warn('Background processing timeout reached, some jobs may still be processing');
        break;
      }

      const status = backgroundProcessor.getQueueStatus();
      logger.info(`Queue status: ${status.queueLength} jobs remaining, processing: ${status.isProcessing}`);

      await new Promise(resolve => setTimeout(resolve, 5000));
    }

    logger.info('Background pre-processing completed');
    process.exit(0);
  } catch (error) {
    logger.error('Error in background pre-processing:', error);
    process.exit(1);
  }
}

main();