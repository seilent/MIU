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
// Updated import to use the new player structure
import { getMusicPlayer } from '../discord/player/index.js';
// Import types from the new player structure
import { QueueItem as PlayerQueueItem, UserInfo as PlayerUserInfo } from '../discord/player/types.js';
import { RequestStatus, TrackStatus } from '../types/enums.js';
import { spawn } from 'child_process';
import getEnv from '../utils/env.js';
import crypto from 'crypto';
import { getThumbnailUrl } from '../utils/youtubeMusic.js';

const env = getEnv();

// Keep existing interfaces if they are still relevant for API responses
interface WebUser {
  id: string;
  username: string;
  discriminator: string;
  avatar: string | null;
}

// This interface might still be useful for formatting the final API response
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
  requestedAt: string; // Keep as ISO string for API
  isAutoplay: boolean;
  autoplaySource?: string; // Added from PlayerState
}

// Enhance SSE client interface
interface SSEClient {
  id: string;
  response: Response;
  lastEventId?: string;
}

// Helper function to format PlayerQueueItem for API response
function formatPlayerQueueItem(item: PlayerQueueItem): TrackResponse {
    return {
        youtubeId: item.youtubeId,
        title: item.title,
        thumbnail: item.thumbnail, // Already generated in PlayerStateManager
        duration: item.duration,
        requestedBy: {
            id: item.requestedBy.userId, // Map userId to id
            username: item.requestedBy.username,
            avatar: item.requestedBy.avatar
        },
        requestedAt: item.requestedAt.toISOString(),
        isAutoplay: item.isAutoplay,
        autoplaySource: item.autoplaySource
    };
}


// Store active SSE clients
export const sseClients = new Set<SSEClient>();

// Helper functions for SSE broadcasts
export function broadcastToClient(client: SSEClient, event: string, data: any) {
  try {
    // Ensure data is serializable (check for complex objects if issues arise)
    const jsonData = JSON.stringify(data);
    client.response.write(`event: ${event}\ndata: ${jsonData}\nid: ${Date.now()}\n\n`);
  } catch (error) {
    console.error(`Error broadcasting to client ${client.id}:`, error);
    sseClients.delete(client);
    if (!client.response.writableEnded) {
        client.response.end();
    }
  }
}

export function broadcast(event: string, data: any) {
  // console.log(`[SSE Broadcast] Event: ${event}, Clients: ${sseClients.size}`); // Debug log
  sseClients.forEach(client => {
    broadcastToClient(client, event, data);
  });
}

const router = Router();

// In-memory history queue (max 5 items) - This seems separate from player state, keep for now
const historyQueue: Array<{
  youtubeId: string;
  title: string;
  duration: number;
  requestedBy: {
    id: string;
    username: string;
    avatar: string | null; // Allow null avatar
  };
  requestedAt: Date;
  playedAt: Date;
  // skipped: boolean; // Add skipped flag if needed
}> = [];

// Function to add track to history (signature matches original call)
export function addToHistory(track: PlayerQueueItem, user: any, isAutoplay: boolean = false /*, skipped: boolean = false */) {
  const client = getDiscordClient();
  if (!client?.user) {
    console.error('Cannot add to history: Discord client not available');
    return; // Don't throw, just log and return
  }

  // Ensure track and user data are valid
  if (!track || !track.youtubeId || !track.title || typeof track.duration !== 'number') {
      console.error('Cannot add to history: Invalid track data provided.');
      return;
  }
   // Handle potential missing user info, especially for autoplay
   const requestedById = isAutoplay ? client.user.id : (user?.userId || 'unknown');
   const requestedByUsername = isAutoplay ? client.user.username : (user?.username || 'Unknown User');
   const requestedByAvatar = isAutoplay ? client.user.avatarURL() : (user?.avatar || null);


  const historyItem = {
    youtubeId: track.youtubeId,
    title: track.title,
    duration: track.duration,
    requestedBy: {
      id: requestedById,
      username: requestedByUsername,
      avatar: requestedByAvatar
    },
    requestedAt: new Date(track.requestedAt || Date.now()), // Ensure requestedAt is a Date
    playedAt: new Date(),
    // skipped: skipped // Store skipped status if needed later
  };

  // Add to front of queue
  historyQueue.unshift(historyItem);

  // Keep only last 5 items
  if (historyQueue.length > 5) {
    historyQueue.pop();
  }
  // Optionally broadcast history update via SSE
  // broadcast('historyUpdate', historyQueue.map(formatHistoryItem)); // Example
}

