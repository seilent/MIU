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
import { Readable, PassThrough } from 'stream';
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

    console.log('\x1b[36m%s\x1b[0m', `[TRACK ADDED] 🎵 "${trackInfo.title}" by ${user.username} (${user.id}) via web_request`);

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
    
    console.log('\x1b[33m%s\x1b[0m', `[AUTOPLAY] ${enabled ? '✅ Enabled' : '❌ Disabled'} by web_interface`);

    res.json({ success: true });
  } catch (error) {
    console.error('Error toggling autoplay:', error);
    res.status(500).json({ error: 'Failed to toggle autoplay' });
  }
});

// Shared stream controller
const activeStreams = new Map<string, {
  stream: Readable;
  listeners: number;
  filePath: string;
}>();

function getSharedStream(youtubeId: string, filePath: string): Readable {
  const existing = activeStreams.get(youtubeId);
  if (existing) {
    existing.listeners++;
    return existing.stream;
  }

  const stream = fs.createReadStream(filePath, {
    highWaterMark: 1024 * 64 // 64KB chunks for efficient streaming
  });

  activeStreams.set(youtubeId, {
    stream,
    listeners: 1,
    filePath
  });
          
  // Cleanup when stream ends
  stream.on('end', () => {
    const streamData = activeStreams.get(youtubeId);
    if (streamData && --streamData.listeners === 0) {
      activeStreams.delete(youtubeId);
            }
  });
          
  return stream;
}

// New streaming endpoint
router.get('/stream', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const client = getDiscordClient();
    if (!client) {
      return res.status(500).json({ error: 'Discord client not available' });
    }

    const currentTrack = await prisma.request.findFirst({
      where: { status: RequestStatus.PLAYING },
      include: { track: true }
    });

    if (!currentTrack) {
      return res.status(404).json({ error: 'No track playing' });
    }

    // Get cached audio file
    const audioCache = await prisma.audioCache.findUnique({
      where: { youtubeId: currentTrack.track.youtubeId }
    });

    if (!audioCache || !fs.existsSync(audioCache.filePath)) {
      return res.status(404).json({ error: 'Audio not found' });
    }

    const filePath = audioCache.filePath;
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;

    // Handle range requests
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = (end - start) + 1;
      const file = fs.createReadStream(filePath, { start, end });

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': 'audio/mp4',
        'Content-Disposition': 'inline',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        'X-Content-Type-Options': 'nosniff',
        'X-Initial-Position': client.player.getPosition(),
        'X-Playback-Start': Date.now(),
        'X-Track-Id': currentTrack.track.youtubeId,
        'X-Track-Duration': currentTrack.track.duration,
        'Access-Control-Expose-Headers': 'X-Initial-Position, X-Playback-Start, X-Track-Id, X-Track-Duration, Accept-Ranges, Content-Length, Content-Range'
      });

      // Track metrics
      audioStreamRequestsCounter.inc({ type: 'stream' });
      const startTime = Date.now();

      // Handle client disconnect
      req.on('close', () => {
        file.destroy();
        const latency = (Date.now() - startTime) / 1000;
        audioStreamLatencyHistogram.observe(latency);
      });

      file.pipe(res);
    } else {
      // No range requested - send entire file
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': 'audio/mp4',
        'Content-Disposition': 'inline',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        'X-Content-Type-Options': 'nosniff',
        'X-Initial-Position': client.player.getPosition(),
        'X-Playback-Start': Date.now(),
        'X-Track-Id': currentTrack.track.youtubeId,
        'X-Track-Duration': currentTrack.track.duration,
        'Access-Control-Expose-Headers': 'X-Initial-Position, X-Playback-Start, X-Track-Id, X-Track-Duration, Accept-Ranges, Content-Length'
      });

      // Track metrics
      audioStreamRequestsCounter.inc({ type: 'stream' });
      const startTime = Date.now();

      // Create read stream with larger buffer for better performance
      const file = fs.createReadStream(filePath, {
        highWaterMark: 64 * 1024 // 64KB chunks
      });

      // Handle client disconnect
      req.on('close', () => {
        file.destroy();
        const latency = (Date.now() - startTime) / 1000;
        audioStreamLatencyHistogram.observe(latency);
      });

      file.pipe(res);
    }
  } catch (error) {
    console.error('Stream error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Stream failed' });
    }
  }
});

// Enhanced position endpoint
router.get('/position', async (req: Request, res: Response) => {
  try {
    const client = getDiscordClient();
    if (!client) {
      return res.status(500).json({ error: 'Discord client not available' });
    }
    
    const currentTrack = await prisma.request.findFirst({
      where: { status: RequestStatus.PLAYING },
      include: { track: true }
    });

    res.json({
      position: client.player.getPosition(),
      duration: currentTrack?.track.duration || 0,
      timestamp: Date.now(),
      trackId: currentTrack?.track.youtubeId,
      title: currentTrack?.track.title,
      playbackRate: 1.0
    });
  } catch (error) {
    console.error('Position error:', error);
    res.status(500).json({ error: 'Failed to get position' });
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

export { router as musicRouter };
