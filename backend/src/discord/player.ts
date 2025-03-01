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
import jwt from 'jsonwebtoken';
import { spawn } from 'child_process';
import { TrackingService } from '../tracking/service.js';
import { RecommendationEngine } from '../recommendation/engine.js';
import { ChildProcessWithoutNullStreams } from 'child_process';
import { resolveYouTubeMusicId } from '../utils/youtubeMusic.js';
import { RequestStatus, PlaylistMode, TrackStatus } from '../types/enums.js';
import { broadcastPlayerState } from '../routes/music.js';

// Base types
interface Track {
  youtubeId: string;
  title: string;
  thumbnail: string;
  duration: number;
  isMusicUrl?: boolean;
  resolvedYtId?: string | null;
  isActive?: boolean;
}

interface Request {
  youtubeId: string;
  userId: string;
  requestedAt: Date;
  playedAt?: Date | null;
  isAutoplay: boolean;
  status: RequestStatus;
}

// Common interfaces
interface BaseTrackResult {
  youtubeId: string;
  title: string;
  thumbnail: string | null;
  duration: number;
}

interface ExtendedTrackResult extends BaseTrackResult {
  globalScore?: number;
  playCount?: number;
  skipCount?: number;
  isActive?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

interface QueuedTrack extends BaseTrackResult {
  requestedBy?: {
    userId: string;
    username: string;
    avatar?: string;
  };
  queuePosition?: number;
  willPlayNext?: boolean;
  isPlaying?: boolean;
}

interface UserInfo {
  username: string;
  discriminator: string;
  avatar: string | null;
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
  isAutoplay: boolean;
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
  private readonly AUTOPLAY_BUFFER_SIZE = 5;
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

  private readonly WEIGHTS = {
    PLAYLIST: 0.25,    // 25% for playlist tracks
    FAVORITES: 0.25,   // 25% for user favorites
    POPULAR: 0.20,     // 20% for popular tracks
    YOUTUBE: 0.20,     // 20% for YouTube recommendations
    RANDOM: 0.10       // 10% for random tracks
  } as const;

