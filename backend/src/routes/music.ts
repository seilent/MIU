import express, { Router, Request, Response } from 'express';
import { PrismaClient, User, Prisma, RequestStatus, Track } from '@prisma/client';
import { prisma } from '../prisma.js';
import { getDiscordClient } from '../discord/client.js';
import { searchLimiter, stateLimiter, queueLimiter, positionLimiter } from '../middleware/rateLimit.js';
import fs from 'fs';
import rateLimit from 'express-rate-limit';
import { getYoutubeId, getYoutubeInfo, searchYoutube, parseDuration, downloadYoutubeAudio } from '../utils/youtube.js';
import { MAX_DURATION } from '../config.js';
import { 
  songsPlayedCounter, 
  audioStreamRequestsCounter, 
  audioStreamBytesCounter, 
  audioStreamLatencyHistogram 
} from '../metrics.js';
import WebSocket from 'ws';
import jwt from 'jsonwebtoken';
import { createReadStream } from 'fs';
import { PassThrough } from 'stream';
import { spawn } from 'child_process';
import ffmpeg from 'ffmpeg-static';
import path from 'path';

interface WebUser {
  id: string;
  username: string;
  discriminator: string;
  avatar: string | null;
}

interface RequestWithTrack extends Prisma.RequestGetPayload<{
  include: { track: true; user: true };
}> {}

interface TrackResponse {
  youtubeId: string;
  title: string;
  thumbnail: string;
  duration: number;
  requestedBy: {
    id: string;
    username: string;
    avatar?: string;
  };
  requestedAt: string;
  isAutoplay: boolean;
}

const router = Router();

// Apply rate limiters
router.use('/search', searchLimiter);
router.use('/state', stateLimiter);
router.use(['/queue', '/history'], queueLimiter);

// Rate limiters
const musicStateLimiter = rateLimit({
  windowMs: 1000, // 1 second
  max: 50, // 50 requests per second
  standardHeaders: true,
  legacyHeaders: false,
  // Ensure no CORS headers are added
  handler: (req, res) => {
    res.status(429).json({ error: 'Too many requests' });
  }
});

router.use('/state', musicStateLimiter);

router.get('/search', searchLimiter, async (req: Request, res: Response) => {
  try {
    const query = req.query.q as string;
    if (!query) {
      return res.status(400).json({ error: 'Search query is required' });
    }

    // Use regular YouTube search instead of YouTube Music
    const results = await searchYoutube(query);
    
    // Results are already in the correct format, no need to transform
    res.json(results);
  } catch (error) {
    console.error('Search failed:', error);
    res.status(500).json({ error: 'Failed to search' });
  }
});

/**
 * @swagger
 * /api/music/queue:
 *   get:
 *     summary: Get current queue
 *     tags: [Music]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Current queue information
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 current:
 *                   $ref: '#/components/schemas/Track'
 *                 queue:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Track'
 *       401:
 *         description: Unauthorized
 */
router.get('/queue', (req, res) => {
  // Implementation will be added later
  res.status(501).json({ message: 'Not implemented' });
});

/**
 * @swagger
 * /api/music/queue:
 *   post:
 *     summary: Add track to queue
 *     tags: [Music]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               url:
 *                 type: string
 *                 description: URL of the track to add
 *     responses:
 *       200:
 *         description: Track added to queue
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Track'
 *       401:
 *         description: Unauthorized
 *       400:
 *         description: Invalid request
 */
router.post('/queue', async (req: Request, res: Response) => {
  try {
    const { url } = req.body;
    const userId = req.user?.id;

    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const client = getDiscordClient();
    if (!client) {
      return res.status(500).json({ error: 'Discord client not available' });
    }

    // Get full user info from database
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    // Extract YouTube ID
    const youtubeId = await getYoutubeId(url);
    if (!youtubeId) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    // Check if the song is already in queue or recently played
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
    const recentRequest = await prisma.request.findFirst({
      where: {
        youtubeId,
        requestedAt: {
          gte: oneHourAgo
        },
        status: {
          in: ['PLAYING', 'QUEUED', 'COMPLETED']
        }
      },
      orderBy: {
        requestedAt: 'desc'
      }
    });

    if (recentRequest) {
      const timeLeft = Math.ceil((recentRequest.requestedAt.getTime() + 60 * 60 * 1000 - Date.now()) / (60 * 1000));
      return res.status(400).json({ 
        error: `This song was recently played or is in queue. Please wait ${timeLeft} minutes before requesting it again.` 
      });
    }

    // Get track info to check duration
    const trackInfo = await getYoutubeInfo(youtubeId);
    if (trackInfo.duration > MAX_DURATION) {
      return res.status(400).json({ 
        error: `Track duration exceeds limit of ${Math.floor(MAX_DURATION / 60)} minutes` 
      });
    }

    // Add to queue
    const track = await client.player.play(
      null, // No voice state for web requests
      youtubeId,
      user.id,
      {
        username: user.username,
        discriminator: user.discriminator || '0000',
        avatar: user.avatar
      }
    );

    res.json(track);
  } catch (error) {
    console.error('Error adding to queue:', error);
    res.status(500).json({ error: 'Failed to add track to queue' });
  }
});

