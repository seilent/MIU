import express, { Request, Response } from 'express';
import fs from 'fs';
import { audioStreamRequestsCounter, audioStreamLatencyHistogram } from '../../metrics.js';
import { ApiErrors } from '../../utils/apiResponse.js';
import { optionalAuthMiddleware } from '../../middleware/auth.js';
import { getCurrentPlayingTrack, getAudioCache } from '../../utils/dbHelpers.js';
import { getDiscordClientSafe } from '../../utils/playerHelpers.js';

const router = express.Router();

/**
 * GET /stream - Main streaming endpoint
 * Handles range requests for better seeking support
 */
router.get('/stream', optionalAuthMiddleware, async (req: Request, res: Response) => {
  try {

    const client = getDiscordClientSafe();
    if (!client) {
      return ApiErrors.discordNotAvailable(res);
    }

    let currentTrack = await getCurrentPlayingTrack();
    
    // If no track found in database, fall back to Discord player state
    if (!currentTrack) {
      const player = client.player;
      const discordTrack = player.getCurrentTrack();
      
      if (!discordTrack) {
        return ApiErrors.noTrackPlaying(res);
      }
      
      // Create a mock currentTrack object for the streaming logic
      currentTrack = {
        track: {
          youtubeId: discordTrack.youtubeId,
          title: discordTrack.title || 'Unknown Title',
          duration: discordTrack.duration || 0
        }
      } as any;
    }
    
    // At this point currentTrack is guaranteed to exist
    if (!currentTrack) {
      return ApiErrors.noTrackPlaying(res);
    }

    // Get cached audio file
    const audioCache = await getAudioCache(currentTrack.track.youtubeId);
    if (!audioCache || !fs.existsSync(audioCache.filePath)) {
      return ApiErrors.audioNotFound(res);
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
    if (!res.headersSent) {
      ApiErrors.streamFailed(res);
    }
  }
});

/**
 * GET /position - Get current playback position
 */
router.get('/position', async (req: Request, res: Response) => {
  try {
    const client = getDiscordClientSafe();
    if (!client) {
      return ApiErrors.discordNotAvailable(res);
    }
    
    const currentTrack = await getCurrentPlayingTrack();

    res.json({
      position: client.player.getPosition(),
      duration: currentTrack?.track.duration || 0,
      timestamp: Date.now(),
      trackId: currentTrack?.track.youtubeId,
      title: currentTrack?.track.title,
      playbackRate: 1.0
    });
  } catch (error) {
    ApiErrors.positionFailed(res);
  }
});

export { router as streamingRouter };