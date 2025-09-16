import express, { Request, Response } from 'express';
import fs from 'fs';
import { audioStreamRequestsCounter, audioStreamLatencyHistogram } from '../../metrics.js';
import { ApiErrors } from '../../utils/apiResponse.js';
import { getCurrentPlayingTrack, getAudioCache } from '../../utils/dbHelpers.js';
import { getDiscordClientSafe } from '../../utils/playerHelpers.js';
import { getThumbnailUrl } from '../../utils/youtubeMusic.js';
import logger from '../../utils/logger.js';

const router = express.Router();

interface TrackInfo {
  youtubeId: string;
  title: string;
  thumbnail: string;
  duration: number;
  requestedBy: {
    id: string;
    username: string;
    avatar?: string;
  };
}

interface MetadataUpdate {
  timestamp: number;
  track: TrackInfo | null;
  position: number;
  status: 'playing' | 'paused' | 'stopped';
}

// Store active minimal stream clients
const minimalStreamClients = new Map<string, {
  response: Response;
  audioStream?: fs.ReadStream;
  metadataInterval?: NodeJS.Timeout;
  clientId: string;
}>();

/**
 * GET /minimal-stream - Minimal read-only audio stream with embedded metadata
 * No authentication required - guests can listen
 * Client handles play/pause locally, server just provides the stream
 */
router.get('/minimal-stream', async (req: Request, res: Response) => {
  const clientId = Math.random().toString(36).substring(7);

  const cleanup = () => {
    const client = minimalStreamClients.get(clientId);
    if (client) {
      if (client.audioStream) {
        client.audioStream.destroy();
      }
      if (client.metadataInterval) {
        clearInterval(client.metadataInterval);
      }
      minimalStreamClients.delete(clientId);
    }
  };

  try {
    const client = getDiscordClientSafe();
    if (!client) {
      return ApiErrors.discordNotAvailable(res);
    }

    // Set up HTTP headers for streaming with metadata
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'X-Stream-Type': 'minimal-audio-metadata',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'X-Stream-Type',
      'Transfer-Encoding': 'chunked'
    });

    // Store client information
    minimalStreamClients.set(clientId, {
      response: res,
      clientId
    });

    // Send initial metadata
    await sendMetadataUpdate(clientId);

    // Start audio streaming
    await startAudioStream(clientId);

    // Set up periodic metadata updates (every 3 seconds)
    const client_data = minimalStreamClients.get(clientId);
    if (client_data) {
      client_data.metadataInterval = setInterval(async () => {
        await sendMetadataUpdate(clientId);
      }, 3000);
    }

    // Handle client disconnect
    req.on('close', () => {
      logger.info(`Minimal stream client ${clientId} disconnected`);
      cleanup();
    });

    // Handle errors
    res.on('error', (error) => {
      logger.error(`Minimal stream error for client ${clientId}:`, error);
      cleanup();
    });

    // Track metrics
    audioStreamRequestsCounter.inc({ type: 'minimal-stream' });

  } catch (error) {
    logger.error('Minimal stream error:', error);
    cleanup();
    if (!res.headersSent) {
      ApiErrors.streamFailed(res);
    }
  }
});

/**
 * Send metadata update to client
 */
async function sendMetadataUpdate(clientId: string): Promise<void> {
  const clientData = minimalStreamClients.get(clientId);
  if (!clientData) return;

  try {
    const client = getDiscordClientSafe();
    if (!client) return;

    // Get current track directly from Discord player, not from database
    const discordTrack = client.player.getCurrentTrack();
    let trackInfo: TrackInfo | null = null;

    if (discordTrack) {
      trackInfo = {
        youtubeId: discordTrack.youtubeId,
        title: discordTrack.title || 'Unknown Title',
        thumbnail: getThumbnailUrl(discordTrack.youtubeId),
        duration: discordTrack.duration || 0,
        requestedBy: {
          id: discordTrack.requestedBy?.userId || 'unknown',
          username: discordTrack.requestedBy?.username || 'Unknown User',
          avatar: discordTrack.requestedBy?.avatar || undefined
        }
      };
    }

    const metadata: MetadataUpdate = {
      timestamp: Date.now(),
      track: trackInfo,
      position: client.player.getPosition(),
      status: client.player.getStatus() as 'playing' | 'paused' | 'stopped'
    };

    // Send metadata as a prefixed chunk
    const metadataJson = JSON.stringify(metadata);
    const metadataLength = Buffer.byteLength(metadataJson, 'utf8');

    // Format: [META][4-byte length][JSON metadata]
    const metadataHeader = Buffer.alloc(8);
    metadataHeader.write('META', 0, 4, 'ascii');
    metadataHeader.writeUInt32BE(metadataLength, 4);

    clientData.response.write(metadataHeader);
    clientData.response.write(metadataJson, 'utf8');

  } catch (error) {
    logger.error(`Error sending metadata to client ${clientId}:`, error);
    // Don't throw, just log and continue
  }
}