// Search endpoint - No changes needed, doesn't use player
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

// GET /queue - Use the new player state
router.get('/queue', (req, res) => {
   try {
        const player = getMusicPlayer(); // Use the new singleton getter
        const queue = player.getQueue(); // Get queue from the player
        res.json(queue.map(formatPlayerQueueItem)); // Format for API response
   } catch (error) {
       console.error('Error getting queue state:', error);
       res.status(500).json({ error: 'Failed to get queue state' });
   }
});

// POST /queue - Use the new player's play method
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

    const player = getMusicPlayer(); // Use the new singleton getter

    // Get full user info from database
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    // Call the new player's play method
    // Pass null for voiceState as it's a web request
    const playResult = await player.play(
        null,
        url, // Pass the original URL or ID
        user.id,
        { // Pass user info without ID
            username: user.username,
            discriminator: user.discriminator,
            avatar: user.avatar
        }
    );

    if (playResult.success) {
        console.log('\x1b[36m%s\x1b[0m', `[TRACK ADDED] 🎵 "${playResult.trackInfo?.title ?? 'Unknown Track'}" by ${user.username} (${user.id}) via web_request`);
        res.json(playResult); // Return the result from the player method
    } else {
        res.status(400).json({ error: playResult.message });
    }

  } catch (error) {
    console.error('Error adding to queue:', error);
    res.status(500).json({ error: 'Failed to add track to queue' });
  }
});

// GET /state - Simplified to use player state directly
router.get('/state', async (req: Request, res: Response) => {
  try {
    const player = getMusicPlayer(); // Use the new singleton getter
    const state = player.getState(); // Get the entire state

    if (!state) {
         // Should not happen if player is initialized, but handle defensively
         return res.status(500).json({ error: 'Player state not available' });
    }

    // Format the state for the API response
    const formattedState = {
        status: state.status,
        currentTrack: state.currentTrack ? formatPlayerQueueItem(state.currentTrack) : null,
        queue: state.queue.map(formatPlayerQueueItem),
        position: Math.floor(state.position), // Use state's position
        volume: state.volume,
        autoplayEnabled: state.autoplayEnabled
    };

    // Broadcast is handled internally by PlayerStateManager now, no need here.
    // broadcastPlayerState(formattedState); // REMOVED

    res.json(formattedState);
  } catch (error) {
    console.error('Error getting player state:', error);
    res.status(500).json({ error: 'Failed to get player state' });
  }
});

// POST /playback - Use new player methods
router.post('/playback', async (req: Request, res: Response) => {
  try {
    const { action } = req.body;
    if (action !== 'play' && action !== 'pause') {
      return res.status(400).json({ error: 'Invalid action' });
    }

    const player = getMusicPlayer(); // Use new getter

    let result: { success: boolean; message: string };
    if (action === 'play') {
      result = player.resume();
    } else {
      result = player.pause();
    }

    if (result.success) {
        res.json({ success: true });
    } else {
         res.status(400).json({ error: result.message }); // Return error message from player
    }

  } catch (error) {
    console.error('Error controlling playback:', error);
    res.status(500).json({ error: 'Failed to control playback' });
  }
});