router.get('/state', async (req: Request, res: Response) => {
  try {
    const client = getDiscordClient();
    if (!client) {
      return res.status(500).json({ error: 'Discord client not available' });
    }

    // Get current playing track
    const currentTrack = await prisma.request.findFirst({
      where: {
        status: RequestStatus.PLAYING
      },
      include: {
        track: true,
        user: true
      }
    });

    // Get queued tracks
    const queuedTracks = await prisma.request.findMany({
      where: {
        status: RequestStatus.QUEUED
      },
      orderBy: [
        { isAutoplay: 'asc' },
        { requestedAt: 'asc' }
      ],
      include: {
        track: true,
        user: true
      }
    });

    // Ensure the database and player queue are in sync
    const playerQueue = client.player.getQueue();
    const playerQueueIds = new Set(playerQueue.map(track => track.youtubeId));
    
    // Filter out any tracks that are in the database but not in the player's queue
    const syncedQueuedTracks = queuedTracks.filter(track => 
      playerQueueIds.has(track.track.youtubeId)
    );

    // Log if there's a mismatch between database and player queue
    if (queuedTracks.length !== syncedQueuedTracks.length) {
      console.log(`Queue sync: Filtered out ${queuedTracks.length - syncedQueuedTracks.length} tracks that are in DB but not in player queue`);
    }

    // Format track for response
    const formatTrack = (request: RequestWithTrack): TrackResponse => ({
      youtubeId: request.track.youtubeId,
      title: request.track.title,
      thumbnail: request.track.thumbnail,
      duration: request.track.duration,
      requestedBy: {
        id: request.user.id,
        username: request.user.username,
        avatar: request.user.avatar || undefined
      },
      requestedAt: request.requestedAt.toISOString(),
      isAutoplay: request.isAutoplay
    });

    res.json({
      status: client.player.getStatus(),
      currentTrack: currentTrack ? formatTrack(currentTrack as RequestWithTrack) : undefined,
      queue: syncedQueuedTracks.map((track: RequestWithTrack) => formatTrack(track)),
      position: client.player.getPosition()
    });
  } catch (error) {
    console.error('Error getting player state:', error);
    res.status(500).json({ error: 'Failed to get player state' });
  }
});

/**
 * @swagger
 * /api/music/playback:
 *   post:
 *     summary: Control playback (play/pause)
 *     tags: [Music]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               action:
 *                 type: string
 *                 enum: [play, pause]
 *     responses:
 *       200:
 *         description: Playback state updated
 *       401:
 *         description: Unauthorized
 */
router.post('/playback', async (req: Request, res: Response) => {
  try {
    const { action } = req.body;
    if (action !== 'play' && action !== 'pause') {
      return res.status(400).json({ error: 'Invalid action' });
    }

    const client = getDiscordClient();
    if (!client) {
      return res.status(500).json({ error: 'Discord client not available' });
    }

    client.player.togglePlay();
    res.json({ success: true });
  } catch (error) {
    console.error('Error controlling playback:', error);
    res.status(500).json({ error: 'Failed to control playback' });
  }
});

/**
 * @swagger
 * /api/music/skip:
 *   post:
 *     summary: Skip current track
 *     tags: [Music]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Track skipped
 *       401:
 *         description: Unauthorized
 */
router.post('/skip', async (req: Request, res: Response) => {
  try {
    const client = getDiscordClient();
    if (!client) {
      return res.status(500).json({ error: 'Discord client not available' });
    }

    await client.player.skip();
    res.json({ success: true });
  } catch (error) {
    console.error('Error skipping track:', error);
    res.status(500).json({ error: 'Failed to skip track' });
  }
});

