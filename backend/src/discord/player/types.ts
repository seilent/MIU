import { RequestStatus, PlaylistMode, TrackStatus } from '../../types/enums.js';

// Keep existing interfaces, maybe refine later
export interface Track {
  youtubeId: string;
  title: string;
  thumbnail?: string;
  duration: number;
  isMusicUrl?: boolean;
  resolvedYtId?: string | null;
  isActive?: boolean;
  status?: TrackStatus; // Added status
  channelId?: string | null; // Added channelId
  channelTitle?: string | null; // Added channelTitle - fetched during getYoutubeInfo
}

export interface Request {
  youtubeId: string;
  userId: string;
  requestedAt: Date;
  playedAt?: Date | null;
  isAutoplay: boolean;
  status: RequestStatus;
}

export interface UserInfo {
  id: string; // Added ID
  username: string;
  discriminator: string;
  avatar: string | null;
}

export type AutoplaySource = 'Pool: Playlist' | 'Pool: History' | 'Pool: Popular' | 'Pool: YouTube Mix' | 'Pool: Random';

export interface QueueItem {
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
  autoplaySource?: AutoplaySource;
}

export interface PlaylistWithTracks {
  id: string;
  name: string;
  active: boolean;
  mode: PlaylistMode;
  tracks: Array<{
    trackId: string;
    position: number;
    track: Track; // Embed full track for easier access
  }>;
}

export interface PlayerState {
  status: 'playing' | 'paused' | 'idle';
  currentTrack: QueueItem | null;
  queue: QueueItem[];
  position: number; // Current playback position in seconds
  volume: number; // Added volume
  autoplayEnabled: boolean; // Added autoplay status
}

export interface AudioCacheInfo {
  youtubeId: string;
  filePath: string;
}

export interface ThumbnailCacheInfo {
  youtubeId: string;
  filePath: string;
}

export interface YoutubeRecommendationInfo {
  youtubeId: string;
  title?: string | null;
  seedTrackId: string;
  relevanceScore?: number;
  wasPlayed?: boolean;
}

// Updated TrackStats to include title and duration
export interface TrackStats {
  youtubeId: string;
  title: string; // Added title
  duration: number; // Added duration
  globalScore: number;
  playCount: number;
  skipCount: number;
  isActive: boolean;
  lastPlayed?: Date | null;
  status: TrackStatus;
}

export interface UserTrackStatsInfo {
  userId: string;
  youtubeId: string;
  playCount: number;
  skipCount: number;
  totalListenTime: number;
  lastPlayed: Date;
  personalScore: number;
}

export interface ChannelInfo {
  id: string;
  title: string;
  isBlocked: boolean;
}

// Base types from original file
export interface BaseTrackResult {
  youtubeId: string;
  title: string;
  thumbnail: string | null;
  duration: number;
}

export interface ExtendedTrackResult extends BaseTrackResult {
  globalScore?: number;
  playCount?: number;
  skipCount?: number;
  isActive?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface QueuedTrackInfo extends BaseTrackResult { // Renamed from QueuedTrack to avoid conflict
  requestedBy?: {
    userId: string;
    username: string;
    avatar?: string;
  };
  queuePosition?: number;
  willPlayNext?: boolean;
  isPlaying?: boolean;
}

export interface ScoredTrack {
  youtubeId: string;
  score: number;
}

// Raw query result types
export type DbTrackResult = {
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

export type DbTrackIdResult = {
  youtubeId: string
};

// Type for YouTube info fetched
export interface FetchedYoutubeInfo {
  title: string;
  duration: number;
  thumbnail: string; // URL
  channelId?: string;
  channelTitle?: string;
}