// POST /skip - Use new player method
router.post('/skip', async (req: Request, res: Response) => {
  try {
    const player = getMusicPlayer(); // Use new getter
    const result = await player.skip(req.user?.id); // Pass user ID for logging/attribution if available

    if (result.success) {
        res.json({ success: true });
    } else {
         res.status(400).json({ error: result.message });
    }
  } catch (error) {
    console.error('Error skipping track:', error);
    res.status(500).json({ error: 'Failed to skip track' });
  }
});

// POST /ban - Use new player methods, but core logic remains similar
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

    const player = getMusicPlayer(); // Use new getter

    const { position: uiPosition, block_channel: blockChannel } = req.body;

    if (uiPosition !== undefined && typeof uiPosition === 'number' && uiPosition > 0) {
      // Ban a specific song in the queue by position
      const queue = player.getQueue(); // Use new method
      const position = uiPosition - 1; // 0-based index

      if (position < 0 || position >= queue.length) {
        return res.status(400).json({
          error: `Invalid position. Queue has ${queue.length} songs (positions 1-${queue.length}).`
        });
      }

      const trackToBan = queue[position];

      // Get track info to check channel
      // Use DatabaseService directly as BlockedContentManager handles blocking logic now
      // Corrected access to channel ID
      const trackInfo = await player['databaseService'].getTrackWithChannel(trackToBan.youtubeId); // Accessing private member for now, consider exposing needed info

      // Block the track using BlockedContentManager
      await player['blockedContentManager'].blockTrack(trackToBan.youtubeId, `Banned by admin ${userId}`); // Accessing private member

      // Block channel if requested
      let channelBlockMessage = '';
      // Corrected access to channel ID and use correct function name
      if (blockChannel && trackInfo?.channel?.id) {
         const channelResult = await blockChannel(trackInfo.channel.id, 'Banned along with track'); // Use existing blockChannel function
         channelBlockMessage = `\nAlso blocked channel "${channelResult.channelTitle}" with ${channelResult.tracksBlocked} tracks.`;
      }

      // Remove from player queue
      const removeResult = player.removeFromQueue(uiPosition); // Use the public method

      res.json({
        success: removeResult.success,
        message: removeResult.success ? `Banned song at position ${uiPosition}: ${trackToBan.title}${channelBlockMessage}` : `Failed to remove banned track from queue.`
      });
      return;
    }

    // Ban the currently playing song
    const currentTrack = player.getCurrentTrack(); // Use new method

    if (!currentTrack) {
      return res.status(400).json({ error: 'No track is currently playing.' });
    }

    // Get track info to check channel
    // Corrected access to channel ID
    const trackInfo = await player['databaseService'].getTrackWithChannel(currentTrack.youtubeId); // Accessing private member

    // Block the track
    await player['blockedContentManager'].blockTrack(currentTrack.youtubeId, `Banned by admin ${userId}`); // Accessing private member

    // Block channel if requested
    let channelBlockMessage = '';
     // Corrected access to channel ID and use correct function name
    if (blockChannel && trackInfo?.channel?.id) {
       const channelResult = await blockChannel(trackInfo.channel.id, 'Banned along with track'); // Use existing blockChannel function
       channelBlockMessage = `\nAlso blocked channel "${channelResult.channelTitle}" with ${channelResult.tracksBlocked} tracks.`;
    }

    // Skip the current track (this should now happen automatically if BlockedContentManager notifies correctly, or handle here)
    await player.skip(userId); // Explicitly skip

    res.json({
      success: true,
      message: `Banned and skipped: ${currentTrack.title}${channelBlockMessage}`
    });
  } catch (error) {
    console.error('Error banning track:', error);
    res.status(500).json({ error: 'Failed to ban track' });
  }
});

