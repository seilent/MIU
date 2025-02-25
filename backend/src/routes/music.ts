import express, { Router, Request, Response } from 'express';
import { PrismaClient, User, Prisma, RequestStatus, Track } from '@prisma/client';
import { prisma } from '../prisma.js';
import { getDiscordClient } from '../discord/client.js';
import { searchLimiter, stateLimiter, queueLimiter, positionLimiter } from '../middleware/rateLimit.js';
import fs from 'fs';
import rateLimit from 'express-rate-limit';
import { getYoutubeId, getYoutubeInfo, searchYoutube, parseDuration } from '../utils/youtube.js';
import { MAX_DURATION } from '../config.js';

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
      queue: queuedTracks.map((track: RequestWithTrack) => formatTrack(track)),
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
  try {
    // Check authentication - user might not be a WebUser type
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { youtubeId } = req.params;
    console.log('Audio request for:', youtubeId, 'by user ID:', req.user.id);
    
    // Get cached audio file
    const audioCache = await prisma.audioCache.findUnique({
      where: { youtubeId }
    });

    if (!audioCache || !fs.existsSync(audioCache.filePath)) {
      console.log('Audio not found:', youtubeId);
      return res.status(404).json({ error: 'Audio not found in cache' });
    }

    // Log file details for debugging
    console.log('Serving audio file:', {
      path: audioCache.filePath,
      size: fs.statSync(audioCache.filePath).size,
      extension: audioCache.filePath.split('.').pop()
    });

    const stat = fs.statSync(audioCache.filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    // Set CORS headers for audio streaming
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
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
    res.setHeader('Cache-Control', 'public, max-age=3600');

    // Handle range requests
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : Math.min(start + 1024*1024, fileSize - 1); // Limit chunk size
      const chunksize = (end - start) + 1;

      console.log('Range request:', { start, end, chunksize });

      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
      res.setHeader('Content-Length', chunksize);
      res.status(206);

      const stream = fs.createReadStream(audioCache.filePath, { start, end });
      stream.on('error', (error) => {
        console.error('Stream error:', error);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Stream error' });
        }
      });
      stream.pipe(res);
    } else {
      // No range requested, send entire file
      res.setHeader('Content-Length', fileSize);
      const stream = fs.createReadStream(audioCache.filePath);
      stream.on('error', (error) => {
        console.error('Stream error:', error);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Stream error' });
        }
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

export { router as musicRouter };