/**
 * @swagger
 * /api/music/ban:
 *   post:
 *     summary: Ban a track (admin only)
 *     tags: [Music]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               position:
 *                 type: number
 *                 description: Position in queue (starting from 1, omit to ban currently playing track)
 *     responses:
 *       200:
 *         description: Track banned
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Admin permissions required
 */
router.post('/ban', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Check if user has admin role
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { roles: true }
    });

    // Only allow admins to use this endpoint
    if (!user || !user.roles.some(role => role.name === 'admin')) {
      return res.status(403).json({ error: 'Admin permissions required' });
    }

    const client = getDiscordClient();
    if (!client) {
      return res.status(500).json({ error: 'Discord client not available' });
    }

    const { position: uiPosition } = req.body;
    
    if (uiPosition !== undefined) {
      // Convert UI position (1-based) to array index (0-based)
      const position = uiPosition - 1;
      
      // Ban a specific song in the queue by position
      const queue = client.player.getQueue();
      
      if (position < 0 || position >= queue.length) {
        return res.status(400).json({ 
          error: `Invalid position. Queue has ${queue.length} songs (positions 1-${queue.length}).` 
        });
      }
      
      const trackToBan = queue[position];
      
      // Apply ban penalty to the track (-10 score)
      await applyBanPenalty(trackToBan.youtubeId);
      
      // Remove from queue in both database and player
      await prisma.request.updateMany({
        where: {
          youtubeId: trackToBan.youtubeId,
          status: 'QUEUED',
          requestedAt: trackToBan.requestedAt
        },
        data: {
          status: 'SKIPPED'
        }
      });
      
      // Remove the track from the player's internal queue
      const removed = client.player.removeFromQueue(position);
      
      if (!removed) {
        console.warn(`Failed to remove track at position ${position} from player queue`);
      }
      
      // Add a small delay to ensure database changes are committed
      await new Promise(resolve => setTimeout(resolve, 100));
      
      res.json({ 
        success: true, 
        message: `Banned song at position ${uiPosition}: ${trackToBan.title}` 
      });
    } else {
      // Ban the currently playing song
      const currentTrack = client.player.getCurrentTrack();
      
      if (!currentTrack) {
        return res.status(400).json({ error: 'No track is currently playing.' });
      }
      
      // Apply ban penalty to the track (-10 score)
      await applyBanPenalty(currentTrack.youtubeId);
      
      // Update the status in the database
      await prisma.request.updateMany({
        where: {
          youtubeId: currentTrack.youtubeId,
          status: RequestStatus.PLAYING
        },
        data: {
          status: RequestStatus.SKIPPED
        }
      });
      
      // Skip the current track
      await client.player.skip();
      
      // Add a small delay to ensure database changes are committed
      await new Promise(resolve => setTimeout(resolve, 100));
      
      res.json({ 
        success: true, 
        message: `Banned and skipped: ${currentTrack.title}` 
      });
    }
  } catch (error) {
    console.error('Error banning track:', error);
    res.status(500).json({ error: 'Failed to ban track' });
  }
});

// Helper function to apply a ban penalty to a track
async function applyBanPenalty(youtubeId: string) {
  try {
    // Apply a -10 score penalty to the track
    await prisma.$transaction([
      // Update global track stats with a heavy penalty
      prisma.$executeRaw`
        UPDATE "Track"
        SET "globalScore" = "Track"."globalScore" - 10
        WHERE "youtubeId" = ${youtubeId}
      `,
      // Also update all user stats for this track with a penalty
      prisma.$executeRaw`
        UPDATE "UserTrackStats"
        SET "personalScore" = "UserTrackStats"."personalScore" - 5
        WHERE "youtubeId" = ${youtubeId}
      `
    ]);
  } catch (error) {
    console.error('Error applying ban penalty:', error);
    throw error;
  }
}

/**
 * @swagger
 * /api/music/volume:
 *   post:
 *     summary: Set player volume
 *     tags: [Music]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               volume:
 *                 type: number
 *                 minimum: 0
 *                 maximum: 1
 *     responses:
 *       200:
 *         description: Volume updated
 *       401:
 *         description: Unauthorized
 */