// Helper function for blocking channel (kept locally for now)
async function blockChannel(channelId: string, reason: string): Promise<{ success: boolean; channelTitle: string; tracksBlocked: number }> {
    try {
        // Mark channel as blocked
        const updatedChannel = await prisma.channel.update({
            where: { id: channelId },
            data: {
                isBlocked: true,
                blockedAt: new Date(),
                blockedReason: reason
            }
        });

        // Find all tracks associated with this channel
        const tracksToBlock = await prisma.track.findMany({
            where: { channelId: channelId }
        });

        // Block each track
        for (const track of tracksToBlock) {
            await applyBanPenalty(track.youtubeId); // Use existing ban penalty helper
        }

        console.log(`Blocked channel ${channelId} (${updatedChannel.title}) and ${tracksToBlock.length} tracks`);
        return {
            success: true,
            channelTitle: updatedChannel.title,
            tracksBlocked: tracksToBlock.length
        };
    } catch (error) {
        console.error(`Failed to block channel ${channelId}:`, error);
        throw error; // Re-throw to be caught by the endpoint handler
    }
}


// Helper function to clean up blocked songs from playlists and recommendations
// This function seems generally useful, keep it exported but ensure it uses correct logic
export async function cleanupBlockedSong(youtubeId: string) {
  try {
    // 1. Remove from all default playlists
    await prisma.defaultPlaylistTrack.deleteMany({
      where: {
        trackId: youtubeId
      }
    });

    // 2. Remove from YouTube recommendations pool
    await prisma.youtubeRecommendation.deleteMany({
      where: {
        OR: [
          { youtubeId: youtubeId },  // Remove if it's a recommendation
          { seedTrackId: youtubeId } // Remove recommendations that used this as seed
        ]
      }
    });

    // 3. Delete audio cache if exists
    const audioCache = await prisma.audioCache.findUnique({
      where: { youtubeId }
    });
    if (audioCache) {
      try {
        await fs.promises.unlink(audioCache.filePath);
      } catch (error: any) {
         if (error.code !== 'ENOENT') { // Ignore if file doesn't exist
            console.error(`Failed to delete audio file for ${youtubeId}:`, error);
         }
      }
      await prisma.audioCache.delete({
        where: { youtubeId }
      });
    }

    // 4. Delete thumbnail cache if exists
    const thumbnailCache = await prisma.thumbnailCache.findUnique({
      where: { youtubeId }
    });
    if (thumbnailCache) {
      try {
        await fs.promises.unlink(thumbnailCache.filePath);
      } catch (error: any) {
         if (error.code !== 'ENOENT') { // Ignore if file doesn't exist
            console.error(`Failed to delete thumbnail file for ${youtubeId}:`, error);
         }
      }
      await prisma.thumbnailCache.delete({
        where: { youtubeId }
      });
    }

    // 5. Update all requests for this track to SKIPPED status
    await prisma.request.updateMany({
      where: {
        youtubeId: youtubeId,
        status: {
          in: [RequestStatus.PENDING, RequestStatus.QUEUED, RequestStatus.PLAYING]
        }
      },
      data: {
        status: RequestStatus.SKIPPED
      }
    });

    // 6. Delete track state if exists - Check first to avoid errors
    const trackState = await prisma.trackState.findUnique({
      where: { youtubeId }
    });
    if (trackState) {
      await prisma.trackState.delete({
        where: { youtubeId }
      });
    }

    // Removed individual song cleanup logging to reduce verbosity
  } catch (error) {
    console.error('Error cleaning up blocked song:', error);
  }
}

// Helper function to apply a ban penalty to a track - Keep as is
async function applyBanPenalty(youtubeId: string) {
  try {
    // Apply a -10 score penalty to the track
    await prisma.$transaction([
      // Update global track stats with a heavy penalty
      prisma.track.update({ // Use update instead of $executeRaw for type safety if possible
        where: { youtubeId },
        data: {
            globalScore: { decrement: 10 },
            status: TrackStatus.BLOCKED // Use enum
        }
      }),
      // Also update all user stats for this track with a penalty
      prisma.userTrackStats.updateMany({
          where: { youtubeId },
          data: {
              personalScore: { decrement: 5 }
          }
      })
    ]);

    // Clean up the blocked song from playlists and recommendations
    await cleanupBlockedSong(youtubeId);
  } catch (error) {
    console.error('Error applying ban penalty:', error);
    throw error;
  }
}

