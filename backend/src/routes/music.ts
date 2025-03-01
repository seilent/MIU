import express, { Request, Response, Router } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';
import { prisma } from '../prisma.js';
import { getDiscordClient } from '../discord/client.js';
import fs from 'fs';
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
import { getPlayer } from '../discord/player.js';
import { RequestStatus } from '../types/enums.js';
import { spawn } from 'child_process';
import getEnv from '../utils/env.js';

const env = getEnv();

interface WebUser {
  id: string;
  username: string;
  discriminator: string;
  avatar: string | null;
}

interface RequestWithTrack {
  track: {
    youtubeId: string;
    title: string;
    thumbnail: string;
    duration: number;
    resolvedYtId: string | null;
    isMusicUrl?: boolean;
    createdAt?: Date;
    updatedAt?: Date;
    globalScore?: number;
    playCount?: number;
    skipCount?: number;
    isActive?: boolean;
  };
  user: {
    id: string;
    username: string;
    avatar: string | null;
  };
  requestedAt: Date;
  playedAt?: Date | null;
  isAutoplay: boolean;
}

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

// Enhance SSE client interface
interface SSEClient {
  id: string;
  response: Response;
  lastEventId?: string;
}

interface QueueItem {
  youtubeId: string;
  title: string;
  thumbnail: string;
  duration: number;
  requestedBy: {
    userId: string;
    username: string;
    discriminator: string;
    avatar: string | null;
  };
  requestedAt: Date;
  isAutoplay: boolean;
}

// Helper function to format track response
function formatTrack(request: RequestWithTrack): TrackResponse {
  // Always use original youtubeId for consistency
  const youtubeId = request.track.youtubeId;
  
  return {
    youtubeId,
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
  };
}

// Store active SSE clients
export const sseClients = new Set<SSEClient>();