  constructor(
    client: Client,
    trackingService: TrackingService,
    recommendationEngine: RecommendationEngine
  ) {
    this.client = client;
    this.trackingService = trackingService;
    this.recommendationEngine = recommendationEngine;
    this.audioPlayer = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Play
      }
    });

    // Ensure bot user exists in database
    this.ensureBotUser().catch(error => {
      console.error('Failed to ensure bot user exists:', error);
    });

    // Clean up any stuck states from previous sessions
    this.cleanupStuckStates().catch(error => {
      console.error('Failed to cleanup stuck states:', error);
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

  private async ensureBotUser(): Promise<void> {
    if (!this.client.user) {
      console.error('Bot user not available');
      return;
    }

    try {
      await prisma.user.upsert({
        where: { id: this.client.user.id },
        create: {
          id: this.client.user.id,
          username: this.client.user.username || 'Bot',
          discriminator: this.client.user.discriminator || '0000',
          avatar: this.client.user.avatar
        },
        update: {
          username: this.client.user.username || 'Bot',
          discriminator: this.client.user.discriminator || '0000',
          avatar: this.client.user.avatar
        }
      });
      console.log('✓ Bot user ensured in database');
    } catch (error) {
      console.error('Failed to ensure bot user:', error);
      throw error;
    }
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
    voiceState: any, 
    youtubeId: string, 
    userId: string, 
    userInfo: { username: string; discriminator: string; avatar: string | null },
    isMusicUrl: boolean = false
  ): Promise<any> {
    try {
      // Ensure youtubeId is a string
      if (typeof youtubeId !== 'string') {
        console.error('Invalid youtubeId type:', typeof youtubeId);
        throw new Error('Invalid YouTube ID');
      }

      // Ensure userId is valid
      if (!userId) {
        console.error('Invalid userId:', userId);
        throw new Error('Invalid user ID');
      }

      // Check if user exists in database
      const user = await prisma.user.findUnique({
        where: { id: userId }
      });

      // Create user if it doesn't exist
      if (!user) {
        await prisma.user.create({
          data: {
            id: userId,
            username: userInfo.username,
            discriminator: userInfo.discriminator,
            avatar: userInfo.avatar
          }
        });
        console.log(`Created user in database: ${userId}`);
      }

      // Check if we're already playing this track
      if (this.currentTrack?.youtubeId === youtubeId && this.isPlaying()) {
        console.log(`🎵 Already playing ${youtubeId}`);
        return;
      }

      // Check if we need to resolve a YouTube Music ID
      let resolvedId = youtubeId;
      let needsResolution = false;

      if (youtubeId.startsWith('https://music.youtube.com/') || 
          youtubeId.startsWith('https://www.youtube.com/') || 
          youtubeId.startsWith('https://youtu.be/')) {
        needsResolution = true;
        try {
          const resolved = await resolveYouTubeMusicId(youtubeId);
          if (resolved) {
            resolvedId = resolved;
            console.log(`🎵 Resolved YouTube Music ID: ${youtubeId} -> ${resolvedId}`);
          } else {
            // Use the original ID as fallback
            const extractedId = extractYoutubeId(youtubeId);
            resolvedId = extractedId || youtubeId;
            console.log(`🎵 Using original ID as fallback: ${resolvedId}`);
          }
        } catch (error) {
          console.error('❌ Failed to resolve YouTube Music ID:', error);
          // Use the original ID as fallback
          const extractedId = extractYoutubeId(youtubeId);
          resolvedId = extractedId || youtubeId;
          console.log(`🎵 Using original ID as fallback: ${resolvedId}`);
        }
      }

      // Get track info
      const info = await getYoutubeInfo(resolvedId);
      
      // Update track status to PLAYING
      await prisma.track.update({
        where: { youtubeId },
        data: {
          status: TrackStatus.PLAYING,
          lastPlayed: new Date()
        }
      });

      // Save track info to database
      await prisma.track.upsert({
        where: { youtubeId },
        create: {
          youtubeId,
          resolvedYtId: resolvedId !== youtubeId ? resolvedId : null,
          title: info.title,
          thumbnail: info.thumbnail,
          duration: info.duration,
          isActive: true,
          status: TrackStatus.PLAYING,
          lastPlayed: new Date()
        },
        update: {
          resolvedYtId: resolvedId !== youtubeId ? resolvedId : null,
          title: info.title,
          thumbnail: info.thumbnail,
          duration: info.duration,
          isActive: true,
          status: TrackStatus.PLAYING,
          lastPlayed: new Date()
        }
      });

      // Update request status
      await prisma.request.updateMany({
        where: {
          youtubeId,
          status: RequestStatus.PENDING
        },
        data: {
          status: RequestStatus.QUEUED
        }
      });

      console.log(`=== Starting play request for: ${youtubeId}`);
      console.log(`Initial state - isMusicUrl: ${isMusicUrl}`);

      let trackInfo;
      let useCachedData = false;

      // Check if we have a cached track with valid files
      console.log('=== Checking cache using original youtubeId ===');
      const cachedTrack = await prisma.track.findUnique({
        where: { youtubeId }
      });
      console.log('Cache lookup result:', cachedTrack ? 'Found in database' : 'Not in database');

      const audioCache = await prisma.audioCache.findUnique({
        where: { youtubeId }
      });
      console.log('Audio cache lookup result:', audioCache ? 'Found' : 'Not found');

      // If we have cache and files exist, verify them
      if (cachedTrack && audioCache && fs.existsSync(audioCache.filePath)) {
        console.log('=== Found valid cache entries, checking thumbnail ===');
        const thumbnailCache = await prisma.thumbnailCache.findUnique({
          where: { youtubeId }  // Always use original youtubeId
        });
        console.log('Thumbnail cache lookup result:', thumbnailCache ? 'Found' : 'Not found');

        // First verify audio duration
        console.log('=== Verifying audio duration ===');
        const duration = await getAudioFileDuration(audioCache.filePath);
        console.log(`Duration check - Cached: ${cachedTrack.duration}, Actual: ${duration}`);
        
        if (Math.abs(duration - cachedTrack.duration) < 1) { // Allow 1 second difference
          // If thumbnail exists and file exists, we can use cache
          if (thumbnailCache && fs.existsSync(thumbnailCache.filePath)) {
            console.log(`🎵 [CACHE] All cache components valid, using cached track: ${cachedTrack.title}`);
            console.log(`Original resolvedYtId from cache: ${cachedTrack.resolvedYtId || 'none'}`);
            trackInfo = {
              title: cachedTrack.title,
              thumbnail: cachedTrack.thumbnail,
              duration: cachedTrack.duration
            };
            // Use resolvedId from cache if available for music URLs
            resolvedId = cachedTrack.resolvedYtId || youtubeId;
            console.log(`Using resolvedId: ${resolvedId} (from cache)`);
            isMusicUrl = false; // Skip music URL resolution since we have cache
            console.log('Set isMusicUrl to false since using cache');
            useCachedData = true;
          } else {
            console.log('❌ Thumbnail missing or invalid, attempting to recreate...');
            // If thumbnail is missing but we have other cache, try to recreate it
            try {
              // Use cached resolvedId if available for recreation
              const infoId = cachedTrack.resolvedYtId || youtubeId;
              console.log(`Fetching info for thumbnail using ID: ${infoId}`);
              const info = await getYoutubeInfo(infoId);
              await prisma.thumbnailCache.upsert({
                where: { youtubeId },
                create: {
                  youtubeId,
                  filePath: path.join(process.env.CACHE_DIR || 'cache', 'thumbnails', `${youtubeId}.jpg`)
                },
                update: {
                  filePath: path.join(process.env.CACHE_DIR || 'cache', 'thumbnails', `${youtubeId}.jpg`)
                }
              });
              console.log('✓ Thumbnail cache recreated');
              // Now we can use the cache
              trackInfo = {
                title: cachedTrack.title,
                thumbnail: cachedTrack.thumbnail,
                duration: cachedTrack.duration
              };
              resolvedId = cachedTrack.resolvedYtId || youtubeId;
              isMusicUrl = false;
              useCachedData = true;
            } catch (error) {
              console.error('Failed to recreate thumbnail cache:', error);
            }
          }
        } else {
          console.log('❌ Duration mismatch, cannot use cache');
        }
      } else {
        console.log('❌ Cache validation failed - Missing database entry or audio file');
      }

      // Get track info if not using cache
      if (!useCachedData) {
        console.log('=== No valid cache found or cache incomplete, getting fresh track info ===');
        // First resolve YouTube Music URL if needed
        if (isMusicUrl) {
          console.log('Detected YouTube Music URL, attempting to resolve to regular YouTube ID...');
          const resolved = await resolveYouTubeMusicId(youtubeId);
          if (!resolved) {
            console.log('❌ Failed to resolve YouTube Music URL');
            throw new Error('Failed to resolve YouTube Music URL');
          }
          resolvedId = resolved;
          console.log(`Successfully resolved to: ${resolvedId}`);
      }

      // Get track info using the resolved ID
        console.log(`Fetching track info for ID: ${resolvedId}`);
        trackInfo = await getYoutubeInfo(resolvedId);
        console.log(`Retrieved track info: ${trackInfo.title}`);

        // Save track info using original youtubeId
        console.log('=== Saving track info to database ===');
        console.log(`Using original youtubeId for all cache: ${youtubeId}`);
        console.log(`Current resolvedId (for content only): ${resolvedId}`);
        
        // Save track info
        await prisma.track.upsert({
          where: { youtubeId },  // Always use original youtubeId
          create: {
            youtubeId,  // Always use original youtubeId
            title: trackInfo.title,
            duration: trackInfo.duration,
            thumbnail: trackInfo.thumbnail,
            isMusicUrl,
            resolvedYtId: resolvedId !== youtubeId ? resolvedId : null,
            isActive: true
          },
          update: {
            title: trackInfo.title,
            duration: trackInfo.duration,
            thumbnail: trackInfo.thumbnail,
            isMusicUrl,
            resolvedYtId: resolvedId !== youtubeId ? resolvedId : null,
            isActive: true
          }
        });
        console.log('✓ Track info saved to database');

        // Save thumbnail cache with original youtubeId
        await prisma.thumbnailCache.upsert({
          where: { youtubeId },  // Always use original youtubeId
          create: {
            youtubeId,  // Always use original youtubeId
            filePath: path.join(process.env.CACHE_DIR || 'cache', 'thumbnails', `${youtubeId}.jpg`)
          },
          update: {
            filePath: path.join(process.env.CACHE_DIR || 'cache', 'thumbnails', `${youtubeId}.jpg`)
          }
        });
        console.log('✓ Thumbnail cache entry saved');

        // Download and cache audio using original youtubeId
        console.log('=== Downloading and caching audio ===');
        console.log(`Using original youtubeId for cache: ${youtubeId}`);
        console.log(`Using resolvedId for content: ${resolvedId}`);
        await this.downloadTrackAudio(youtubeId, resolvedId);
      }

      // Get voice connection
      console.log('=== Setting up playback ===');
      const connection = await this.getVoiceConnection(voiceState);
      if (!connection) {
        console.log('❌ Failed to get voice connection');
        throw new Error('Failed to join voice channel');
      }
      console.log('✓ Voice connection ready');

      // Create queue item with complete metadata
      const requestedAt = new Date();
      console.log('Creating queue item:', {
        youtubeId: youtubeId,  // Always use original youtubeId
        title: trackInfo.title,
        requestedBy: {
          userId: userId,
          username: userInfo.username,
          avatar: userInfo.avatar || undefined
        },
        isAutoplay: false
      });

      const queueItem: QueueItem = {
        youtubeId: youtubeId,  // Always use original youtubeId
        title: trackInfo.title,
        thumbnail: trackInfo.thumbnail,
        duration: trackInfo.duration,
        requestedBy: {
          userId: userId,
          username: userInfo.username,
          avatar: userInfo.avatar || undefined
        },
        requestedAt,
        isAutoplay: false
      };

      // If nothing is playing, start this track immediately
      if (this.audioPlayer.state.status === AudioPlayerStatus.Idle) {
        console.log('Player idle, starting playback immediately');
        this.currentTrack = queueItem;
        
        // Start audio download and playback
        try {
          console.log(`Getting audio resource using original youtubeId: ${youtubeId}`);
          const resource = await this.getAudioResource(youtubeId); // Use original youtubeId
          if (resource) {
            this.audioPlayer.play(resource);
            console.log('✓ Started immediate playback');
          } else {
            console.log('❌ Failed to get audio resource, adding to queue instead');
            this.queue.push(queueItem);
          }
        } catch (error) {
          console.error('Failed to start immediate playback:', error);
          console.log('Adding to queue due to playback error');
          this.queue.push(queueItem);
        }
      } else {
        console.log('Player busy, adding track to queue');
        this.queue.push(queueItem);
      }

      // Immediately update player state to reflect queue changes
      console.log('=== Updating player state ===');
      await this.updatePlayerState();

      // Start downloading audio for this track in the background
      this.prefetchAudioForTrack(resolvedId, trackInfo.title);

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
            userId: userId,
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
      const willPlayNext = this.audioPlayer.state.status === AudioPlayerStatus.Idle;
      const response = {
        youtubeId: youtubeId, // Use original youtubeId for consistency
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
      console.error('❌ Error playing track:', error);
      throw error;
    }
  }

  private async downloadTrackAudio(youtubeId: string, resolvedId: string): Promise<void> {
    try {
      // Check if already downloaded
      const audioCache = await prisma.audioCache.findUnique({
        where: { youtubeId }
      });

      if (audioCache && fs.existsSync(audioCache.filePath)) {
        console.log(`🎵 [CACHE] Found cached audio for: ${youtubeId}`);
        return;
      }

      console.log(`⬇️ [DOWNLOAD] Starting download for: ${youtubeId}`);
      
      // Download using resolvedId but save as youtubeId
      const tempPath = await downloadYoutubeAudio(resolvedId);
      const finalPath = path.join(path.dirname(tempPath), `${youtubeId}${path.extname(tempPath)}`);
      
      // Rename the file to use original youtubeId
      fs.renameSync(tempPath, finalPath);
      
      await prisma.audioCache.upsert({
        where: { youtubeId },
            create: {
          youtubeId,
          filePath: finalPath
            },
            update: {
          filePath: finalPath
        }
      });

      console.log(`✓ [DOWNLOAD] Completed for: ${youtubeId}`);
    } catch (error: any) {
      const errorMessage = error?.message || 'Unknown error';
      if (errorMessage.includes('Video unavailable')) {
        console.log(`❌ [DOWNLOAD] ${errorMessage}`);
      } else {
        console.error(`❌ [DOWNLOAD] Failed for ${youtubeId}: ${errorMessage}`);
      }
      throw error;
    }
  }

  private async getAudioResource(youtubeId: string): Promise<AudioResource | null> {
    let retryCount = 0;
    const maxRetries = 3;

    while (retryCount < maxRetries) {
      try {
        // Get cached audio file
        const audioCache = await prisma.audioCache.findUnique({
          where: { youtubeId }
        });

        if (!audioCache || !fs.existsSync(audioCache.filePath)) {
          const track = await prisma.track.findUnique({
            where: { youtubeId }
          });

          if (!track) {
            console.error(`Track not found in database: ${youtubeId}`);
            return null;
          }

          console.log(`Track found in database, resolvedYtId: ${track.resolvedYtId || 'none'}`);
          // Download using resolvedId if available, otherwise use original id
          const downloadId = track.resolvedYtId || youtubeId;
          console.log(`Using ID for download: ${downloadId}`);
          await this.downloadTrackAudio(youtubeId, downloadId);
      } else {
          console.log(`Found cached audio file for: ${youtubeId}`);
        }

        // Get the updated cache entry
        const updatedCache = await prisma.audioCache.findUnique({
          where: { youtubeId }
        });

        if (!updatedCache || !fs.existsSync(updatedCache.filePath)) {
          throw new Error(`Failed to get audio file for: ${youtubeId}`);
        }

        console.log(`Creating audio resource from file: ${path.basename(updatedCache.filePath)}`);
        const stream = createReadStream(updatedCache.filePath);
        const { stream: probeStream, type } = await demuxProbe(stream);
        
        return createAudioResource(probeStream, {
          inputType: type,
          inlineVolume: true
        });
      } catch (error) {
        console.error(`Attempt ${retryCount + 1} failed for ${youtubeId}:`, error);
        retryCount++;
        
        if (retryCount === maxRetries) {
          console.error(`All attempts failed for ${youtubeId}`);
          return null;
        }
        
        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    return null;
  }

  async skip(userId?: string): Promise<void> {
    try {
      if (!this.isPlaying || !this.currentTrack) {
      return;
    }

      // Update current track status to STANDBY
      if (this.currentTrack) {
        await prisma.track.update({
          where: { youtubeId: this.currentTrack.youtubeId },
      data: {
            status: TrackStatus.STANDBY
          }
        });
      }

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

      // If we have tracks in the queue, play the next one
      if (this.queue.length > 0 || this.autoplayQueue.length > 0) {
        console.log('Found tracks in queue, playing next track');
        await this.playNext();
      } else if (this.isAutoplayEnabled()) {
        console.log('No tracks in queue, attempting autoplay');
        // Try to get a new track from autoplay
        await this.handleAutoplay();
      } else {
        console.log('No tracks in queue and autoplay is disabled');
      }
    } catch (error) {
      console.error('❌ Error skipping track:', error);
      // If somehow we got here without a current track, try to play next anyway
      await this.playNext();
    }
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

      // Format requestedBy data
      const formatRequestedBy = (requestedBy: any) => ({
        id: requestedBy?.userId || 'unknown',
        userId: requestedBy?.userId || 'unknown',  // Keep userId for backward compatibility
        username: requestedBy?.username || 'Unknown User',
        avatar: requestedBy?.avatar || null
      });

      // Broadcast state update to all SSE clients
      const state = {
        status: this.getStatus(),
        currentTrack: this.currentTrack ? {
          youtubeId: this.currentTrack.youtubeId,
          title: this.currentTrack.title,
          thumbnail: this.currentTrack.thumbnail,
          duration: this.currentTrack.duration,
          requestedBy: formatRequestedBy(this.currentTrack.requestedBy),
          requestedAt: this.currentTrack.requestedAt,
          isAutoplay: this.currentTrack.isAutoplay
        } : null,
        queue: allQueueTracks.map(track => ({
          youtubeId: track.youtubeId,
          title: track.title,
          thumbnail: track.thumbnail,
          duration: track.duration,
          requestedBy: formatRequestedBy(track.requestedBy),
          requestedAt: track.requestedAt,
          isAutoplay: track.isAutoplay
        })),
        position: this.getPosition()
      };

      broadcastPlayerState(state);
    } catch (error) {
      console.error('Error updating player state:', error);
    }
  }

  private async cleanupStuckStates() {
    try {
      // Reset any PLAYING or PENDING states to EXPIRED
      await prisma.request.updateMany({
        where: {
          status: {
            in: [RequestStatus.PLAYING, RequestStatus.PENDING]
          }
        },
        data: {
          status: RequestStatus.EXPIRED
        }
      });

      // Reset any QUEUED states that are older than 10 minutes
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
      await prisma.request.updateMany({
        where: {
          status: RequestStatus.QUEUED,
          requestedAt: {
            lt: tenMinutesAgo
          }
        },
        data: {
          status: RequestStatus.EXPIRED
        }
      });

      // Reset completed requests that are causing cooldown issues
      await prisma.request.updateMany({
        where: {
          status: RequestStatus.COMPLETED,
          playedAt: {
            gte: new Date(Date.now() - 5 * 60 * 60 * 1000) // Last 5 hours
          }
        },
        data: {
          status: RequestStatus.EXPIRED,
          playedAt: new Date(0) // Set to epoch to clear cooldown
        }
      });

      // Clear the played tracks map
      this.playedTracks.clear();

      console.log('✨ Cleaned up stuck states and cleared cooldowns');
    } catch (error) {
      console.error('Error cleaning up states:', error);
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
    // Clean and normalize both titles
    const cleanTitle1 = this.cleanSongTitle(title1).toLowerCase();
    const cleanTitle2 = this.cleanSongTitle(title2).toLowerCase();

    // Split into words
    const words1 = cleanTitle1.split(/\s+/);
    const words2 = cleanTitle2.split(/\s+/);

    // Find matching words
    const matchingWords = words1.filter(word => 
      words2.some(w2 => 
        word === w2 || 
        (word.length > 2 && w2.includes(word)) || 
        (w2.length > 2 && word.includes(w2))
      )
    );

    // Calculate similarity score
    const similarityScore = matchingWords.length / Math.max(words1.length, words2.length);

    // Return true if similarity score is above threshold
    return similarityScore > 0.5;
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
        await this.downloadTrackAudio(youtubeId, youtubeId);
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
      
      // Update track status back to STANDBY since we couldn't play it
      await prisma.track.update({
        where: { youtubeId: nextTrack.youtubeId },
        data: {
          status: TrackStatus.STANDBY
        }
      });
      
      await this.playNext();
      return;
    }

    // Update current track data
    this.currentTrack = nextTrack;

    // Add intentional 1-second delay before playing the next track
    console.log(`Adding intentional 1-second delay before playing ${nextTrack.title}`);
    await new Promise(resolve => setTimeout(resolve, 1000)); // 1-second delay
    console.log(`Delay complete, now playing ${nextTrack.title}`);

    // Start playback
    this.audioPlayer.play(resource);

    // Stream to all connected clients
    for (const stream of this.activeAudioStreams) {
      this.streamCurrentTrackToClient(stream);
    }

    // Update track status to PLAYING
    await prisma.track.update({
      where: { youtubeId: nextTrack.youtubeId },
      data: {
        status: TrackStatus.PLAYING,
        lastPlayed: new Date()
      }
    });

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

  private async onTrackFinish() {
    if (this.currentTrack) {
      // Update track status to STANDBY
      await prisma.track.update({
        where: { youtubeId: this.currentTrack.youtubeId },
        data: {
          status: TrackStatus.STANDBY
        }
      });

      // Add to played tracks for cooldown
      this.playedTracks.set(this.currentTrack.youtubeId, Date.now());
      
      // Update request status
      await prisma.request.updateMany({
        where: {
          youtubeId: this.currentTrack.youtubeId,
          requestedAt: this.currentTrack.requestedAt
        },
        data: {
          status: RequestStatus.COMPLETED
        }
      });
      
      // Update track stats
      const voiceChannel = this.connection?.joinConfig.channelId;
      if (voiceChannel && this.connection) {
        const guild = this.client.guilds.cache.get(this.connection.joinConfig.guildId);
        if (guild) {
          const channel = guild.channels.cache.get(voiceChannel);
          if (channel?.isVoiceBased()) {
            const userIds = Array.from(channel.members.keys());
            // Update user stats for track completion
            for (const userId of userIds) {
              await this.trackingService.trackUserLeave(
                userId,
                this.currentTrack.youtubeId,
                this.currentTrack.duration, // Full duration for completed tracks
                this.currentTrack.duration,
                false // Not skipped
              );
            }
          }
        }
      }
    }
    
    // Play next track
    await this.playNext();
  }

  // Add missing methods
  public getCurrentTrack(): QueueItem | undefined {
    return this.currentTrack;
  }

  public getQueue(): QueueItem[] {
    return [...this.queue, ...this.autoplayQueue];
  }

  public getStatus(): string {
    if (this.audioPlayer.state.status === AudioPlayerStatus.Playing) {
      return 'playing';
    } else if (this.audioPlayer.state.status === AudioPlayerStatus.Paused) {
      return 'paused';
    } else {
      return 'idle';
    }
  }

  public getPosition(): number {
    if (this.audioPlayer.state.status === AudioPlayerStatus.Playing || 
        this.audioPlayer.state.status === AudioPlayerStatus.Paused) {
      const resource = this.audioPlayer.state.resource;
      if (resource) {
        return resource.playbackDuration / 1000; // Convert to seconds
      }
    }
    return 0;
  }

  public isPlaying(): boolean {
    return this.audioPlayer.state.status === AudioPlayerStatus.Playing;
  }

  public pause(): void {
    if (this.audioPlayer.state.status === AudioPlayerStatus.Playing) {
      this.audioPlayer.pause();
    }
  }

  public resume(): void {
    if (this.audioPlayer.state.status === AudioPlayerStatus.Paused) {
      this.audioPlayer.unpause();
    }
  }

  public stop(force: boolean = false): void {
    this.audioPlayer.stop(force);
  }

  private handlePlaybackError(): void {
    console.error('Playback error occurred, attempting to play next track');
    this.playNext().catch(error => {
      console.error('Failed to play next track after error:', error);
    });
  }

  private async prefetchAutoplayTracks(): Promise<void> {
    try {
      // Only prefetch if autoplay is enabled and queue is running low
      if (!this.autoplayEnabled || this.autoplayQueue.length >= this.AUTOPLAY_BUFFER_SIZE) {
        return;
      }

      console.log(`Prefetching autoplay tracks (current autoplay queue: ${this.autoplayQueue.length})`);
      
      // Ensure bot user exists in database
      const botUserId = this.client.user?.id;
      if (!botUserId) {
        console.error('Bot user ID is undefined, cannot create autoplay tracks');
        return;
      }

      // Check if bot user exists in database
      const botUser = await prisma.user.findUnique({
        where: { id: botUserId }
      });

      // Create bot user if it doesn't exist
      if (!botUser) {
        await prisma.user.create({
          data: {
            id: botUserId,
            username: this.client.user?.username || 'Bot',
            discriminator: this.client.user?.discriminator || '0000',
            avatar: this.client.user?.avatar || null
          }
        });
        console.log('Created bot user in database');
      }
      
      // First try to get tracks from the active playlist if available
      let tracksToAdd: { youtubeId: string }[] = [];
      
      if (this.currentPlaylistId) {
        console.log(`[DEBUG] prefetchAutoplayTracks: Using active playlist ${this.currentPlaylistId}`);
        
        // Get the playlist with tracks
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
        
        if (playlist && playlist.tracks.length > 0) {
          console.log(`[DEBUG] prefetchAutoplayTracks: Found playlist "${playlist.name}" with ${playlist.tracks.length} tracks`);
          
          // Handle different playlist modes
          if (playlist.mode === 'LINEAR') {
            // In LINEAR mode, get the next tracks in sequence
            const tracksToTake = this.AUTOPLAY_BUFFER_SIZE - this.autoplayQueue.length;
            const sortedTracks = [...playlist.tracks].sort((a, b) => a.position - b.position);
            
            // Find the next position after the current one
            let nextPosition = 0;
            if (this.currentTrack) {
              const currentTrackInPlaylist = sortedTracks.find(t => t.track.youtubeId === this.currentTrack?.youtubeId);
              if (currentTrackInPlaylist) {
                nextPosition = currentTrackInPlaylist.position + 1;
              }
            }
            
            // Get tracks starting from nextPosition, wrapping around if needed
            let selectedTracks: typeof sortedTracks = [];
            for (let i = 0; i < tracksToTake; i++) {
              const index = (nextPosition + i) % sortedTracks.length;
              selectedTracks.push(sortedTracks[index]);
            }
            
            tracksToAdd = selectedTracks.map(t => ({ youtubeId: t.track.youtubeId }));
            console.log(`[DEBUG] prefetchAutoplayTracks: Selected ${tracksToAdd.length} tracks from LINEAR playlist starting at position ${nextPosition}`);
          } else {
            // In POOL mode, select random tracks
            const tracksToTake = this.AUTOPLAY_BUFFER_SIZE - this.autoplayQueue.length;
            const availableTracks = playlist.tracks.filter(t => 
              !this.isTrackInQueue(t.track.youtubeId) && 
              !this.isTrackRecentlyPlayed(t.track.youtubeId)
            );
            
            if (availableTracks.length > 0) {
              // Shuffle and take needed tracks
              const shuffled = [...availableTracks].sort(() => Math.random() - 0.5);
              const selected = shuffled.slice(0, tracksToTake);
              tracksToAdd = selected.map(t => ({ youtubeId: t.track.youtubeId }));
              console.log(`[DEBUG] prefetchAutoplayTracks: Selected ${tracksToAdd.length} random tracks from POOL playlist`);
            }
          }
        }
      }
      
      // If we couldn't get enough tracks from the playlist, fall back to YouTube recommendations
      if (tracksToAdd.length < (this.AUTOPLAY_BUFFER_SIZE - this.autoplayQueue.length)) {
        console.log(`[DEBUG] prefetchAutoplayTracks: Need more tracks, falling back to YouTube recommendations`);
        
        // Refresh YouTube recommendations pool if needed
        if (this.youtubeRecommendationsPool.length < this.AUTOPLAY_PREFETCH_THRESHOLD) {
          await this.refreshYoutubeRecommendationsPool();
        }

        // Get recommendations from the pool
        const ytRecommendations = this.youtubeRecommendationsPool.splice(0, 
          this.AUTOPLAY_BUFFER_SIZE - this.autoplayQueue.length - tracksToAdd.length);
        
        tracksToAdd = [...tracksToAdd, ...ytRecommendations];
      }
      
      if (tracksToAdd.length === 0) {
        console.log('No tracks available for autoplay');
        return;
      }

      // Process each track to add
      for (const rec of tracksToAdd) {
        try {
          // Skip if already in queue or recently played
          if (this.isTrackInQueue(rec.youtubeId) || this.isTrackRecentlyPlayed(rec.youtubeId)) {
            continue;
          }

          // Get track info
          const info = await getYoutubeInfo(rec.youtubeId);
          
          // Create autoplay queue item
          const queueItem: QueueItem = {
            youtubeId: rec.youtubeId,
            title: info.title,
            thumbnail: info.thumbnail,
            duration: info.duration,
            requestedBy: {
              userId: botUserId, // Use the verified bot user ID
              username: this.client.user?.username || 'Autoplay',
              avatar: this.client.user?.avatar || undefined
            },
            requestedAt: new Date(),
            isAutoplay: true
          };
          
          // Add to autoplay queue
          this.autoplayQueue.push(queueItem);
          console.log(`Added autoplay track: ${info.title}`);
          
          // Start downloading in background
          this.prefetchAudioForTrack(rec.youtubeId, info.title);
        } catch (error) {
          console.error(`Failed to process autoplay track ${rec.youtubeId}:`, error);
        }
      }
      
      console.log(`Autoplay queue now has ${this.autoplayQueue.length} tracks`);
      
      // Update player state to reflect the new autoplay queue
      if (this.autoplayQueue.length > 0) {
        await this.updatePlayerState();
      }
    } catch (error) {
      console.error('Error prefetching autoplay tracks:', error);
    }
  }

  private isTrackInQueue(youtubeId: string): boolean {
    return this.queue.some(track => track.youtubeId === youtubeId) || 
           this.autoplayQueue.some(track => track.youtubeId === youtubeId) ||
           (this.currentTrack?.youtubeId === youtubeId);
  }

  private isTrackRecentlyPlayed(youtubeId: string): boolean {
    const playedTime = this.playedTracks.get(youtubeId);
    if (!playedTime) return false;
    
    const now = Date.now();
    return (now - playedTime) < this.PLAYED_TRACKS_EXPIRY;
  }

  private async handleAutoplay(): Promise<void> {
    if (!this.autoplayEnabled) {
      console.log('Autoplay is disabled');
      return;
    }

    // Prefetch autoplay tracks if needed
    if (this.autoplayQueue.length === 0) {
      await this.prefetchAutoplayTracks();
    }

    // If we have autoplay tracks, play the next one
    if (this.autoplayQueue.length > 0) {
      await this.playNext();
    } else {
      console.log('No autoplay tracks available');
    }
  }

  public isAutoplayEnabled(): boolean {
    return this.autoplayEnabled;
  }
}

// Helper function to extract YouTube ID from URL
function extractYoutubeId(url: string): string | null {
  try {
    if (url.includes('youtu.be/')) {
      return url.split('youtu.be/')[1]?.split(/[?&]/)[0] || null;
    } else if (url.includes('youtube.com/')) {
      const urlObj = new URL(url);
      if (urlObj.pathname.includes('/watch')) {
        return urlObj.searchParams.get('v');
      } else if (urlObj.pathname.includes('/embed/')) {
        return urlObj.pathname.split('/embed/')[1]?.split(/[?&]/)[0] || null;
      }
    }
    return null;
  } catch (error) {
    console.error('Failed to extract YouTube ID:', error);
    return null;
  }
}