// POST /volume - Use new player method
router.post('/volume', async (req, res) => {
  try {
    const { volume } = req.body;
    if (typeof volume !== 'number' || volume < 0 || volume > 1) {
      return res.status(400).json({ error: 'Invalid volume' });
    }

    const player = getMusicPlayer(); // Use new getter
    const result = player.setVolume(volume);

     if (result.success) {
        res.json({ success: true });
    } else {
         res.status(400).json({ error: result.message });
    }
  } catch (error) {
    console.error('Error setting volume:', error);
    res.status(500).json({ error: 'Failed to set volume' });
  }
});

// POST /autoplay - Use new player method
router.post('/autoplay', async (req, res) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'Invalid enabled state' });
    }

    const player = getMusicPlayer(); // Use new getter
    const result = player.setAutoplay(enabled);

    console.log('\x1b[33m%s\x1b[0m', `[AUTOPLAY] ${enabled ? '✅ Enabled' : '❌ Disabled'} by web_interface`);

    if (result.success) {
        res.json({ success: true });
    } else {
         res.status(400).json({ error: result.message });
    }
  } catch (error) {
    console.error('Error toggling autoplay:', error);
    res.status(500).json({ error: 'Failed to toggle autoplay' });
  }
});

// Shared stream controller - Keep as is, doesn't interact with player directly
const activeStreams = new Map<string, {
  stream: Readable;
  listeners: number;
  filePath: string;
}>();

// Maintain a map of token to session details - Keep as is
const streamSessions = new Map<string, {
  youtubeId: string;
  timestamp: number;
  filePath: string;
}>();

// Clean up old sessions periodically (every 15 minutes) - Keep as is
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of streamSessions.entries()) {
    // Remove sessions older than 1 hour
    if (now - session.timestamp > 3600000) {
      streamSessions.delete(token);
    }
  }
}, 900000);

// Generate a secure URL-safe token for streaming - Keep as is
function generateStreamToken(length: number = 32): string {
  const bytes = crypto.randomBytes(length);
  return bytes.toString('base64url');
}

// New secure direct streaming endpoint - Update to use new player methods for position etc.
router.get('/secure-stream/:token', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { token } = req.params;
    const session = streamSessions.get(token);

    if (!session) {
      return res.status(404).json({ error: 'Stream not found or expired' });
    }

    const { filePath, youtubeId } = session;

    if (!fs.existsSync(filePath)) {
      streamSessions.delete(token); // Clean up invalid session
      return res.status(404).json({ error: 'Audio file not found' });
    }

    const player = getMusicPlayer(); // Use new getter
    const currentTrack = player.getCurrentTrack(); // Get current track from player

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
        'Content-Disposition': `attachment; filename="audio-${Math.random().toString(36).substring(2, 10)}.bin"`,
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        'Surrogate-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'X-XSS-Protection': '1; mode=block',
        'X-Initial-Position': player.getPosition(), // Use new player method
        'X-Playback-Start': Date.now(),
        'X-Track-Id': youtubeId,
        'Access-Control-Expose-Headers': 'X-Initial-Position, X-Playback-Start, X-Track-Id, Accept-Ranges, Content-Length, Content-Range'
      });

      audioStreamRequestsCounter.inc({ type: 'secure-range' });
      const startTime = Date.now();

      req.on('close', () => {
        file.destroy();
        const latency = (Date.now() - startTime) / 1000;
        audioStreamLatencyHistogram.observe(latency);
      });

      file.pipe(res);
    } else {

      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': 'audio/mp4',
        'Content-Disposition': `attachment; filename="audio-${Math.random().toString(36).substring(2, 10)}.bin"`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        'Surrogate-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'X-XSS-Protection': '1; mode=block',
        'X-Initial-Position': player.getPosition(), // Use new player method
        'X-Playback-Start': Date.now(),
        'X-Track-Id': youtubeId,
        'Access-Control-Expose-Headers': 'X-Initial-Position, X-Playback-Start, X-Track-Id, Accept-Ranges, Content-Length'
      });

      audioStreamRequestsCounter.inc({ type: 'secure-full' });
      const startTime = Date.now();
      const file = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });

      req.on('close', () => {
        file.destroy();
        const latency = (Date.now() - startTime) / 1000;
        audioStreamLatencyHistogram.observe(latency);
      });

      file.pipe(res);
    }
  } catch (error) {
    console.error('Secure stream error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Stream failed' });
    }
  }
});