router.post('/volume', async (req, res) => {
  try {
    const { volume } = req.body;
    if (typeof volume !== 'number' || volume < 0 || volume > 1) {
      return res.status(400).json({ error: 'Invalid volume' });
    }

    const client = getDiscordClient();
    if (!client) {
      return res.status(500).json({ error: 'Discord client not available' });
    }

    client.player.setVolume(volume);
    res.json({ success: true });
  } catch (error) {
    console.error('Error setting volume:', error);
    res.status(500).json({ error: 'Failed to set volume' });
  }
});

/**
 * @swagger
 * /api/music/autoplay:
 *   post:
 *     summary: Toggle autoplay
 *     tags: [Music]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               enabled:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Autoplay state updated
 *       401:
 *         description: Unauthorized
 */
router.post('/autoplay', async (req, res) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'Invalid enabled state' });
    }

    const client = getDiscordClient();
    if (!client) {
      return res.status(500).json({ error: 'Discord client not available' });
    }

    client.player.setAutoplay(enabled);
    res.json({ success: true });
  } catch (error) {
    console.error('Error toggling autoplay:', error);
    res.status(500).json({ error: 'Failed to toggle autoplay' });
  }
});

router.get('/audio/:youtubeId', async (req, res) => {
  const startTime = Date.now();
  
  try {
    // Check authentication - user might not be a WebUser type
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { youtubeId } = req.params;
    const isPrefetch = req.headers['x-prefetch'] === 'true';
    
    // Log without user ID for privacy
    console.log(`Audio request for: ${youtubeId}${isPrefetch ? ' (prefetch)' : ''}`);
    
    // Get cached audio file
    const audioCache = await prisma.audioCache.findUnique({
      where: { youtubeId }
    });

    if (!audioCache || !fs.existsSync(audioCache.filePath)) {
      console.log('Audio not found:', youtubeId);
      
      // For prefetch requests, trigger background download instead of returning 404
      if (isPrefetch) {
        // Get the Discord client to trigger a background download
        const client = getDiscordClient();
        if (client) {
          // Trigger a download by requesting the audio resource
          // This will automatically download if not in cache
          console.log(`Initiating background download for ${youtubeId}`);
          
          // Use a background process to download the audio
          (async () => {
            try {
              // This will download the audio if it doesn't exist
              await downloadYoutubeAudio(youtubeId);
              console.log(`Background download complete for ${youtubeId}`);
            } catch (error) {
              console.error(`Background download failed for ${youtubeId}:`, error);
            }
          })();
          
          return res.status(202).json({ message: 'Download initiated' });
        }
      }
      
      return res.status(404).json({ error: 'Audio not found in cache' });
    }

    // For HEAD requests (prefetch), just return headers without body
    if (req.method === 'HEAD') {
      const stat = fs.statSync(audioCache.filePath);
      const fileSize = stat.size;
      
      // Set CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, Range, X-Prefetch');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      
      // Determine content type
      const extension = audioCache.filePath.split('.').pop()?.toLowerCase();
      let contentType = 'audio/mp4'; // default for AAC/M4A

      switch (extension) {
        case 'm4a':
          contentType = 'audio/mp4';
          break;
        case 'aac':
          contentType = 'audio/aac';
          break;
        case 'mp3':
          contentType = 'audio/mpeg';
          break;
        case 'webm':
          contentType = 'audio/webm';
          break;
      }
      
      // Set audio headers
      res.setHeader('Content-Type', contentType);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Length', fileSize);
      
      // Set caching headers
      const etag = `"${youtubeId}-${stat.mtime.getTime()}"`;
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      
      // Track prefetch metrics
      audioStreamRequestsCounter.inc({ type: 'prefetch' });
      
      return res.status(200).end();
    }

    // Log file details for debugging
    console.log(`Serving audio file: path=${audioCache.filePath}, size=${fs.statSync(audioCache.filePath).size}, extension=${audioCache.filePath.split('.').pop()}`);

    const stat = fs.statSync(audioCache.filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    // Set CORS headers for audio streaming
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, Range');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

    // Determine content type based on file extension
    const extension = audioCache.filePath.split('.').pop()?.toLowerCase();
    let contentType = 'audio/mp4'; // default for AAC/M4A

    switch (extension) {
      case 'm4a':
        contentType = 'audio/mp4'; // Standard MIME type for M4A/AAC
        break;
      case 'aac':
        contentType = 'audio/aac';
        break;
      case 'mp3':
        contentType = 'audio/mpeg';
        break;
      case 'webm':
        contentType = 'audio/webm';
        break;
    }

    // Set audio headers
    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    
    // Improved caching headers for streaming
    const etag = `"${youtubeId}-${stat.mtime.getTime()}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours
    
    // Check if client has a valid cached copy
    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end(); // Not Modified
    }

    // Handle range requests
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      
      // For streaming, use smaller chunk sizes (256KB) for faster initial playback
      // but allow larger chunks (up to 1MB) if explicitly requested
      const end = parts[1] 
        ? parseInt(parts[1], 10) 
        : Math.min(start + 256 * 1024, fileSize - 1);
      
      const chunksize = (end - start) + 1;

      console.log(`Range request: start=${start}, end=${end}, chunksize=${chunksize}`);
      
      // Track range request metrics
      audioStreamRequestsCounter.inc({ type: 'range' });
      audioStreamBytesCounter.inc({ type: 'range' }, chunksize);

      // Validate range
      if (start >= fileSize || end >= fileSize) {
        // Return the 416 Range Not Satisfiable if the range is invalid
        res.setHeader('Content-Range', `bytes */${fileSize}`);
        return res.status(416).end();
      }

      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
      res.setHeader('Content-Length', chunksize);
      res.status(206);

      const stream = fs.createReadStream(audioCache.filePath, { start, end });
      
      // Add better error handling for streams
      stream.on('error', (error) => {
        console.error('Stream error:', error);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Stream error' });
        } else if (!res.writableEnded) {
          res.end();
        }
      });
      
      // Handle client disconnects
      req.on('close', () => {
        stream.destroy();
      });
      
      // Track latency when the response finishes
      res.on('finish', () => {
        const latency = (Date.now() - startTime) / 1000;
        audioStreamLatencyHistogram.observe(latency);
      });
      
      stream.pipe(res);
    } else {
      // No range requested, send entire file
      // For streaming clients, they should be using range requests
      // but we'll handle the full file case as well
      
      // Track full file request metrics
      audioStreamRequestsCounter.inc({ type: 'full' });
      audioStreamBytesCounter.inc({ type: 'full' }, fileSize);
      
      res.setHeader('Content-Length', fileSize);
      const stream = fs.createReadStream(audioCache.filePath);
      
      stream.on('error', (error) => {
        console.error('Stream error:', error);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Stream error' });
        } else if (!res.writableEnded) {
          res.end();
        }
      });
      
      // Handle client disconnects
      req.on('close', () => {
        stream.destroy();
      });
      
      // Track latency when the response finishes
      res.on('finish', () => {
        const latency = (Date.now() - startTime) / 1000;
        audioStreamLatencyHistogram.observe(latency);
      });
      
      stream.pipe(res);
    }
  } catch (error) {
    console.error('Error streaming audio:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to stream audio' });
    }
  }
});

/**
 * @swagger
 * /api/music/position:
 *   get:
 *     summary: Get current playback position
 *     tags: [Music]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Current playback position in seconds
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 position:
 *                   type: number
 *                   description: Current position in seconds
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
router.get('/position', async (req: Request, res: Response) => {
  try {
    const client = getDiscordClient();
    if (!client) {
      return res.status(500).json({ error: 'Discord client not available' });
    }
    
    const position = client.player.getPosition();
    res.json({ position });
  } catch (error) {
    console.error('Error getting playback position:', error);
    res.status(500).json({ error: 'Failed to get playback position' });
  }
});

router.get('/history', async (req: Request, res: Response) => {
  try {
    const tracks = await prisma.request.findMany({
      where: {
        status: RequestStatus.COMPLETED,
        playedAt: { not: null }
      },
      orderBy: {
        playedAt: 'desc'
      },
      take: 50,
      include: {
        track: true,
        user: true
      }
    });

    res.json({
      tracks: tracks.map((request: RequestWithTrack) => ({
        youtubeId: request.track.youtubeId,
        title: request.track.title,
        thumbnail: request.track.thumbnail,
        duration: request.track.duration,
        requestedBy: {
          id: request.user.id,
          username: request.user.username,
          avatar: request.user.avatar || undefined
        },
        requestedAt: request.requestedAt.toISOString(),
        playedAt: request.playedAt!.toISOString(),
        isAutoplay: request.isAutoplay
      }))
    });
  } catch (error) {
    console.error('Error getting history:', error);
    res.status(500).json({ error: 'Failed to get history' });
  }
});

/**
 * @swagger
 * /api/health:
 *   get:
 *     summary: Health check endpoint
 *     tags: [System]
 *     responses:
 *       200:
 *         description: Service is healthy
 */
router.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

/**
 * @swagger
 * /api/music/stream:
 *   get:
 *     summary: Get continuous audio stream
 *     tags: [Music]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Audio stream
 *         content:
 *           audio/mpeg:
 *             schema:
 *               type: string
 *               format: binary
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
router.get('/stream', async (req, res) => {
  try {
    // Check authentication
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Set headers for streaming
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, Range');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

    // Get Discord client
    const client = getDiscordClient();
    if (!client) {
      return res.status(500).json({ error: 'Discord client not available' });
    }

    // Create a PassThrough stream to pipe audio data
    const { PassThrough } = await import('stream');
    const audioStream = new PassThrough();

    // Function to send silence when no track is playing
    const sendSilence = () => {
      // Create 1 second of silence (44.1kHz, 16-bit, stereo)
      const silenceBuffer = Buffer.alloc(44100 * 2 * 2);
      audioStream.write(silenceBuffer);
    };

    // Handle client disconnect
    req.on('close', () => {
      console.log('Client disconnected from audio stream');
      audioStream.end();
    });

    // Start streaming
    res.status(200);
    audioStream.pipe(res);

    // Send initial silence to start the stream
    sendSilence();

    // Set up audio pipeline from Discord player
    client.player.setupAudioPipeline(audioStream);

    // Log streaming start
    console.log('Started audio streaming for client');
    
    // Track metrics
    audioStreamRequestsCounter.inc({ type: 'stream' });
  } catch (error) {
    console.error('Error setting up audio stream:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to set up audio stream' });
    }
  }
});

// Export WebSocket handler for audio streaming
export function setupWebSocketAudio(server: any) {
  const wss = new WebSocket.Server({ 
    noServer: true,
    path: '/api/music/ws-stream'
  });

  // Handle upgrade requests
  server.on('upgrade', async (request: any, socket: any, head: any) => {
    if (request.url.startsWith('/api/music/ws-stream')) {
      // Extract token from query string
      const url = new URL(request.url, `http://${request.headers.host}`);
      const token = url.searchParams.get('token');
      
      if (!token) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      
      try {
        // Verify token using jwt directly
        const decoded = jwt.verify(token, process.env.JWT_SECRET!) as {
          id: string;
          roles: string[];
        };
        
        // Get user from database to ensure they still exist
        const user = await prisma.user.findUnique({
          where: { id: decoded.id },
          include: { roles: true },
        });

        if (!user) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        
        // Store user info for later use
        (request as any).user = {
          id: user.id,
          roles: user.roles.map(role => role.name),
        };
        
        // Upgrade the connection
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request);
        });
      } catch (error) {
        console.error('WebSocket auth error:', error);
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
      }
    }
  });

  // Handle WebSocket connections
  wss.on('connection', async (ws: WebSocket, request: any) => {
    console.log('WebSocket audio stream connected');
    
    // Get Discord client
    const client = getDiscordClient();
    if (!client) {
      ws.close(1011, 'Discord client not available');
      return;
    }
    
    // Create a PassThrough stream for audio data
    const audioStream = new PassThrough();
    
    // Track metrics
    audioStreamRequestsCounter.inc({ type: 'websocket' });
    
    // Handle WebSocket close
    ws.on('close', () => {
      console.log('WebSocket audio stream closed');
      audioStream.end();
    });
    
    // Handle WebSocket errors
    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
      audioStream.end();
    });
    
    // Set up audio pipeline from Discord player
    client.player.setupAudioPipeline(audioStream);
    
    // Pipe audio data to WebSocket
    audioStream.on('data', (chunk) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(chunk);
      }
    });
    
    // Send initial message to confirm connection
    ws.send(JSON.stringify({ type: 'connected', message: 'Audio stream connected' }));
  });
  
  return wss;
}