// Helper functions for SSE broadcasts
export function broadcastToClient(client: SSEClient, event: string, data: any) {
  try {
    client.response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\nid: ${Date.now()}\n\n`);
  } catch (error) {
    console.error(`Error broadcasting to client ${client.id}:`, error);
    sseClients.delete(client);
  }
}

export function broadcast(event: string, data: any) {
  sseClients.forEach(client => {
    broadcastToClient(client, event, data);
  });
}

const router = Router();

// Search endpoint
router.get('/search', async (req: Request, res: Response) => {
  try {
    const query = req.query.q as string;
    if (!query) {
      return res.status(400).json({ error: 'Search query is required' });
    }

    const results = await searchYoutube(query);
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
    const youtubeIdResult = await getYoutubeId(url);
    if (!youtubeIdResult || !youtubeIdResult.videoId) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    // Check if the song is already in queue or recently played
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
    const recentRequest = await prisma.request.findFirst({
      where: {
        youtubeId: youtubeIdResult.videoId,
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
    const trackInfo = await getYoutubeInfo(youtubeIdResult.videoId, youtubeIdResult.isMusicUrl);
    if (trackInfo.duration > MAX_DURATION) {
      return res.status(400).json({ 
        error: `Track duration exceeds limit of ${Math.floor(MAX_DURATION / 60)} minutes` 
      });
    }

    // Add to queue
    const track = await client.player.play(
      null, // No voice state for web requests
      youtubeIdResult.videoId,
      user.id,
      {
        username: user.username,
        discriminator: user.discriminator || '0000',
        avatar: user.avatar
      },
      youtubeIdResult.isMusicUrl
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

    // Ensure the database and player queue are in sync
    const playerQueue = client.player.getQueue();
    
    // First, mark all queued tracks as stale
    await prisma.request.updateMany({
      where: {
        status: RequestStatus.QUEUED
      },
      data: {
        status: RequestStatus.SKIPPED
      }
    });

    // Then, update or create entries for tracks in the player queue
    for (const track of playerQueue) {
      try {
        // Create or update track entry
        const trackEntry = await prisma.track.upsert({
          where: { youtubeId: track.youtubeId },
          create: {
            youtubeId: track.youtubeId,
            title: track.title || 'Unknown Title',
            thumbnail: track.thumbnail || '',
            duration: track.duration || 0,
            isMusicUrl: false,
            isActive: true,
            globalScore: 0,
            playCount: 0,
            skipCount: 0
          },
          update: {} // No updates needed
        });

        // Try to find an existing request for this track
        const existingRequest = await prisma.request.findFirst({
          where: {
            youtubeId: track.youtubeId,
            OR: [
              { status: RequestStatus.QUEUED },
              { status: RequestStatus.SKIPPED }
            ]
          },
          orderBy: {
            requestedAt: 'desc'
          }
        });

        if (existingRequest) {
          // Update existing request using compound unique key
          await prisma.request.update({
            where: {
              youtubeId_requestedAt: {
                youtubeId: existingRequest.youtubeId,
                requestedAt: existingRequest.requestedAt
              }
            },
            data: {
              status: RequestStatus.QUEUED,
              isAutoplay: track.isAutoplay || false
            }
          });
        } else {
          // Create new request entry with a unique timestamp
          const requestedAt = await ensureUniqueRequestTimestamp(track.youtubeId, new Date());
          
          await prisma.request.create({
            data: {
              status: RequestStatus.QUEUED,
              isAutoplay: track.isAutoplay || false,
              requestedAt,
              youtubeId: track.youtubeId,
              userId: track.requestedBy?.userId || client.user?.id || 'bot'
            }
          });
        }
      } catch (error) {
        console.error('Error syncing track:', error);
      }
    }

    // Helper function to ensure unique timestamp
    async function ensureUniqueRequestTimestamp(youtubeId: string, baseTime: Date): Promise<Date> {
      let timestamp = new Date(baseTime);
      let attempts = 0;
      const maxAttempts = 10;

      while (attempts < maxAttempts) {
        // Check if a request with this timestamp exists
        const existingRequest = await prisma.request.findUnique({
          where: {
            youtubeId_requestedAt: {
              youtubeId,
              requestedAt: timestamp
            }
          }
        });

        if (!existingRequest) {
          return timestamp;
        }

        // Add 1 millisecond and try again
        timestamp = new Date(timestamp.getTime() + 1);
        attempts++;
      }

      throw new Error('Could not generate unique timestamp after maximum attempts');
    }

    // Get the updated queue
    const updatedQueuedTracks = await prisma.request.findMany({
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

    // After updating the state, broadcast to all SSE clients
    const state = {
      status: client.player.getStatus(),
      currentTrack: currentTrack ? formatTrack(currentTrack as RequestWithTrack) : undefined,
      queue: updatedQueuedTracks.map((track: RequestWithTrack) => formatTrack(track)),
      position: client.player.getPosition()
    };

    broadcastPlayerState(state);

    res.json({
      status: client.player.getStatus(),
      currentTrack: currentTrack ? formatTrack(currentTrack as RequestWithTrack) : undefined,
      queue: updatedQueuedTracks.map((track: RequestWithTrack) => formatTrack(track)),
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

// History endpoint
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
        track: {
          select: {
            youtubeId: true,
            title: true,
            thumbnail: true,
            duration: true,
            isMusicUrl: true
          }
        },
        user: {
          select: {
            id: true,
            username: true,
            avatar: true
          }
        }
      }
    });

    if (!Array.isArray(tracks)) {
      throw new Error('Invalid history data format');
    }

    const formattedTracks = tracks.map(request => ({
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
      playedAt: request.playedAt?.toISOString(),
      isAutoplay: request.isAutoplay || false
    }));

    res.json(formattedTracks);
  } catch (error) {
    console.error('Error getting history:', error);
    res.status(500).json({ 
      error: 'Failed to get history',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
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

// Helper function to convert QueueItem to RequestWithTrack
function queueItemToRequestWithTrack(item: QueueItem): RequestWithTrack {
  return {
    track: {
      youtubeId: item.youtubeId,
      title: item.title,
      thumbnail: item.thumbnail,
      duration: item.duration,
      resolvedYtId: null,
      isMusicUrl: false
    },
    user: {
      id: item.requestedBy.userId,
      username: item.requestedBy.username,
      avatar: item.requestedBy.avatar
    },
    requestedAt: item.requestedAt,
    isAutoplay: item.isAutoplay
  };
}

// SSE endpoint for live state updates
router.get('/state/live', (req: Request, res: Response) => {
  try {
    // Check authentication from query parameter or user session
    const token = req.query.token as string;
    if (!req.user && !token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const headers = {
      'Content-Type': 'text/event-stream',
      'Connection': 'keep-alive',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': req.headers.origin || '*',
      'Access-Control-Allow-Credentials': 'true'
    };
    res.writeHead(200, headers);

    // Flush headers immediately
    res.flushHeaders();

    const clientId = Math.random().toString(36).substring(7);
    const client: SSEClient = {
      id: clientId,
      response: res,
      lastEventId: req.headers['last-event-id'] as string
    };

    // Send initial state
    const player = getPlayer();
    if (!player) {
      throw new Error('Player not available');
    }

    const currentTrack = player.getCurrentTrack();
    const queuedTracks = player.getQueue();

    const initialState = {
      status: player.getStatus(),
      currentTrack: currentTrack ? formatTrack(queueItemToRequestWithTrack({
        ...currentTrack,
        requestedBy: {
          userId: currentTrack.requestedBy.userId,
          username: currentTrack.requestedBy.username,
          discriminator: '0000',
          avatar: currentTrack.requestedBy.avatar || null
        }
      })) : null,
      queue: queuedTracks.map(track => formatTrack(queueItemToRequestWithTrack({
        ...track,
        requestedBy: {
          userId: track.requestedBy.userId,
          username: track.requestedBy.username,
          discriminator: '0000',
          avatar: track.requestedBy.avatar || null
        }
      }))),
      position: player.getPosition()
    };

    broadcastToClient(client, 'state', initialState);

    // Add client to active clients
    sseClients.add(client);

    // Set up keep-alive interval
    const keepAliveInterval = setInterval(() => {
      if (!res.writableEnded) {
        res.write('event: heartbeat\ndata: {}\n\n');
      } else {
        cleanup();
      }
    }, 30000); // Send keepalive every 30 seconds to match Apache's keepalive settings

    // Handle client disconnect
    req.on('close', () => {
      console.log(`SSE client ${clientId} disconnected`);
      cleanup();
    });

    // Handle errors
    res.on('error', (error) => {
      console.error(`SSE connection error for client ${clientId}:`, error);
      cleanup();
    });

    // Cleanup function
    function cleanup() {
      clearInterval(keepAliveInterval);
      sseClients.delete(client);
      if (!res.writableEnded) {
        try {
          res.end();
        } catch (error) {
          console.error(`Error ending SSE connection for client ${clientId}:`, error);
        }
      }
    }

  } catch (error) {
    console.error('Error in SSE connection:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to establish SSE connection' });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
});

// Update the player state broadcast
export function broadcastPlayerState(data: any) {
  // Send all state updates in a single event to prevent race conditions
  broadcast('state', {
    status: data.status,
    currentTrack: data.currentTrack || null,
    queue: data.queue || [],
    position: data.position
  });
}

// HLS Endpoints
router.get('/hls/:youtubeId/playlist.m3u8', async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { youtubeId } = req.params;
    const filePath = path.join(env.getString('CACHE_DIR'), 'audio', `${youtubeId}.m4a`);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Track not found' });
    }

    // Generate m3u8 playlist
    const segmentDuration = 10; // 10 seconds per segment
    const audioInfo = await getAudioDuration(filePath);
    const duration = audioInfo.duration;
    const segmentCount = Math.ceil(duration / segmentDuration);

    let playlist = '#EXTM3U\n';
    playlist += '#EXT-X-VERSION:3\n';
    playlist += '#EXT-X-TARGETDURATION:' + segmentDuration + '\n';
    playlist += '#EXT-X-MEDIA-SEQUENCE:0\n';
    playlist += '#EXT-X-PLAYLIST-TYPE:VOD\n';

    for (let i = 0; i < segmentCount; i++) {
      const segmentDur = Math.min(segmentDuration, duration - (i * segmentDuration));
      playlist += '#EXTINF:' + segmentDur.toFixed(3) + ',\n';
      playlist += `segment_${i}.ts\n`;
    }

    playlist += '#EXT-X-ENDLIST';

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'max-age=3600');
    res.send(playlist);
  } catch (error) {
    console.error('HLS: Error generating playlist:', error);
    res.status(500).json({ error: 'Failed to generate playlist' });
  }
});

router.get('/hls/:youtubeId/segment_:index.ts', async (req: Request, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { youtubeId, index } = req.params;
    const filePath = path.join(env.getString('CACHE_DIR'), 'audio', `${youtubeId}.m4a`);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Track not found' });
    }

    const segmentIndex = parseInt(index);
    const segmentDuration = 10; // 10 seconds per segment
    const startTime = segmentIndex * segmentDuration;

    try {
      // Create a readable stream for the segment
      const segmentStream = await createSegmentStream(filePath, startTime, segmentDuration);
      
      res.setHeader('Content-Type', 'video/MP2T');
      res.setHeader('Cache-Control', 'max-age=3600');
      
      segmentStream.pipe(res);

      // Handle client disconnect
      req.on('close', () => {
        segmentStream.destroy();
      });
    } catch (error) {
      console.error('HLS: Error creating segment stream:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error creating segment' });
      }
    }
  } catch (error) {
    console.error('HLS: Error creating segment stream:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Error creating segment' });
    }
  }
});

// Helper function to create segment stream
async function createSegmentStream(filePath: string, startTime: number, duration: number): Promise<Readable> {
  return new Promise((resolve, reject) => {
    try {
      const segmentStream = new PassThrough();
      const ffmpeg = spawn('ffmpeg', [
        '-hide_banner',
        '-loglevel', 'error',
        '-i', filePath,
        '-ss', startTime.toString(),
        '-t', duration.toString(),
        '-c:a', 'aac',
        '-b:a', '192k',
        '-ac', '2',
        '-ar', '44100',
        '-f', 'mpegts',
        'pipe:1'
      ]);

      ffmpeg.stdout.pipe(segmentStream);

      ffmpeg.stderr.on('data', (data) => {
        console.error('FFmpeg stderr:', data.toString());
      });

      ffmpeg.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`FFmpeg exited with code ${code}`));
        }
      });

      resolve(segmentStream);
    } catch (error) {
      reject(error);
    }
  });
}

// Helper function to get audio duration
async function getAudioDuration(filePath: string): Promise<{ duration: number }> {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      filePath
    ]);

    let output = '';
    ffprobe.stdout.on('data', (data) => {
      output += data;
    });

    ffprobe.stderr.on('data', (data) => {
      console.error('FFprobe error:', data.toString());
    });

    ffprobe.on('close', (code) => {
      if (code === 0) {
        try {
          const info = JSON.parse(output);
          resolve({ duration: parseFloat(info.format.duration) });
        } catch (error) {
          reject(new Error('Failed to parse FFprobe output'));
        }
      } else {
        reject(new Error(`FFprobe exited with code ${code}`));
      }
    });
  });
}

// Public endpoint to get current track state
router.get('/current', async (_req: Request, res: Response) => {
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

    if (!currentTrack) {
      return res.json({ status: 'stopped', currentTrack: null });
    }

    // Format track for response
    const formattedTrack = {
      youtubeId: currentTrack.track.youtubeId,
      title: currentTrack.track.title,
      thumbnail: currentTrack.track.thumbnail,
      duration: currentTrack.track.duration,
      requestedBy: {
        id: currentTrack.user.id,
        username: currentTrack.user.username,
        avatar: currentTrack.user.avatar || undefined
      },
      requestedAt: currentTrack.requestedAt.toISOString()
    };

    res.json({
      status: client.player.getStatus(),
      currentTrack: formattedTrack,
      position: client.player.getPosition()
    });
  } catch (error) {
    console.error('Error getting current track:', error);
    res.status(500).json({ error: 'Failed to get current track' });
  }
});

export { router as musicRouter };