// Endpoint to get secure stream token for a track - Keep as is
router.get('/secure-token/:youtubeId', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { youtubeId } = req.params;

    // Get cached audio file
    const audioCache = await prisma.audioCache.findUnique({
      where: { youtubeId }
    });

    if (!audioCache || !fs.existsSync(audioCache.filePath)) {
       // Try to cache it if missing? Or just return 404? Let's return 404 for now.
       console.warn(`[SecureToken] Audio not found in cache for ${youtubeId}. Cannot generate token.`);
       // Optionally trigger caching:
       // const player = getMusicPlayer();
       // player['cacheManager'].ensureAudioCached(youtubeId).catch(e => console.error("BG Cache failed", e));
      return res.status(404).json({ error: 'Audio not found or not cached yet.' });
    }

    // Generate a token
    const token = generateStreamToken();

    // Store session information
    streamSessions.set(token, {
      youtubeId,
      timestamp: Date.now(),
      filePath: audioCache.filePath
    });

    // Return the token
    res.json({ token });
  } catch (error) {
    console.error('Secure token generation error:', error);
    res.status(500).json({ error: 'Failed to generate secure token' });
  }
});

// Old /stream endpoint - Update to use new player methods
router.get('/stream', async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const player = getMusicPlayer(); // Use new getter
    const currentTrack = player.getCurrentTrack(); // Use new method

    if (!currentTrack) {
      return res.status(404).json({ error: 'No track playing' });
    }

    // Get cached audio file
    const audioCache = await prisma.audioCache.findUnique({
      where: { youtubeId: currentTrack.youtubeId }
    });

    if (!audioCache || !fs.existsSync(audioCache.filePath)) {
       // Optionally trigger caching here
       player['cacheManager'].ensureAudioCached(currentTrack.youtubeId).catch(e => console.error("BG Cache failed", e));
       return res.status(404).json({ error: 'Audio not found or not cached yet.' });
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
        'X-Initial-Position': player.getPosition(), // Use new method
        'X-Playback-Start': Date.now(),
        'X-Track-Id': currentTrack.youtubeId,
        'X-Track-Duration': currentTrack.duration,
        'Access-Control-Expose-Headers': 'X-Initial-Position, X-Playback-Start, X-Track-Id, X-Track-Duration, Accept-Ranges, Content-Length, Content-Range'
      });

      audioStreamRequestsCounter.inc({ type: 'stream' });
      const startTime = Date.now();

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
        'X-Initial-Position': player.getPosition(), // Use new method
        'X-Playback-Start': Date.now(),
        'X-Track-Id': currentTrack.youtubeId,
        'X-Track-Duration': currentTrack.duration,
        'Access-Control-Expose-Headers': 'X-Initial-Position, X-Playback-Start, X-Track-Id, X-Track-Duration, Accept-Ranges, Content-Length'
      });

      audioStreamRequestsCounter.inc({ type: 'stream' });
      const startTime = Date.now();
      const file = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });

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