// Add a new endpoint for HLS streaming
router.get('/hls/:youtubeId/:segment', async (req, res) => {
  try {
    // Check authentication
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { youtubeId, segment } = req.params;
    
    // Get cached audio file
    const audioCache = await prisma.audioCache.findUnique({
      where: { youtubeId }
    });

    if (!audioCache || !fs.existsSync(audioCache.filePath)) {
      return res.status(404).json({ error: 'Audio not found' });
    }

    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    
    // Set content type for TS segment
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours
    
    // Create cache directory for HLS segments if it doesn't exist
    const cacheDir = process.env.CACHE_DIR || path.join(process.cwd(), 'cache');
    const hlsDir = path.join(cacheDir, 'hls', youtubeId);
    
    if (!fs.existsSync(hlsDir)) {
      fs.mkdirSync(hlsDir, { recursive: true });
    }
    
    const segmentPath = path.join(hlsDir, `${segment}.ts`);
    
    // Check if segment already exists
    if (fs.existsSync(segmentPath)) {
      // Serve cached segment
      const stream = fs.createReadStream(segmentPath);
      stream.pipe(res);
      return;
    }
    
    // Generate segment using ffmpeg
    const ffmpegProcess = spawn(ffmpeg!, [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', audioCache.filePath,
      '-c:a', 'aac',
      '-b:a', '128k',
      '-f', 'segment',
      '-segment_time', '10',
      '-segment_start_number', segment,
      '-segment_list', path.join(hlsDir, 'playlist.m3u8'),
      '-segment_format', 'mpegts',
      path.join(hlsDir, '%d.ts')
    ]);
    
    ffmpegProcess.on('close', (code) => {
      if (code === 0 && fs.existsSync(segmentPath)) {
        // Serve generated segment
        const stream = fs.createReadStream(segmentPath);
        stream.pipe(res);
      } else {
        res.status(500).json({ error: 'Failed to generate segment' });
      }
    });
    
    ffmpegProcess.stderr.on('data', (data) => {
      console.error(`FFmpeg error: ${data}`);
    });
    
  } catch (error) {
    console.error('Error serving HLS segment:', error);
    res.status(500).json({ error: 'Failed to serve segment' });
  }
});