/**
 * Start streaming audio data to client
 */
async function startAudioStream(clientId: string): Promise<void> {
  const clientData = minimalStreamClients.get(clientId);
  if (!clientData) return;

  try {
    const client = getDiscordClientSafe();
    if (!client) return;

    // Get current track directly from Discord player
    const discordTrack = client.player.getCurrentTrack();
    if (!discordTrack) {
      // Send empty audio header if no track is playing
      const audioHeader = Buffer.alloc(8);
      audioHeader.write('AUDI', 0, 4, 'ascii');
      audioHeader.writeUInt32BE(0, 4); // 0 length indicates no audio
      clientData.response.write(audioHeader);
      return;
    }

    const audioCache = await getAudioCache(discordTrack.youtubeId);
    if (!audioCache || !fs.existsSync(audioCache.filePath)) {
      // Send empty audio header if file not found
      const audioHeader = Buffer.alloc(8);
      audioHeader.write('AUDI', 0, 4, 'ascii');
      audioHeader.writeUInt32BE(0, 4);
      clientData.response.write(audioHeader);
      return;
    }

    const filePath = audioCache.filePath;
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;

    // Send audio header
    const audioHeader = Buffer.alloc(8);
    audioHeader.write('AUDI', 0, 4, 'ascii');
    audioHeader.writeUInt32BE(fileSize, 4);
    clientData.response.write(audioHeader);

    // Create and start audio stream
    const audioStream = fs.createReadStream(filePath, {
      highWaterMark: 32 * 1024 // 32KB chunks for smooth streaming
    });

    clientData.audioStream = audioStream;

    audioStream.on('data', (chunk) => {
      if (clientData.response.writable) {
        clientData.response.write(chunk);
      }
    });

    audioStream.on('end', () => {
      logger.info(`Audio stream ended for client ${clientId}`);
    });

    audioStream.on('error', (error) => {
      logger.error(`Audio stream error for client ${clientId}:`, error);
    });

  } catch (error) {
    logger.error(`Error starting audio stream for client ${clientId}:`, error);
  }
}

/**
 * GET /minimal-status - Get current status for minimal clients
 * Public endpoint - no authentication required
 */
router.get('/minimal-status', async (req: Request, res: Response) => {
  try {
    const client = getDiscordClientSafe();
    if (!client) {
      return res.json({
        status: 'stopped',
        track: null,
        position: 0,
        timestamp: Date.now()
      });
    }

    // Get current track directly from Discord player, not from database
    const discordTrack = client.player.getCurrentTrack();
    let trackInfo: TrackInfo | null = null;

    if (discordTrack) {
      trackInfo = {
        youtubeId: discordTrack.youtubeId,
        title: discordTrack.title || 'Unknown Title',
        thumbnail: getThumbnailUrl(discordTrack.youtubeId),
        duration: discordTrack.duration || 0,
        requestedBy: {
          id: discordTrack.requestedBy?.userId || 'unknown',
          username: discordTrack.requestedBy?.username || 'Unknown User',
          avatar: discordTrack.requestedBy?.avatar || undefined
        }
      };
    }

    res.json({
      status: client.player.getStatus(),
      track: trackInfo,
      position: client.player.getPosition(),
      timestamp: Date.now(),
      activeClients: minimalStreamClients.size
    });

  } catch (error) {
    logger.error('Error getting minimal status:', error);
    res.status(500).json({ error: 'Failed to get status' });
  }
});

export { router as minimalStreamRouter };