// Enhanced position endpoint - Use new player methods
router.get('/position', async (req: Request, res: Response) => {
  try {
    const player = getMusicPlayer(); // Use new getter
    const currentTrack = player.getCurrentTrack(); // Use new method

    res.json({
      position: player.getPosition(), // Use new method
      duration: currentTrack?.duration || 0,
      timestamp: Date.now(),
      trackId: currentTrack?.youtubeId,
      title: currentTrack?.title,
      playbackRate: 1.0
    });
  } catch (error) {
    console.error('Position error:', error);
    res.status(500).json({ error: 'Failed to get position' });
  }
});

// History endpoint - Keep as is (uses separate historyQueue)
router.get('/history', async (_req: Request, res: Response) => {
  try {
    const client = getDiscordClient();
    if (!client?.user) {
      return res.status(500).json({ error: 'Discord client not available' });
    }

    // Format tracks for response
    const formattedTracks = historyQueue.map(track => ({
      youtubeId: track.youtubeId,
      title: track.title,
      thumbnail: getThumbnailUrl(track.youtubeId),
      duration: track.duration,
      requestedBy: {
        id: track.requestedBy.id,
        username: track.requestedBy.username,
        avatar: track.requestedBy.avatar
      },
      requestedAt: track.requestedAt.toISOString(),
      playedAt: track.playedAt.toISOString(),
      isAutoplay: track.requestedBy.id === client.user?.id
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

// Health check - Keep as is
router.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

// SSE endpoint - Update to use new player methods
router.get('/state/live', (req: Request, res: Response) => {
  const cleanup = (keepAliveInterval?: NodeJS.Timeout) => {
    if (keepAliveInterval) clearInterval(keepAliveInterval);
    if (client) sseClients.delete(client);
    if (!res.writableEnded) {
      try {
        res.end();
      } catch (error) {
        console.error(`Error ending SSE connection:`, error);
      }
    }
  };

  let client: SSEClient | undefined;
  let keepAliveInterval: NodeJS.Timeout | undefined;

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
    res.flushHeaders(); // Flush headers immediately

    const clientId = Math.random().toString(36).substring(7);
    client = {
      id: clientId,
      response: res,
      lastEventId: req.headers['last-event-id'] as string
    };

    // Send initial state using new player methods
    const player = getMusicPlayer(); // Use new getter
    const state = player.getState(); // Get current state

    const initialState = {
        status: state?.status ?? 'idle',
        currentTrack: state?.currentTrack ? formatPlayerQueueItem(state.currentTrack) : null,
        queue: state?.queue.map(formatPlayerQueueItem) ?? [],
        position: Math.floor(state?.position ?? 0),
        volume: state?.volume ?? 1.0,
        autoplayEnabled: state?.autoplayEnabled ?? true
    };

    broadcastToClient(client, 'state', initialState);

    // Add client to active clients
    sseClients.add(client);

    // Set up keep-alive interval
    keepAliveInterval = setInterval(() => {
      if (!res.writableEnded) {
        res.write('event: heartbeat\ndata: {}\n\n');
      } else {
        cleanup(keepAliveInterval);
      }
    }, 30000);

    // Handle client disconnect
    req.on('close', () => {
      console.log(`SSE client ${clientId} disconnected`);
      cleanup(keepAliveInterval);
    });

    // Handle errors
    res.on('error', (error) => {
      console.error(`SSE connection error for client ${clientId}:`, error);
      cleanup(keepAliveInterval);
    });

  } catch (error) {
    console.error('Error in SSE connection:', error);
    cleanup(keepAliveInterval); // Ensure cleanup on error
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to establish SSE connection' });
    }
  }
});

// Update the player state broadcast function (already seems correct)
export function broadcastPlayerState(data: any) {
  // Format the data before broadcasting
   const formattedData = {
        status: data.status,
        currentTrack: data.currentTrack ? formatPlayerQueueItem(data.currentTrack) : null,
        queue: data.queue.map(formatPlayerQueueItem),
        position: Math.floor(data.position),
        volume: data.volume,
        autoplayEnabled: data.autoplayEnabled
    };
  broadcast('state', formattedData);
}

// HLS Endpoints - Keep as is
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

// Helper function to create segment stream - Keep as is
async function createSegmentStream(filePath: string, startTime: number, duration: number): Promise<Readable> {
  return new Promise((resolve, reject) => {
    try {
      const segmentStream = new PassThrough();
      const ffmpegProcess = spawn('ffmpeg', [ // Renamed variable
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

      ffmpegProcess.stdout.pipe(segmentStream);

      ffmpegProcess.stderr.on('data', (data) => {
        console.error('FFmpeg stderr:', data.toString());
      });

      ffmpegProcess.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`FFmpeg exited with code ${code}`));
        }
        // Don't end the PassThrough stream here, let the piping handle it
      });

       ffmpegProcess.on('error', (err) => { // Handle spawn errors
           reject(err);
       });

      resolve(segmentStream);
    } catch (error) {
      reject(error);
    }
  });
}

// Helper function to get audio duration - Keep as is
async function getAudioDuration(filePath: string): Promise<{ duration: number }> {
  return new Promise((resolve, reject) => {
    const ffprobeProcess = spawn('ffprobe', [ // Renamed variable
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      filePath
    ]);

    let output = '';
    ffprobeProcess.stdout.on('data', (data) => {
      output += data;
    });

    ffprobeProcess.stderr.on('data', (data) => {
      console.error('FFprobe error:', data.toString());
    });

    ffprobeProcess.on('error', (err) => { // Handle spawn errors
        reject(err);
    });

    ffprobeProcess.on('close', (code) => {
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

// Public endpoint to get current track state - Simplify using player state
router.get('/current', async (_req: Request, res: Response) => {
  try {
    const player = getMusicPlayer(); // Use new getter
    const state = player.getState(); // Get current state

    if (!state || !state.currentTrack) {
      return res.json({ status: 'idle', currentTrack: null, position: 0 });
    }

    // Format track for response
    const formattedTrack = formatPlayerQueueItem(state.currentTrack);

    res.json({
      status: state.status,
      currentTrack: formattedTrack,
      position: Math.floor(state.position)
    });
  } catch (error) {
    console.error('Error getting current track:', error);
    res.status(500).json({ error: 'Failed to get current track' });
  }
});

// Block tracks based on seedTrackId - Keep as is (DB interaction)
router.post('/block-by-seed', async (req: Request, res: Response) => {
  try {
    const { seedTrackId } = req.body;

    if (!seedTrackId) {
      return res.status(400).json({ error: 'seedTrackId is required' });
    }

    // Get all tracks from YoutubeRecommendation with this seedTrackId
    const recommendations = await prisma.youtubeRecommendation.findMany({
      where: {
        seedTrackId: seedTrackId
      },
      select: {
        youtubeId: true
      }
    });

    if (recommendations.length === 0) {
      return res.status(404).json({ error: 'No recommendations found for this seed track' });
    }

    // Get all youtubeIds from recommendations
    const youtubeIds = recommendations.map(rec => rec.youtubeId);

    // Update all tracks to BLOCKED status and apply ban penalty
    await prisma.$transaction([
        prisma.track.updateMany({
            where: { youtubeId: { in: youtubeIds } },
            data: { status: TrackStatus.BLOCKED, globalScore: { decrement: 10 } }
        }),
        prisma.userTrackStats.updateMany({
            where: { youtubeId: { in: youtubeIds } },
            data: { personalScore: { decrement: 5 } }
        })
    ]);


    // Clean up blocked songs from playlists and recommendations
    for (const youtubeId of youtubeIds) {
      await cleanupBlockedSong(youtubeId);
    }

    res.json({
      success: true,
      message: `Blocked ${youtubeIds.length} tracks from seed track ${seedTrackId}`,
      blockedTracks: youtubeIds
    });
  } catch (error) {
    console.error('Error blocking tracks by seed:', error);
    res.status(500).json({ error: 'Failed to block tracks' });
  }
});

export { router as musicRouter };
