import { Client, VoiceState, VoiceChannel } from 'discord.js';
import { 
  joinVoiceChannel, 
  createAudioPlayer, 
  createAudioResource,
  AudioPlayer,
  VoiceConnection,
  AudioPlayerStatus,
  StreamType,
  demuxProbe,
  NoSubscriberBehavior,
  AudioResource,
  DiscordGatewayAdapterCreator,
  VoiceConnectionStatus,
  getVoiceConnection
} from '@discordjs/voice';
import path from 'path';
import ffmpeg from 'ffmpeg-static';
import { createReadStream } from 'fs';
import { Readable, PassThrough } from 'stream';
import { prisma } from '../db.js';
import { getYoutubeInfo, downloadYoutubeAudio, getYoutubeRecommendations, getAudioFileDuration } from '../utils/youtube.js';
import fs from 'fs';
import { youtube } from '../utils/youtube.js';
import { Prisma } from '@prisma/client';
import jwt from 'jsonwebtoken';
import { spawn } from 'child_process';
import { TrackingService } from '../tracking/service.js';
import { RecommendationEngine } from '../recommendation/engine.js';
import { ChildProcessWithoutNullStreams } from 'child_process';
import { resolveYouTubeMusicId } from '../utils/youtubeMusic.js';
import { RequestStatus } from '@prisma/client';

// Define RequestStatus enum to match Prisma schema
const RequestStatus = {
  PENDING: 'PENDING',
  PLAYING: 'PLAYING',
  QUEUED: 'QUEUED',
  COMPLETED: 'COMPLETED',
  DOWNLOADING: 'DOWNLOADING',
  SKIPPED: 'SKIPPED'
} as const;

type RequestStatus = typeof RequestStatus[keyof typeof RequestStatus];

// Define PlaylistMode enum to match Prisma schema
const PlaylistMode = {
  LINEAR: 'LINEAR',
  POOL: 'POOL'
} as const;

type PlaylistMode = typeof PlaylistMode[keyof typeof PlaylistMode];

interface UserInfo {
  username: string;
  discriminator: string;
  avatar?: string | null;
}

interface QueueItem {
  youtubeId: string;
  title: string;
  thumbnail: string;
  duration: number;
  requestedBy: {
    userId: string;
    username: string;
    avatar?: string;
  };
  requestedAt: Date;
  isDownloading?: boolean;
  isAutoplay?: boolean;
}

interface QueuedTrack {
  youtubeId: string;
  title: string;
  thumbnail: string;
  duration: number;
  requestedBy: {
    userId: string;
    username: string;
    avatar?: string;
  };
  queuePosition?: number;
  willPlayNext: boolean;
  isPlaying: boolean;
}

interface PlaylistWithTracks {
  id: string;
  name: string;
  active: boolean;
  mode: PlaylistMode;
  tracks: Array<{
    trackId: string;
    position: number;
  }>;
}

interface ScoredTrack {
  youtubeId: string;
  score: number;
}

let defaultPlaylist: PlaylistWithTracks | null = null;

// Configure FFmpeg path
if (ffmpeg) {
  process.env.FFMPEG_PATH = ffmpeg as unknown as string;
  console.log('Using FFmpeg from:', ffmpeg);
} else {
  console.error('FFmpeg not found in ffmpeg-static package');
}

const API_BASE_URL = process.env.API_URL || 'http://localhost:3000';

type Request = PrismaRequest;
type Track = PrismaTrack;

// Add singleton instance and getter
let instance: Player | null = null;

export function getPlayer(): Player {
  if (!instance) {
    throw new Error('Player not initialized');
  }
  return instance;
}

export function initializePlayer(
  client: Client,
  trackingService: TrackingService,
  recommendationEngine: RecommendationEngine
): Player {
  if (!instance) {
    instance = new Player(client, trackingService, recommendationEngine);
  }
  return instance;
}