// Add endpoint for HLS playlist
router.get('/hls/:youtubeId/playlist.m3u8', async (req, res) => {
  try {
    // Check authentication
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { youtubeId } = req.params;
    
    // Get cached audio file
    const audioCache = await prisma.audioCache.findUnique({
      where: { youtubeId },
      include: { track: true }
    });

    if (!audioCache || !fs.existsSync(audioCache.filePath)) {
      return res.status(404).json({ error: 'Audio not found' });
    }

    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    
    // Set content type for M3U8 playlist
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache'); // Don't cache playlist
    
    // Create cache directory for HLS segments if it doesn't exist
    const cacheDir = process.env.CACHE_DIR || path.join(process.cwd(), 'cache');
    const hlsDir = path.join(cacheDir, 'hls', youtubeId);
    
    if (!fs.existsSync(hlsDir)) {
      fs.mkdirSync(hlsDir, { recursive: true });
    }
    
    const playlistPath = path.join(hlsDir, 'playlist.m3u8');
    
    // Check if playlist already exists
    if (fs.existsSync(playlistPath)) {
      // Serve cached playlist
      const stream = fs.createReadStream(playlistPath);
      stream.pipe(res);
      return;
    }
    
    // Generate playlist using ffmpeg
    const ffmpegProcess = spawn(ffmpeg!, [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', audioCache.filePath,
      '-c:a', 'aac',
      '-b:a', '128k',
      '-f', 'hls',
      '-hls_time', '10',
      '-hls_list_size', '0',
      '-hls_segment_filename', path.join(hlsDir, '%d.ts'),
      playlistPath
    ]);
    
    ffmpegProcess.on('close', (code) => {
      if (code === 0 && fs.existsSync(playlistPath)) {
        // Serve generated playlist
        const stream = fs.createReadStream(playlistPath);
        stream.pipe(res);
      } else {
        res.status(500).json({ error: 'Failed to generate playlist' });
      }
    });
    
    ffmpegProcess.stderr.on('data', (data) => {
      console.error(`FFmpeg error: ${data}`);
    });
    
  } catch (error) {
    console.error('Error serving HLS playlist:', error);
    res.status(500).json({ error: 'Failed to serve playlist' });
  }
});

export { router as musicRouter };