// Define types for raw queries
type TrackResult = {
  youtubeId: string;
  title: string;
  thumbnail: string;
  duration: number;
  globalScore: number;
  playCount: number;
  skipCount: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type TrackIdResult = { 
  youtubeId: string 
};

interface QueuedTrack {
  title: string;
  thumbnail: string | null;
  duration: number;
  queuePosition?: number;
  willPlayNext?: boolean;
}

export class Player {
  private client: Client;
  private audioPlayer: AudioPlayer;
  private connection?: VoiceConnection;
  private queue: QueueItem[] = [];
  private autoplayQueue: QueueItem[] = []; // Separate queue for autoplay tracks
  private currentTrack?: QueueItem;
  private timeout?: NodeJS.Timeout;
  private autoplayEnabled: boolean = true;
  private playedTracks: Map<string, number> = new Map(); // Track ID -> Timestamp for ALL tracks
  private readonly PLAYED_TRACKS_EXPIRY = 3600000; // 1 hour in milliseconds
  private readonly AUTOPLAY_TRACKS_EXPIRY = 18000000; // 5 hours in milliseconds (reverted back to 5 hours)
  private readonly MAX_DURATION = 420; // 7 minutes in seconds
  private retryCount: number = 0;
  private maxRetries: number = 3;
  private retryDelay: number = 1000;
  private readonly AUTOPLAY_QUEUE_SIZE = 5;
  private readonly AUTOPLAY_BUFFER_SIZE = 3;
  private readonly AUTOPLAY_PREFETCH_THRESHOLD = 2;
  private readonly PLAYLIST_EXHAUSTED_THRESHOLD = 0.8;
  private _youtubeApiCalls?: {
    count: number;
    resetTime: number;
  };
  private trackingService: TrackingService;
  private recommendationEngine: RecommendationEngine;
  private currentPlaylistPosition = 0;
  private currentPlaylistId?: string;
  private youtubeRecommendationsPool: { youtubeId: string }[] = [];
  private volume: number = 1;
  private readonly USER_LEAVE_TIMEOUT = 10000; // 10 seconds
  private userCheckInterval?: NodeJS.Timeout;
  private defaultVoiceChannelId: string;
  private defaultGuildId: string;
  private hasActiveUsers: boolean = false;
  private hasWebPresence: boolean = false;
  private isPlayerPaused: boolean = false;
  private downloadingTracks = new Set<string>();
  private activeAudioStreams: Set<NodeJS.WritableStream> = new Set();

  constructor(
    client: Client,
    trackingService: TrackingService,
    recommendationEngine: RecommendationEngine
  ) {
    this.client = client;
    this.trackingService = trackingService || {
      trackUserLeave: () => Promise.resolve(),
      getUserFavoriteTracks: () => Promise.resolve([])
    };
    this.recommendationEngine = recommendationEngine || {
      getRecommendationsForUsers: () => Promise.resolve([])
    };
    this.audioPlayer = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Play
      }
    });
    
    // Get default voice channel configuration
    this.defaultVoiceChannelId = process.env.DISCORD_DEFAULT_VOICE_CHANNEL_ID || '';
    this.defaultGuildId = process.env.DISCORD_DEFAULT_GUILD_ID || '';
    
    if (!this.defaultVoiceChannelId || !this.defaultGuildId) {
      console.warn('Voice channel configuration missing. Set DISCORD_DEFAULT_VOICE_CHANNEL_ID and DISCORD_DEFAULT_GUILD_ID in .env');
    }

    // Reset played tracks and cleanup stuck states on server restart
    this.resetAutoplayTracking();
    this.cleanupStuckStates();

    // Check for active playlist on startup
    this.initializeActivePlaylist().catch(error => {
      console.error('Failed to initialize active playlist:', error);
    });

    // Handle audio player state changes
    this.audioPlayer.on('stateChange', async (oldState, newState) => {
      console.log(`Audio player state changed: ${oldState.status} -> ${newState.status} | Track: ${this.currentTrack?.title}`);

      if (newState.status === AudioPlayerStatus.Idle && oldState.status !== AudioPlayerStatus.Idle) {
        await this.onTrackFinish();
      } else if (newState.status === AudioPlayerStatus.Playing) {
        await this.updatePlayerState();
      }
    });

    this.audioPlayer.on('error', error => {
      console.error('Audio player error:', error);
      this.handlePlaybackError();
    });

    // Wait for client to be ready before initializing voice connection
    if (this.client.isReady()) {
      this.initializeVoiceConnection();
    } else {
      this.client.once('ready', () => {
        this.initializeVoiceConnection();
      });
    }

    // Start user presence check interval
    this.startUserPresenceCheck();
  }

  private async initializeVoiceConnection() {
    if (!this.defaultVoiceChannelId || !this.defaultGuildId) return;

    try {
      // Try to get guild from cache first
      let guild = this.client.guilds.cache.get(this.defaultGuildId);
      
      // If not in cache and client is ready, try to fetch
      if (!guild && this.client.isReady()) {
        try {
          guild = await this.client.guilds.fetch(this.defaultGuildId);
        } catch (error) {
          // Only log error if it's not a token-related issue during startup
          if (!(error instanceof Error && error.message.includes('token'))) {
            console.error('Failed to fetch guild:', error);
          }
          return;
        }
      }

      if (!guild) {
        console.log('Waiting for guild to be available...');
        return;
      }

      const channel = await this.client.channels.fetch(this.defaultVoiceChannelId);
      if (!channel?.isVoiceBased()) {
        console.error('Voice channel not found or is not a voice channel');
        return;
      }

      // Check if we already have a valid connection to this channel
      if (this.connection?.joinConfig.channelId === channel.id && 
          this.connection?.state.status !== 'destroyed' &&
          this.connection?.state.status !== 'disconnected') {
        console.log('Already connected to the correct voice channel');
        return;
      }

      // If we have an existing connection but it's to a different channel or in a bad state
      if (this.connection) {
        try {
          this.connection.removeAllListeners();
          this.connection.destroy();
        } catch (error) {
          // Ignore destroy errors
          console.log('Cleaning up old connection');
        }
        this.connection = undefined;
      }

      // Create new connection
      const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: true,
        selfMute: false
      });

      // Set up connection before assigning to this.connection
      connection.on('stateChange', async (oldState, newState) => {
        // Only log significant state changes
        if (oldState.status !== newState.status && newState.status !== 'connecting') {
          console.log(`Voice connection state change: ${oldState.status} -> ${newState.status}`);
        }

        // Handle disconnection
        if (newState.status === 'destroyed' || newState.status === 'disconnected') {
          if (this.connection === connection) {
            this.connection = undefined;
            // Wait a bit before attempting to reconnect
            setTimeout(() => {
              if (!this.connection) {
                console.log('Attempting to reconnect...');
                this.initializeVoiceConnection();
              }
            }, 5000);
          }
        }
      });

      // Only assign the connection if we haven't created a new one while waiting
      if (!this.connection) {
        this.connection = connection;
        this.connection.subscribe(this.audioPlayer);
        console.log('🎵 Connected to voice channel:', channel.name);
      } else {
        // If we somehow got a new connection while setting up this one, clean it up
        connection.destroy();
      }

    } catch (error) {
      console.error('Failed to connect to voice channel:', error);
      // Clear connection if initialization failed
      this.connection = undefined;
    }
  }

  private startUserPresenceCheck() {
    // Clear existing interval if any
    if (this.userCheckInterval) {
      clearInterval(this.userCheckInterval);
    }

    // Check user presence every 5 seconds
    this.userCheckInterval = setInterval(() => {
      this.checkUserPresence();
    }, 5000);
  }

  private async checkUserPresence() {
    if (!this.connection || !this.defaultVoiceChannelId) return;

    try {
      const channel = await this.client.channels.fetch(this.defaultVoiceChannelId);
      if (!channel?.isVoiceBased()) return;

      const members = channel.members.filter(member => !member.user.bot);
      const hasUsers = members.size > 0;
      this.hasActiveUsers = hasUsers;

      // Update playback state based on presence
      if (hasUsers || this.hasWebPresence) {
        // Clear timeout if users are present
        if (this.timeout) {
          clearTimeout(this.timeout);
          this.timeout = undefined;
        }

        // Resume playback if paused and there's a track
        if (this.audioPlayer.state.status === AudioPlayerStatus.Paused && this.hasCurrentTrack()) {
          console.log('Users present, resuming playback');
          this.resume();
          this.isPlayerPaused = false;
        }
      } else if (!this.hasWebPresence) {
        // Only start pause timeout if no web presence
        if (!this.timeout && this.audioPlayer.state.status === AudioPlayerStatus.Playing) {
          console.log('No users in channel and no web presence, starting pause timeout');
          this.timeout = setTimeout(() => {
            if (this.audioPlayer.state.status === AudioPlayerStatus.Playing && !this.hasWebPresence) {
              console.log('No users present for 10 seconds and no web presence, pausing playback');
              this.pause();
              this.isPlayerPaused = true;
            }
            this.timeout = undefined;
          }, this.USER_LEAVE_TIMEOUT);
        }
      }
    } catch (error) {
      console.error('Error checking user presence:', error);
    }
  }

  setConnection(connection: VoiceConnection) {
    // Only clean up the old connection if it's different from the new one
    if (this.connection && this.connection !== connection) {
      try {
        this.connection.removeAllListeners();
        this.connection.destroy();
      } catch (error) {
        // Ignore destroy errors
        console.log('Cleaning up old connection');
      }
    }

    this.connection = connection;
    console.log('Setting up voice connection');
    this.connection.subscribe(this.audioPlayer);
    
    // Clean up existing voice state update listeners
    this.client.removeListener('voiceStateUpdate', this.handleVoiceStateUpdate);
    
    // Add new voice state update listener
    this.client.on('voiceStateUpdate', this.handleVoiceStateUpdate);
  }

  private handleVoiceStateUpdate = async (oldState: VoiceState, newState: VoiceState) => {
    // Only handle events for our bot or default channel
    if (oldState.member?.id !== this.client.user?.id && 
        oldState.channelId !== this.defaultVoiceChannelId && 
        newState.channelId !== this.defaultVoiceChannelId) {
      return;
    }

    // If this is our bot being moved from the default channel
    if (oldState.member?.id === this.client.user?.id && 
        oldState.channelId === this.defaultVoiceChannelId && 
        newState.channelId !== this.defaultVoiceChannelId) {
      console.log('Bot was moved from default channel');
      
      // Clear the current connection
      this.connection = undefined;
      
      // Wait a bit before attempting to rejoin
      setTimeout(async () => {
        if (!this.connection) {
          console.log('Attempting to rejoin default channel...');
          await this.initializeVoiceConnection();
        }
      }, 5000);
    }

    // Update user presence check regardless of who triggered the event
    await this.checkUserPresence();

    // Check if bot was disconnected
    if (oldState.channelId && !newState.channelId && oldState.member?.user.id === process.env.DISCORD_CLIENT_ID) {
      this.stop(true);
      return;
    }

    // Get the voice channel the bot is in
    const botVoiceChannel = this.connection?.joinConfig.channelId;
    if (!botVoiceChannel) return;

    // Count users in the channel (excluding the bot)
    const channel = oldState.guild.channels.cache.get(botVoiceChannel) as VoiceChannel;
    if (!channel) return;

    const userCount = channel.members.filter(member => !member.user.bot).size;
    this.hasActiveUsers = userCount > 0;

    // Only pause if no users AND no web presence
    if (!this.hasActiveUsers && !this.hasWebPresence) {
      this.pause();
      this.isPlayerPaused = true;
    } else if ((this.hasActiveUsers || this.hasWebPresence) && this.isPlayerPaused) {
      this.resume();
      this.isPlayerPaused = false;
    }
  };

  public async play(
    voiceState: VoiceState,
    youtubeId: string,
    userId: string,
    userInfo: UserInfo,
    isMusicUrl: boolean = false
  ): Promise<QueuedTrack> {
    try {
      console.log(`=== Starting play request for: ${youtubeId}`);

      // If it's a YouTube Music URL, resolve it first
      let resolvedId = youtubeId;
      if (isMusicUrl) {
        const resolved = await resolveYouTubeMusicId(youtubeId);
        if (!resolved) {
          throw new Error('Failed to resolve YouTube Music URL');
        }
        resolvedId = resolved;
      }

      // Get voice connection
      const connection = await this.getVoiceConnection(voiceState);
      if (!connection) {
        throw new Error('Failed to join voice channel');
      }

      // Get track info using the resolved ID
      const trackInfo = await getYoutubeInfo(resolvedId, isMusicUrl);

      // Check duration limit
      if (trackInfo.duration > this.MAX_DURATION) {
        throw new Error(`Track duration exceeds limit of ${Math.floor(this.MAX_DURATION / 60)} minutes`);
      }

      // Create queue item with complete metadata
      const requestedAt = new Date();
      const queueItem: QueueItem = {
        youtubeId: resolvedId, // Use resolved ID
        title: trackInfo.title,
        thumbnail: trackInfo.thumbnail,
        duration: trackInfo.duration,
        requestedBy: {
          userId,
          username: userInfo.username,
          avatar: userInfo.avatar || undefined
        },
        requestedAt,
        isDownloading: false
      };

      // If nothing is playing, start this track immediately
      if (this.audioPlayer.state.status === AudioPlayerStatus.Idle) {
        console.log('Player idle, starting playback immediately');
        this.currentTrack = queueItem;
        
        // Start audio download and playback
        try {
          const resource = await this.getAudioResource(resolvedId); // Use resolved ID
          if (resource) {
            this.audioPlayer.play(resource);
            console.log('Started immediate playback');
          }
        } catch (error) {
          console.error('Failed to start immediate playback:', error);
          // If immediate playback fails, add to queue
          this.queue.push(queueItem);
        }
      } else {
        // Add to queue if something is already playing
        this.queue.push(queueItem);
      }

      // Start downloading audio for this track in the background
      this.prefetchAudioForTrack(resolvedId, trackInfo.title); // Use resolved ID

      // Update database in background
      Promise.all([
        // Update track record
        prisma.track.upsert({
          where: { youtubeId: resolvedId }, // Use resolved ID
          create: {
            youtubeId: resolvedId, // Use resolved ID
            title: trackInfo.title,
            thumbnail: trackInfo.thumbnail,
            duration: trackInfo.duration,
            isMusicUrl
          },
          update: {
            title: trackInfo.title,
            thumbnail: trackInfo.thumbnail,
            duration: trackInfo.duration,
            isMusicUrl
          }
        }),

        // Create/update user
        prisma.user.upsert({
          where: { id: userId },
          update: {
            username: userInfo.username,
            discriminator: userInfo.discriminator,
            avatar: userInfo.avatar,
            updatedAt: new Date()
          },
          create: {
            id: userId,
            username: userInfo.username,
            discriminator: userInfo.discriminator,
            avatar: userInfo.avatar
          }
        }),

        // Create request using resolved ID
        prisma.request.create({
          data: {
            userId,
            youtubeId: resolvedId,
            status: this.audioPlayer.state.status === AudioPlayerStatus.Playing ? 
              RequestStatus.QUEUED : RequestStatus.PLAYING,
            requestedAt,
            isAutoplay: false
          }
        })
      ]).catch(error => {
        console.error('Background database updates failed:', error);
      });

      // Start background processes after playback is initiated
      if (this.queue.length === 0) {
        this.prefetchAutoplayTracks().catch(error => {
          console.error('Failed to prefetch autoplay tracks:', error);
        });
      }

      // Prefetch audio for upcoming tracks in the queue
      this.prefetchQueueAudio().catch(error => {
        console.error('Failed to prefetch queue audio:', error);
      });

      // Calculate response
      const willPlayNext = this.audioPlayer.state.status === AudioPlayerStatus.Idle || (this.queue.length === 1);
      const response = {
        youtubeId: resolvedId, // Use resolved ID
        title: trackInfo.title,
        thumbnail: trackInfo.thumbnail,
        duration: trackInfo.duration,
        requestedBy: queueItem.requestedBy,
        queuePosition: this.queue.length || undefined,
        willPlayNext,
        isPlaying: this.audioPlayer.state.status === AudioPlayerStatus.Playing
      };

      console.log('Returning play response:', response.title);
      return response;

    } catch (error) {
      console.error('Error playing track:', error);
      throw error;
    }
  }

  async skip() {
    if (this.currentTrack) {
      const voiceChannel = this.connection?.joinConfig.channelId;
      if (voiceChannel && this.connection) {
        const guild = this.client.guilds.cache.get(this.connection.joinConfig.guildId);
        if (guild) {
          const channel = guild.channels.cache.get(voiceChannel);
          if (channel?.isVoiceBased()) {
            const userIds = Array.from(channel.members.keys());
            // Update user stats for skip
            for (const userId of userIds) {
              await this.trackingService.trackUserLeave(
                userId,
                this.currentTrack.youtubeId,
                0, // No listen duration for skips
                this.currentTrack.duration,
                true // Was skipped
              );
            }
          }
        }
      }

      // Update request status
      await prisma.request.updateMany({
        where: {
          youtubeId: this.currentTrack.youtubeId,
          requestedAt: this.currentTrack.requestedAt
        },
        data: {
          status: RequestStatus.SKIPPED
        }
      });

      await this.playNext();
      
      // Prefetch audio for upcoming tracks in the queue
      this.prefetchQueueAudio().catch(error => {
        console.error('Failed to prefetch queue audio:', error);
      });
    }
  }

  async pause() {
    if (this.audioPlayer.state.status === AudioPlayerStatus.Playing) {
      this.audioPlayer.pause();
      await this.updatePlayerState();
    }
  }

  async resume() {
    if (this.audioPlayer.state.status === AudioPlayerStatus.Paused && this.currentTrack) {
      this.audioPlayer.unpause();
      await this.updatePlayerState();
      
      // Prefetch audio for upcoming tracks in the queue
      this.prefetchQueueAudio().catch(error => {
        console.error('Failed to prefetch queue audio:', error);
      });
    } else if (this.audioPlayer.state.status === AudioPlayerStatus.Idle && (this.currentTrack || this.queue.length > 0)) {
      // If we were idle but have tracks, try to play
      await this.playNext();
      
      // Prefetch audio for upcoming tracks in the queue
      this.prefetchQueueAudio().catch(error => {
        console.error('Failed to prefetch queue audio:', error);
      });
    }
  }

  isPaused(): boolean {
    return this.isPlayerPaused;
  }

  async stop(preserveState: boolean = false) {
    if (!preserveState) {
      this.queue = [];
      this.autoplayQueue = []; // Also clear autoplay queue
      this.currentTrack = undefined;
    }
    
    this.audioPlayer.stop();

    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = undefined;
    }

    if (this.userCheckInterval) {
      clearInterval(this.userCheckInterval);
      this.userCheckInterval = undefined;
    }

    if (this.connection) {
      this.connection.destroy();
      this.connection = undefined;
    }

    await this.updatePlayerState();
  }

  getQueue(): QueueItem[] {
    // Return combined queue for display, with user requests first
    return [...this.queue, ...this.autoplayQueue];
  }

  removeFromQueue(position: number): boolean {
    try {
      const combinedQueue = [...this.queue, ...this.autoplayQueue];
      if (position < 0 || position >= combinedQueue.length) {
        return false;
      }

      const trackToRemove = combinedQueue[position];
      
      // Check if the track is in the user queue
      const userQueueIndex = this.queue.findIndex(
        item => item.youtubeId === trackToRemove.youtubeId && 
                item.requestedAt.getTime() === trackToRemove.requestedAt.getTime()
      );
      
      if (userQueueIndex !== -1) {
        // Remove from user queue
        this.queue.splice(userQueueIndex, 1);
        // Update player state
        this.updatePlayerState().catch(error => {
          console.error('Failed to update player state after removing track:', error);
        });
        return true;
      }
      
      // If not in user queue, check autoplay queue
      const autoplayQueueIndex = this.autoplayQueue.findIndex(
        item => item.youtubeId === trackToRemove.youtubeId && 
                item.requestedAt.getTime() === trackToRemove.requestedAt.getTime()
      );
      
      if (autoplayQueueIndex !== -1) {
        // Remove from autoplay queue
        this.autoplayQueue.splice(autoplayQueueIndex, 1);
        // Update player state
        this.updatePlayerState().catch(error => {
          console.error('Failed to update player state after removing track:', error);
        });
        return true;
      }
      
      return false;
    } catch (error) {
      console.error('Error removing track from queue:', error);
      return false;
    }
  }

  getCurrentTrack(): QueueItem | undefined {
    return this.currentTrack;
  }

  getStatus(): 'playing' | 'paused' | 'stopped' {
    return this.audioPlayer.state.status === AudioPlayerStatus.Playing ? 'playing' :
           this.audioPlayer.state.status === AudioPlayerStatus.Paused ? 'paused' : 'stopped';
  }

  getPosition(): number {
    if (this.audioPlayer.state.status === AudioPlayerStatus.Playing) {
      const resource = this.audioPlayer.state.resource;
      if (resource) {
        return resource.playbackDuration / 1000; // Convert from ms to seconds
      }
    }
    return 0;
  }

  isAutoplayEnabled(): boolean {
    return this.autoplayEnabled;
  }

  togglePlay() {
    if (this.audioPlayer.state.status === AudioPlayerStatus.Playing) {
      this.audioPlayer.pause();
      this.updatePlayerState();
    } else if (this.audioPlayer.state.status === AudioPlayerStatus.Paused) {
      this.audioPlayer.unpause();
      this.updatePlayerState();
    }
  }

  private cleanupPlayedTracks() {
    const now = Date.now();
    let removedCount = 0;
    for (const [trackId, timestamp] of this.playedTracks.entries()) {
      // Keep tracks up to 5 hours for reference, actual filtering happens in isTrackDuplicate
      if (now - timestamp > this.AUTOPLAY_TRACKS_EXPIRY) {
        this.playedTracks.delete(trackId);
        removedCount++;
      }
    }
    if (removedCount > 0) {
      console.log(`Removed ${removedCount} expired tracks from played list`);
    }
  }

  private isTrackDuplicate(youtubeId: string, trackId?: string, isAutoplay: boolean = false): boolean {
    // Clean up expired entries first
    this.cleanupPlayedTracks();
    
    // Check current track
    if (this.currentTrack?.youtubeId === youtubeId) {
      return true;
    }
    
    // Check user queue
    const userQueueDuplicate = this.queue.find(track => track.youtubeId === youtubeId);
    if (userQueueDuplicate) {
      return true;
    }
    
    // Check autoplay queue
    const autoplayQueueDuplicate = this.autoplayQueue.find(track => track.youtubeId === youtubeId);
    if (autoplayQueueDuplicate) {
      return true;
    }

    // For playlist tracks in linear mode, skip the played tracks check
    if (this.currentPlaylistId) {
      return false;
    }

    const now = Date.now();
    const ytKey = `yt_${youtubeId}`;
    const timestamp = this.playedTracks.get(ytKey) || this.playedTracks.get(youtubeId) || (trackId ? this.playedTracks.get(trackId) : undefined);

    if (timestamp) {
      const elapsed = now - timestamp;
      // For autoplay, use 5-hour cooldown
      if (isAutoplay) {
        const isDuplicate = elapsed < this.AUTOPLAY_TRACKS_EXPIRY;
        if (isDuplicate) {
          console.log(`Track ${youtubeId} blocked by autoplay cooldown (played ${Math.floor(elapsed/60000)} minutes ago, cooldown: ${Math.floor(this.AUTOPLAY_TRACKS_EXPIRY/60000)} minutes)`);
        }
        return isDuplicate;
      }
      // For user requests, use 1-hour cooldown
      return elapsed < this.PLAYED_TRACKS_EXPIRY;
    }
    
    return false;
  }

  private async getAutoplayTrack(): Promise<QueueItem | null> {
    try {
      if (this.autoplayQueue.length > 0) {
        const track = this.autoplayQueue.shift()!;
        const source = track.requestedBy.username === 'Playlist' ? '\x1b[35m[PLAYLIST POOL]\x1b[0m' : '\x1b[32m[YT-MIX]\x1b[0m';
        console.log(`${source} Adding to queue: 🎵 "${track.title}"`);
        return track;
      }

      if (this.currentPlaylistId) {
        const playlist = await prisma.defaultPlaylist.findUnique({
          where: { id: this.currentPlaylistId }
        });

        if (!playlist) {
          console.log('\x1b[31m[ERROR]\x1b[0m Playlist not found');
          return null;
        }

        console.log(`\x1b[35m[PLAYLIST]\x1b[0m Using "${playlist.name}" (${playlist.mode} mode)`);

        const activeTracks = await prisma.$queryRaw<TrackResult[]>`
          SELECT t.* FROM "Track" t
          INNER JOIN "DefaultPlaylistTrack" dpt ON t."youtubeId" = dpt."trackId"
          WHERE dpt."playlistId" = ${this.currentPlaylistId}::text
          AND t."isActive" = true
          ORDER BY ${playlist.mode === 'POOL' ? Prisma.sql`RANDOM()` : Prisma.sql`dpt.position ASC`}
          LIMIT 1
        `;

        if (activeTracks.length > 0) {
          const botId = this.client.user?.id;
          if (!botId) throw new Error('Bot user ID not found');

          const botUser = await prisma.user.upsert({
            where: { id: botId },
            create: {
              id: botId,
              username: this.client.user?.username || 'Bot',
              discriminator: this.client.user?.discriminator || '0000',
              avatar: this.client.user?.avatar || null
            },
            update: {
              username: this.client.user?.username || 'Bot',
              discriminator: this.client.user?.discriminator || '0000',
              avatar: this.client.user?.avatar || null
            }
          });

          const selectedTrack = activeTracks[0];
          const requestedAt = new Date();

          try {
            const info = await getYoutubeInfo(selectedTrack.youtubeId);
            console.log(`📑 [PLAYLIST] Selected: ${info.title}`);

            if (this.isTrackDuplicate(selectedTrack.youtubeId, undefined, true)) {
              console.log(`⏭️ [PLAYLIST] Skipping duplicate: ${info.title}`);
              return null;
            }

            await prisma.request.create({
              data: {
                userId: botUser.id,
                youtubeId: selectedTrack.youtubeId,
                status: RequestStatus.PENDING,
                requestedAt,
                isAutoplay: true
              }
            });

            return {
              youtubeId: selectedTrack.youtubeId,
              title: info.title,
              thumbnail: info.thumbnail,
              duration: info.duration,
              requestedBy: {
                userId: botUser.id,
                username: 'Playlist',
                avatar: botUser.avatar || undefined
              },
              requestedAt,
              isAutoplay: true
            };
          } catch (error) {
            console.error('❌ [PLAYLIST] Error preparing track:', error);
            return null;
          }
        }
      }

      console.log('❌ [AUTOPLAY] No suitable track found');
      return null;
    } catch (error) {
      console.error('❌ [AUTOPLAY] Error:', error);
      return null;
    }
  }

  setAutoplay(enabled: boolean) {
    this.autoplayEnabled = enabled;
    this.updatePlayerState();
  }

  private async handleAutoplay() {
    if (!this.isAutoplayEnabled() || this.queue.length > 0) {
      console.log('[DEBUG] handleAutoplay: Autoplay disabled or queue not empty, skipping');
      return;
    }

    try {
      console.log(`[DEBUG] handleAutoplay: Starting autoplay handling. Current playlist ID: ${this.currentPlaylistId}`);
      
      // First try to get a track from the autoplay queue
      let nextTrack = this.autoplayQueue.shift();
      
      // If no track in queue, try to get a new one
      if (!nextTrack) {
        console.log('[DEBUG] handleAutoplay: No tracks in autoplay queue, attempting to get new track...');
        
        // First try to get a track from the current playlist
        if (this.currentPlaylistId) {
          console.log(`[DEBUG] handleAutoplay: Checking playlist ${this.currentPlaylistId} for tracks`);
          const playlist = await prisma.defaultPlaylist.findUnique({
            where: { id: this.currentPlaylistId },
            include: {
              tracks: {
                include: {
                  track: true
                }
              }
            }
          });

          if (playlist) {
            console.log(`[DEBUG] handleAutoplay: Found playlist "${playlist.name}" with ${playlist.tracks.length} tracks in ${playlist.mode} mode`);
            console.log('[DEBUG] handleAutoplay: Sample of tracks:', playlist.tracks.slice(0, 3).map(t => t.track?.title || t.trackId));
          } else {
            console.log('[DEBUG] handleAutoplay: WARNING - Playlist ID set but playlist not found in database');
            // Clear invalid playlist ID
            this.currentPlaylistId = undefined;
          }
        } else {
          console.log('[DEBUG] handleAutoplay: No current playlist ID set, checking for active playlists');
          // Try to find an active playlist
          const activePlaylist = await prisma.defaultPlaylist.findFirst({
            where: { active: true },
            include: {
              tracks: {
                include: {
                  track: true
                }
              }
            }
          });

          if (activePlaylist) {
            console.log(`[DEBUG] handleAutoplay: Found active playlist "${activePlaylist.name}", setting as current`);
            this.currentPlaylistId = activePlaylist.id;
            console.log(`[DEBUG] handleAutoplay: Playlist has ${activePlaylist.tracks.length} tracks in ${activePlaylist.mode} mode`);
          } else {
            console.log('[DEBUG] handleAutoplay: No active playlists found');
          }
        }
        
        const newTrack = await this.getAutoplayTrack();
        if (newTrack) {
          console.log(`[DEBUG] handleAutoplay: Got new track: ${newTrack.title}`);
          nextTrack = newTrack;
        }
        
        if (!nextTrack) {
          // If still no track, try to refresh YouTube recommendations and try again
          console.log('[DEBUG] handleAutoplay: No track found, refreshing YouTube recommendations pool...');
          await this.refreshYoutubeRecommendationsPool();
          const retryTrack = await this.getAutoplayTrack();
          if (retryTrack) {
            console.log(`[DEBUG] handleAutoplay: Got track after refresh: ${retryTrack.title}`);
            nextTrack = retryTrack;
          }
        }
      } else {
        console.log(`[DEBUG] handleAutoplay: Using track from autoplay queue: ${nextTrack.title}`);
      }

      if (nextTrack) {
        console.log(`[DEBUG] handleAutoplay: Adding track to queue: ${nextTrack.title}`);
        this.queue.push(nextTrack);
        await this.playNext();
        
        // After successfully getting a track, prefetch more for the queue
        this.prefetchAutoplayTracks().catch(error => {
          console.error('[DEBUG] handleAutoplay: Failed to prefetch tracks:', error);
        });
      } else {
        // If still no track, wait before trying again
        console.log('[DEBUG] handleAutoplay: No autoplay track found after all attempts, waiting 30 seconds...');
        await new Promise(resolve => setTimeout(resolve, 30000));
      }
    } catch (error) {
      console.error('[DEBUG] handleAutoplay: Error:', error);
      // Wait before retrying on error
      await new Promise(resolve => setTimeout(resolve, 30000));
    }
  }

  private async prefetchAutoplayTracks(): Promise<void> {
    try {
      if (!this.currentTrack) {
        console.log('🎵 [AUTOPLAY] No current track playing');
        return;
      }

      console.log(`🎵 [AUTOPLAY] Queue status - Playlist: ${this.currentPlaylistId ? 'Active' : 'None'}, Pool: ${this.youtubeRecommendationsPool.length}, Queue: ${this.autoplayQueue.length}`);

      // If we have a current playlist, prioritize getting tracks from it
      if (this.currentPlaylistId && this.autoplayQueue.length < this.AUTOPLAY_QUEUE_SIZE) {
        const playlist = await prisma.defaultPlaylist.findUnique({
          where: { id: this.currentPlaylistId }
        });

        if (playlist) {
          console.log(`📑 [PLAYLIST] Using "${playlist.name}" (${playlist.mode} mode)`);
          
          const activeTracks = await prisma.$queryRaw<TrackResult[]>`
            SELECT t.* FROM "Track" t
            INNER JOIN "DefaultPlaylistTrack" dpt ON t."youtubeId" = dpt."trackId"
            WHERE dpt."playlistId" = ${this.currentPlaylistId}::text
            AND t."isActive" = true
            AND t."youtubeId" != ${this.currentTrack.youtubeId}
            ORDER BY ${playlist.mode === 'POOL' ? Prisma.sql`RANDOM()` : Prisma.sql`dpt.position ASC`}
            LIMIT ${this.AUTOPLAY_QUEUE_SIZE}
          `;

          console.log(`📑 [PLAYLIST] Found ${activeTracks.length} tracks to process`);

          const botId = this.client.user?.id;
          if (!botId) throw new Error('Bot user ID not found');

          const botUser = await prisma.user.upsert({
            where: { id: botId },
            create: {
              id: botId,
              username: this.client.user?.username || 'Bot',
              discriminator: this.client.user?.discriminator || '0000',
              avatar: this.client.user?.avatar || null
            },
            update: {
              username: this.client.user?.username || 'Bot',
              discriminator: this.client.user?.discriminator || '0000',
              avatar: this.client.user?.avatar || null
            }
          });

          for (const track of activeTracks) {
            if (this.isTrackDuplicate(track.youtubeId, undefined, true)) {
              console.log(`⏭️ [PLAYLIST] Skipping duplicate: ${track.title}`);
              continue;
            }

            const requestedAt = new Date();
            await prisma.request.create({
              data: {
                userId: botUser.id,
                youtubeId: track.youtubeId,
                status: RequestStatus.PENDING,
                requestedAt,
                isAutoplay: true
              }
            });

            this.autoplayQueue.push({
              youtubeId: track.youtubeId,
              title: track.title,
              thumbnail: track.thumbnail,
              duration: track.duration,
              requestedBy: {
                userId: botUser.id,
                username: 'Playlist',
                avatar: botUser.avatar || undefined
              },
              requestedAt,
              isAutoplay: true
            });

            console.log(`➕ [PLAYLIST] Added: ${track.title}`);
            this.prefetchAudioForTrack(track.youtubeId, track.title);

            if (this.autoplayQueue.length >= this.AUTOPLAY_QUEUE_SIZE) {
              console.log('✅ [PLAYLIST] Queue is full');
              break;
            }
          }

          console.log(`📊 [AUTOPLAY] Final queue size: ${this.autoplayQueue.length}`);
          return;
        }
      }

      // Only use YouTube recommendations if we don't have a playlist or couldn't get playlist tracks
      if (this.youtubeRecommendationsPool.length < this.AUTOPLAY_QUEUE_SIZE) {
        console.log('🎵 [YT-MIX] Fetching recommendations');
        const recommendations = await getYoutubeRecommendations(this.currentTrack.youtubeId);
        
        const activeRecommendations = await prisma.$queryRaw<TrackIdResult[]>`
          SELECT "youtubeId" FROM "Track"
          WHERE "youtubeId" = ANY(${recommendations.map(rec => rec.youtubeId)}::text[])
          AND "isActive" = true
        `;
        console.log(`🎵 [YT-MIX] Found ${activeRecommendations.length} active tracks`);

        this.youtubeRecommendationsPool.push(...activeRecommendations);
      }

      while (this.autoplayQueue.length < this.AUTOPLAY_QUEUE_SIZE && this.youtubeRecommendationsPool.length > 0) {
        const nextRecommendation = this.youtubeRecommendationsPool.shift();
        if (!nextRecommendation) break;

        if (this.isTrackDuplicate(nextRecommendation.youtubeId, undefined, true)) {
          console.log(`⏭️ [YT-MIX] Skipping duplicate: ${nextRecommendation.youtubeId}`);
          continue;
        }

        try {
          const info = await getYoutubeInfo(nextRecommendation.youtubeId);
          console.log(`➕ [YT-MIX] Added: ${info.title}`);
          
          const botId = this.client.user?.id;
          if (!botId) throw new Error('Bot user ID not found');

          const botUser = await prisma.user.upsert({
            where: { id: botId },
            create: {
              id: botId,
              username: this.client.user?.username || 'Bot',
              discriminator: this.client.user?.discriminator || '0000',
              avatar: this.client.user?.avatar || null
            },
            update: {
              username: this.client.user?.username || 'Bot',
              discriminator: this.client.user?.discriminator || '0000',
              avatar: this.client.user?.avatar || null
            }
          });

          const requestedAt = new Date();
          await prisma.request.create({
            data: {
              userId: botUser.id,
              youtubeId: nextRecommendation.youtubeId,
              status: RequestStatus.PENDING,
              requestedAt,
              isAutoplay: true
            }
          });

          this.autoplayQueue.push({
            youtubeId: nextRecommendation.youtubeId,
            title: info.title,
            thumbnail: info.thumbnail,
            duration: info.duration,
            requestedBy: {
              userId: botUser.id,
              username: 'Mix',
              avatar: botUser.avatar || undefined
            },
            requestedAt,
            isAutoplay: true
          });

          this.prefetchAudioForTrack(nextRecommendation.youtubeId, info.title);
        } catch (error) {
          console.error(`❌ [YT-MIX] Failed to process: ${nextRecommendation.youtubeId}`, error);
        }
      }
    } catch (error) {
      console.error('❌ [AUTOPLAY] Error:', error);
    }
  }

  private async playNext() {
    // Initialize voice connection if not already connected
    if (!this.connection) {
      await this.initializeVoiceConnection();
    }

    // Get next track from queue or autoplay
    const nextTrack = this.queue.shift() || this.autoplayQueue.shift();
    if (!nextTrack) {
      await this.handleAutoplay();
      return;
    }

    // Get audio resource
    const resource = await this.getAudioResource(nextTrack.youtubeId);
    if (!resource) {
      console.error('Failed to get audio resource');
      await this.playNext();
      return;
    }

    // Update current track and start playback
    this.currentTrack = nextTrack;
    this.audioPlayer.play(resource);

    // Stream to all connected clients
    for (const stream of this.activeAudioStreams) {
      this.streamCurrentTrackToClient(stream);
    }

    // Update request status
    await prisma.request.updateMany({
      where: {
        youtubeId: nextTrack.youtubeId,
        requestedAt: nextTrack.requestedAt
      },
      data: {
        status: RequestStatus.PLAYING,
        playedAt: new Date()
      }
    });

    // Update state to reflect the change
    await this.updatePlayerState();

    // Prefetch audio for upcoming tracks in the queue
    this.prefetchQueueAudio().catch(error => {
      console.error('Failed to prefetch queue audio:', error);
    });
    
    // Check if we need to prefetch more autoplay tracks
    const totalQueueLength = this.queue.length + this.autoplayQueue.length;
    if (this.autoplayEnabled && totalQueueLength < this.AUTOPLAY_QUEUE_SIZE) {
      console.log(`Queue running low (${totalQueueLength} tracks), prefetching autoplay tracks...`);
      this.prefetchAutoplayTracks().catch(error => {
        console.error('Failed to prefetch autoplay tracks:', error);
      });
    }
  }

  private handlePlaybackError() {
    this.retryCount++;
    
    if (this.retryCount >= this.maxRetries) {
      console.log(`Max retries (${this.maxRetries}) reached for track, skipping...`);
      this.retryCount = 0;
      this.onTrackFinish();
      return;
    }

    console.log(`Retrying playback (attempt ${this.retryCount} of ${this.maxRetries})...`);
    setTimeout(() => this.playNext(), this.retryDelay);
  }

  private async onTrackFinish() {
    if (this.currentTrack) {
      const voiceChannel = this.connection?.joinConfig.channelId;
      if (voiceChannel && this.connection) {
        const guild = this.client.guilds.cache.get(this.connection.joinConfig.guildId);
        if (guild) {
          const channel = guild.channels.cache.get(voiceChannel);
          if (channel?.isVoiceBased()) {
            const userIds = Array.from(channel.members.keys());
            // Update user stats for completion if tracking service exists
            if (this.trackingService) {
              for (const userId of userIds) {
                try {
                  await this.trackingService.trackUserLeave(
                    userId,
                    this.currentTrack.youtubeId,
                    this.currentTrack.duration,
                    this.currentTrack.duration,
                    false // Not skipped
                  );
                } catch (error) {
                  console.error('Error tracking user leave:', error);
                }
              }
            }
          }
        }
      }

      // Mark the current track as completed in the database
      await prisma.request.updateMany({
        where: {
          youtubeId: this.currentTrack.youtubeId,
          requestedAt: this.currentTrack.requestedAt
        },
        data: {
          status: RequestStatus.COMPLETED,
          playedAt: new Date()
        }
      });

      // THIS is where we should mark the track as played for the cooldown system
      // Mark the track as played in our internal tracking
      const ytKey = `yt_${this.currentTrack.youtubeId}`;
      const now = Date.now();
      this.playedTracks.set(ytKey, now);
      console.log(`Marked track ${this.currentTrack.youtubeId} (${this.currentTrack.title}) as played at ${new Date(now).toISOString()}`);
      console.log(`This track will be available for autoplay again after ${new Date(now + this.AUTOPLAY_TRACKS_EXPIRY).toISOString()}`);

      // Clear current track reference
      this.currentTrack = undefined;
      
      // Update state to reflect the change
      await this.updatePlayerState();
      console.log('=== Track Finish Complete ===\n');
    }

    // Play next track
    await this.playNext();
  }

  resetAutoplayTracking() {
    this.playedTracks.clear();
    console.log('Reset track history');
  }

  private async updatePlayerState() {
    try {
      // Update current track if exists
      if (this.currentTrack) {
        await prisma.request.updateMany({
          where: {
            youtubeId: this.currentTrack.youtubeId,
            requestedAt: this.currentTrack.requestedAt
          },
          data: {
            status: RequestStatus.PLAYING,
            playedAt: new Date()
          }
        });
      }

      // Update queue tracks with proper ordering
      const allQueueTracks = [...this.queue, ...this.autoplayQueue];
      for (const track of allQueueTracks) {
        await prisma.request.updateMany({
          where: {
            youtubeId: track.youtubeId,
            requestedAt: track.requestedAt
          },
          data: {
            status: RequestStatus.QUEUED
          }
        });
      }
    } catch (error) {
      console.error('Error updating player state:', error);
    }
  }

  private async getAudioResource(youtubeId: string): Promise<AudioResource | null> {
    let retryCount = 0;
    const maxRetries = 3;

    while (retryCount < maxRetries) {
      try {
        let audioFilePath: string;
        let finalYoutubeId = youtubeId;
        
        // Get cached audio file and track info
        const track = await prisma.track.findUnique({
          where: { youtubeId }
        });

        if (!track) {
          console.error(`Track not found in database: ${youtubeId}`);
          return null;
        }

        // If this is a YouTube Music track that hasn't been resolved yet
        if (track.isMusicUrl && !track.resolvedYtId) {
          console.log(`🎵 [YT-MUSIC] Resolving ID: ${youtubeId}`);
          const resolvedId = await resolveYouTubeMusicId(youtubeId);
          
          if (resolvedId) {
            finalYoutubeId = resolvedId;
            
            // Update the track with resolved ID
            await prisma.track.update({
              where: { youtubeId },
              data: { resolvedYtId: resolvedId }
            });
          } else {
            console.log(`❌ [YT-MUSIC] Failed to resolve ID: ${youtubeId}`);
            await prisma.track.update({
              where: { youtubeId },
              data: { isActive: false }
            });
            throw new Error(`Could not resolve YouTube Music ID: ${youtubeId}`);
          }
        } else if (track.resolvedYtId) {
          // Use resolved ID if available
          finalYoutubeId = track.resolvedYtId;
        }

        // Get cached audio file
        const audioCache = await prisma.audioCache.findUnique({
          where: { youtubeId: finalYoutubeId }
        });

        if (!audioCache || !fs.existsSync(audioCache.filePath)) {
          // Download if not in cache or file missing
          console.log(`⬇️ [DOWNLOAD] Starting: ${track.title}`);
          try {
            audioFilePath = await downloadYoutubeAudio(finalYoutubeId);
          } catch (error: any) {
            // Check if error indicates video is unavailable
            if (error.stderr?.includes('Video unavailable') || 
                error.stderr?.includes('This video is not available') ||
                error.stderr?.includes('This video has been removed')) {
              console.log(`🎵 [CACHE] Video ${finalYoutubeId} is unavailable, marking as inactive in database`);
              // Mark track as inactive in database
              await prisma.track.update({
                where: { youtubeId },
                data: { isActive: false }
              });
              return null;
            }
            throw error;
          }
          
          // Create or update the audio cache
          await prisma.audioCache.upsert({
            where: { youtubeId: finalYoutubeId },
            create: {
              youtubeId: finalYoutubeId,
              filePath: audioFilePath
            },
            update: {
              filePath: audioFilePath
            }
          });
        } else {
          audioFilePath = audioCache.filePath;
        }

        // Create audio resource
        console.log(`Creating audio resource from: ${audioFilePath}`);
        const stream = createReadStream(audioFilePath);
        const { type } = await demuxProbe(stream);
        const resource = createAudioResource(stream, {
          inputType: type,
          inlineVolume: false,
          metadata: {
            title: track.title
          }
        });

        return resource;
      } catch (error) {
        console.error(`Attempt ${retryCount + 1}/${maxRetries} failed:`, error);
        retryCount++;
        
        if (retryCount < maxRetries) {
          // Wait before retrying
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }

    console.error(`Failed to get audio resource for ${youtubeId} after ${maxRetries} attempts`);
    return null;
  }

  private async downloadTrackAudio(youtubeId: string): Promise<void> {
    try {
      // Check if already downloaded
      const audioCache = await prisma.audioCache.findUnique({
        where: { youtubeId },
        include: {
          track: true
        }
      });

      if (audioCache && fs.existsSync(audioCache.filePath)) {
        console.log(`🎵 [CACHE] Found cached audio: ${audioCache.track?.title || youtubeId}`);
        return;
      }

      const track = await prisma.track.findUnique({
        where: { youtubeId }
      });

      if (!track) {
        throw new Error(`Track not found in database: ${youtubeId}`);
      }

      let finalYoutubeId = youtubeId;

      // If this is a YouTube Music track that hasn't been resolved yet
      if (track.isMusicUrl && !track.resolvedYtId) {
        console.log(`🎵 [YT-MUSIC] Resolving ID: ${youtubeId}`);
        const resolvedId = await resolveYouTubeMusicId(youtubeId);
        
        if (resolvedId) {
          finalYoutubeId = resolvedId;
          await prisma.track.update({
            where: { youtubeId },
            data: { resolvedYtId: resolvedId }
          });
        } else {
          console.log(`❌ [YT-MUSIC] Failed to resolve ID: ${youtubeId}`);
          await prisma.track.update({
            where: { youtubeId },
            data: { isActive: false }
          });
          throw new Error(`Could not resolve YouTube Music ID: ${youtubeId}`);
        }
      } else if (track.resolvedYtId) {
        finalYoutubeId = track.resolvedYtId;
      }

      console.log(`⬇️ [DOWNLOAD] Starting: ${track.title}`);
      
      const audioPath = await downloadYoutubeAudio(finalYoutubeId);
      
      await prisma.audioCache.upsert({
        where: { youtubeId: finalYoutubeId },
        create: {
          youtubeId: finalYoutubeId,
          filePath: audioPath
        },
        update: {
          filePath: audioPath
        }
      });

      console.log(`✅ [DOWNLOAD] Complete: ${track.title}`);
    } catch (error) {
      console.error('❌ [DOWNLOAD] Failed:', error);
      throw error;
    }
  }

  private async cleanupStuckStates() {
    try {
      // Reset any stuck states from previous sessions
      await prisma.request.updateMany({
        where: {
          status: {
            in: [RequestStatus.PLAYING, RequestStatus.DOWNLOADING, RequestStatus.QUEUED]
          }
        },
        data: {
          status: RequestStatus.COMPLETED,
          playedAt: new Date()
        }
      });

      // Clean up any temp files
      const cacheDir = process.env.CACHE_DIR || path.join(process.cwd(), 'cache');
      const audioDir = path.join(cacheDir, 'audio');
      const files = await fs.promises.readdir(audioDir);

      // Get all valid cache entries
      const validCacheEntries = await prisma.audioCache.findMany();
      const validFilePaths = new Set(validCacheEntries.map(entry => entry.filePath));

      // Remove any files not in the database
      for (const file of files) {
        const filePath = path.join(audioDir, file);
        if (!validFilePaths.has(filePath)) {
          try {
            await fs.promises.unlink(filePath);
            console.log('Removed orphaned file:', file);
          } catch (error) {
            console.error('Error removing orphaned file:', file, error);
          }
        }
      }

      // Clean up temp files
      const tempFiles = files.filter(f => f.endsWith('.temp.m4a') || f.endsWith('.part'));
      for (const tempFile of tempFiles) {
        try {
          await fs.promises.unlink(path.join(audioDir, tempFile));
          console.log('Removed temp file:', tempFile);
        } catch (error) {
          console.error('Error removing temp file:', tempFile, error);
        }
      }

      // Validate cache entries
      for (const cacheEntry of validCacheEntries) {
        try {
          // Check if file exists
          if (!fs.existsSync(cacheEntry.filePath)) {
            console.log('Removing cache entry for missing file:', cacheEntry.youtubeId);
            await prisma.audioCache.delete({
              where: { youtubeId: cacheEntry.youtubeId }
            });
            continue;
          }

          // Validate file duration
          try {
            const track = await prisma.track.findUnique({
              where: { youtubeId: cacheEntry.youtubeId }
            });
            if (!track) continue;

            const actualDuration = await getAudioFileDuration(cacheEntry.filePath);
            // Allow 1 second difference to account for rounding
            if (Math.abs(actualDuration - track.duration) > 1) {
              console.log('Removing invalid cache entry due to duration mismatch:', cacheEntry.youtubeId);
              await prisma.audioCache.delete({
                where: { youtubeId: cacheEntry.youtubeId }
              });
              await fs.promises.unlink(cacheEntry.filePath);
            }
          } catch (error) {
            console.error('Error validating cache entry:', cacheEntry.youtubeId, error);
          }
        } catch (error) {
          console.error('Error processing cache entry:', cacheEntry.youtubeId, error);
        }
      }

      console.log('Cleaned up stuck states and invalid cache entries from previous session');
    } catch (error) {
      console.error('Error cleaning up stuck states:', error);
    }
  }

  // Add new method to refresh YouTube recommendations
  private async refreshYoutubeRecommendationsPool(): Promise<void> {
    // Only refresh if pool is running low
    if (this.youtubeRecommendationsPool.length >= 5) {
      console.log('[DEBUG] refreshYoutubeRecommendationsPool: Pool size sufficient, skipping refresh');
      return;
    }

    try {
      console.log('[DEBUG] refreshYoutubeRecommendationsPool: Starting refresh');
      
      // Get popular tracks to use as seeds
      const popularTracks = await prisma.request.groupBy({
        by: ['youtubeId'],
        _count: {
          youtubeId: true
        },
        orderBy: {
          _count: {
            youtubeId: 'desc'
          }
        },
        take: 10 // Get more tracks to try as seeds
      });

      if (popularTracks.length === 0) {
        console.log('[DEBUG] refreshYoutubeRecommendationsPool: No popular tracks found');
        return;
      }

      console.log(`[DEBUG] refreshYoutubeRecommendationsPool: Found ${popularTracks.length} popular tracks to use as seeds`);

      // Try multiple seed tracks if needed
      let newRecommendations: Array<{ youtubeId: string }> = [];
      let attempts = 0;
      
      while (newRecommendations.length === 0 && attempts < 3 && attempts < popularTracks.length) {
        // Pick a random popular track as seed
        const seedTrack = popularTracks[attempts];
        
        try {
          console.log(`[DEBUG] refreshYoutubeRecommendationsPool: Trying seed track ${seedTrack.youtubeId} (attempt ${attempts + 1})`);
          // Get recommendations from YouTube
          const recommendations = await getYoutubeRecommendations(seedTrack.youtubeId);
          
          if (recommendations.length > 0) {
            // Filter out the current track and any tracks in the queue
            const filteredRecommendations = recommendations.filter(rec => {
              // Skip if it's the current track
              if (this.currentTrack && rec.youtubeId === this.currentTrack.youtubeId) {
                console.log(`[DEBUG] refreshYoutubeRecommendationsPool: Filtering out current track ${rec.youtubeId}`);
                return false;
              }
              
              // Skip if it's in the user queue
              if (this.queue.some(track => track.youtubeId === rec.youtubeId)) {
                console.log(`[DEBUG] refreshYoutubeRecommendationsPool: Filtering out queued track ${rec.youtubeId}`);
                return false;
              }
              
              // Skip if it's in the autoplay queue
              if (this.autoplayQueue.some(track => track.youtubeId === rec.youtubeId)) {
                console.log(`[DEBUG] refreshYoutubeRecommendationsPool: Filtering out autoplay queued track ${rec.youtubeId}`);
                return false;
              }
              
              // Skip if it's in the recommendations pool
              if (this.youtubeRecommendationsPool.some(track => track.youtubeId === rec.youtubeId)) {
                console.log(`[DEBUG] refreshYoutubeRecommendationsPool: Filtering out pooled track ${rec.youtubeId}`);
                return false;
              }
              
              return true;
            });
            
            console.log(`[DEBUG] refreshYoutubeRecommendationsPool: Found ${recommendations.length} recommendations, ${filteredRecommendations.length} after filtering`);
            
            if (filteredRecommendations.length > 0) {
              newRecommendations = filteredRecommendations;
              console.log(`[DEBUG] refreshYoutubeRecommendationsPool: Using ${filteredRecommendations.length} recommendations from seed ${seedTrack.youtubeId}`);
              break;
            }
          }
        } catch (error) {
          console.error(`[DEBUG] refreshYoutubeRecommendationsPool: Failed to get recommendations for seed ${seedTrack.youtubeId}:`, error);
        }
        
        attempts++;
      }
      
      if (newRecommendations.length === 0) {
        console.log('[DEBUG] refreshYoutubeRecommendationsPool: Could not get any valid recommendations after all attempts');
        return;
      }
      
      // Filter out duplicates (should be redundant now but keeping as safety)
      const existingIds = new Set(this.youtubeRecommendationsPool.map(r => r.youtubeId));
      const uniqueNewRecommendations = newRecommendations.filter(r => !existingIds.has(r.youtubeId));
      
      this.youtubeRecommendationsPool.push(...uniqueNewRecommendations);
      console.log(`[DEBUG] refreshYoutubeRecommendationsPool: Final pool size: ${this.youtubeRecommendationsPool.length}`);
    } catch (error) {
      console.error('[DEBUG] refreshYoutubeRecommendationsPool: Error refreshing recommendations:', error);
    }
  }

  getVolume(): number {
    return this.volume;
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.audioPlayer.state.status === AudioPlayerStatus.Playing) {
      const resource = this.audioPlayer.state.resource;
      if (resource && resource.volume) {
        resource.volume.setVolume(this.volume);
      }
    }
  }

  private cleanSongTitle(title: string): string {
    return title
      // Remove common video decorators
      .replace(/【.*?】|\[.*?\]|［.*?］|〈.*?〉|（.*?）|\(.*?\)|feat\.|ft\.|Music Video|MV|Official/gi, '')
      // Remove artist attributions
      .replace(/歌ってみた|cover|covered by|arrange|アレンジ|remix|リミックス/gi, '')
      // Remove common artist names and version indicators
      .replace(/初音ミク|ミク|miku|GUMI|グミ|リン|レン|ルカ|KAITO|MEIKO|ver\.|version/gi, '')
      // Clean up extra whitespace
      .replace(/\s+/g, ' ')
      .trim();
  }

  private areSongsSimilar(title1: string, title2: string): boolean {
    const clean1 = this.cleanSongTitle(title1);
    const clean2 = this.cleanSongTitle(title2);

    // If either title is empty after cleaning, they're not similar
    if (!clean1 || !clean2) return false;

    // Direct match after cleaning
    if (clean1 === clean2) return true;

    // Check if one title contains the other
    if (clean1.includes(clean2) || clean2.includes(clean1)) return true;

    // Split into words and check overlap
    const words1 = clean1.split(/\s+/);
    const words2 = clean2.split(/\s+/);

    // If one title has only one word, require exact match
    if (words1.length === 1 || words2.length === 1) {
      return clean1 === clean2;
    }

    // Count matching words
    const matchingWords = words1.filter(word => 
      words2.some(w2 => w2 === word || 
        // Also check for partial matches for Japanese titles
        (word.length > 2 && w2.includes(word)) || 
        (w2.length > 2 && word.includes(w2))
      )
    );

    // Calculate similarity score
    const similarityScore = matchingWords.length / Math.max(words1.length, words2.length);
    return similarityScore > 0.5; // Require more than 50% similarity
  }

  public hasCurrentTrack(): boolean {
    return !!this.currentTrack;
  }

  setWebPresence(active: boolean) {
    // Only proceed if there's a state change
    if (active === this.hasWebPresence) return;

    this.hasWebPresence = active;
    console.log(`Web presence state change: active=${active}, hasActiveUsers=${this.hasActiveUsers}, isPlayerPaused=${this.isPlayerPaused}, hasCurrentTrack=${this.hasCurrentTrack()}`);

    // Initialize voice connection if needed for web users
    if (active && !this.connection) {
      console.log('Web user active, initializing voice connection');
      this.initializeVoiceConnection().catch(error => {
        console.error('Failed to initialize voice connection:', error);
      });
    }

    // Resume playback if we have web presence and the player is paused
    if (active && this.isPlayerPaused && this.hasCurrentTrack()) {
      console.log('Web presence active, resuming playback');
      this.resume();
      this.isPlayerPaused = false;
    }
    // Pause playback if we have no web presence and no active users
    else if (!active && !this.hasActiveUsers && !this.isPlayerPaused && this.hasCurrentTrack()) {
      console.log('No web presence and no active users, pausing playback');
      this.pause();
      this.isPlayerPaused = true;
    }
  }

  // New method to prefetch audio for upcoming tracks in the queue
  private async prefetchQueueAudio(count: number = 3): Promise<void> {
    try {
      // Get the next few tracks from both queues
      const tracksToFetch = [...this.queue, ...this.autoplayQueue].slice(0, count);
      
      for (const track of tracksToFetch) {
        this.prefetchAudioForTrack(track.youtubeId, track.title);
      }
    } catch (error) {
      console.error('Error prefetching queue audio:', error);
    }
  }

  // Helper method to prefetch audio for a single track
  private prefetchAudioForTrack(youtubeId: string, title: string = 'Unknown'): void {
    // Skip if already downloading or in downloadingTracks set
    if (this.downloadingTracks.has(youtubeId)) {
      return;
    }
    
    // Add to downloading set to prevent duplicate downloads
    this.downloadingTracks.add(youtubeId);
    
    // Check if already cached and download in background if needed
    (async () => {
      try {
        // Check if already cached
        const audioCache = await prisma.audioCache.findUnique({
          where: { youtubeId },
          include: { track: true }
        });
        
        if (audioCache && fs.existsSync(audioCache.filePath)) {
          console.log(`Audio already cached for track: ${title} (${youtubeId})`);
          this.downloadingTracks.delete(youtubeId);
          return;
        }
        
        // Download in background
        console.log(`Prefetching audio for track: ${title} (${youtubeId})`);
        await this.downloadTrackAudio(youtubeId);
        console.log(`Prefetch complete for: ${title} (${youtubeId})`);
      } catch (error) {
        console.error(`Failed to prefetch audio for ${title} (${youtubeId}):`, error);
      } finally {
        this.downloadingTracks.delete(youtubeId);
      }
    })().catch(error => {
      console.error(`Unhandled error in prefetch for ${youtubeId}:`, error);
      this.downloadingTracks.delete(youtubeId);
    });
  }

  // New method to set up audio pipeline for continuous streaming
  setupAudioPipeline(outputStream: NodeJS.WritableStream): void {
    console.log('Setting up audio pipeline for client');
    
    // Add this stream to active streams
    this.activeAudioStreams.add(outputStream);
    
    // Handle stream end/error
    outputStream.on('close', () => {
      this.activeAudioStreams.delete(outputStream);
      console.log('Audio stream closed, removed from active streams');
    });
    
    outputStream.on('error', (error) => {
      console.error('Audio stream error:', error);
      this.activeAudioStreams.delete(outputStream);
    });
    
    // If we have a current track, start streaming it immediately
    if (this.currentTrack && this.audioPlayer.state.status === AudioPlayerStatus.Playing) {
      this.streamCurrentTrackToClient(outputStream);
    }
  }
  
  // Helper method to stream current track to a client
  private async streamCurrentTrackToClient(outputStream: NodeJS.WritableStream): Promise<void> {
    if (!this.currentTrack || !outputStream.writable) return;
    
    try {
      // Get audio file path from cache
      const audioCache = await prisma.audioCache.findUnique({
        where: { youtubeId: this.currentTrack.youtubeId }
      });
      
      if (!audioCache || !fs.existsSync(audioCache.filePath)) {
        console.error('Audio file not found for streaming:', this.currentTrack.youtubeId);
        return;
      }
      
      // Create a read stream for the audio file
      const audioReadStream = fs.createReadStream(audioCache.filePath);
      
      // Pipe directly to output stream but don't end it when this file ends
      audioReadStream.pipe(outputStream, { end: false });
      
      // When the audio file ends, don't close the output stream
      audioReadStream.on('end', () => {
        const trackTitle = this.currentTrack?.title || 'Unknown';
        console.log(`Finished streaming track: ${trackTitle}`);
        // Don't end the output stream, it will be used for the next track
      });
      
      console.log(`Streaming track to client: ${this.currentTrack.title}`);
    } catch (error) {
      console.error('Error streaming track to client:', error);
    }
  }

  private async getVoiceConnection(voiceState: VoiceState): Promise<VoiceConnection | null> {
    try {
      // Initialize voice connection if not already connected
      if (!this.connection) {
        console.log('No voice connection, initializing...');
        await this.initializeVoiceConnection();
        
        // Wait for connection to be ready
        if (!this.connection) {
          console.log('Failed to establish voice connection');
          return null;
        }
        
        // Ensure we're in the right state for web users
        if (this.hasWebPresence) {
          this.hasActiveUsers = false;
          this.isPlayerPaused = false;
          console.log('Web presence active, preparing for playback');
        }
      }
      return this.connection;
    } catch (error) {
      console.error('Error getting voice connection:', error);
      return null;
    }
  }

  // Add new method to initialize active playlist
  private async initializeActivePlaylist(): Promise<void> {
    try {
      console.log('[DEBUG] initializeActivePlaylist: Checking for active playlists');
      const activePlaylist = await prisma.defaultPlaylist.findFirst({
        where: { active: true },
        include: {
          tracks: {
            include: {
              track: true
            }
          }
        }
      });

      if (activePlaylist) {
        console.log(`[DEBUG] initializeActivePlaylist: Found active playlist "${activePlaylist.name}" with ${activePlaylist.tracks.length} tracks in ${activePlaylist.mode} mode`);
        this.currentPlaylistId = activePlaylist.id;
      } else {
        console.log('[DEBUG] initializeActivePlaylist: No active playlists found');
        this.currentPlaylistId = undefined;
      }
    } catch (error) {
      console.error('[DEBUG] initializeActivePlaylist: Error:', error);
    }
  }

  // Add method to set current playlist
  public async setCurrentPlaylist(playlistId: string | undefined): Promise<void> {
    console.log(`[DEBUG] setCurrentPlaylist: Setting current playlist to ${playlistId}`);
    this.currentPlaylistId = playlistId;
    
    if (playlistId) {
      const playlist = await prisma.defaultPlaylist.findUnique({
        where: { id: playlistId },
        include: {
          tracks: {
            include: {
              track: true
            }
          }
        }
      });

      if (playlist) {
        console.log(`[DEBUG] setCurrentPlaylist: Successfully set playlist "${playlist.name}" with ${playlist.tracks.length} tracks in ${playlist.mode} mode`);
      } else {
        console.log('[DEBUG] setCurrentPlaylist: WARNING - Playlist not found, clearing ID');
        this.currentPlaylistId = undefined;
      }
    } else {
      console.log('[DEBUG] setCurrentPlaylist: Cleared current playlist');
    }
  }
}
