// Database-aligned types
export type RequestStatus = 
  | 'PENDING'
  | 'PLAYING'
  | 'QUEUED'
  | 'COMPLETED'
  | 'DOWNLOADING'
  | 'SKIPPED';

export interface User {
  id: string;
  username: string;
  discriminator: string;
  avatar?: string;
}

export interface Track {
  youtubeId: string;
  title: string;
  thumbnail: string;
  duration: number;
}

export interface Request {
  youtubeId: string;
  userId: string;
  status: RequestStatus;
  requestedAt: string;
  playedAt?: string;
  isAutoplay: boolean;
  user: User;
  track: Track;
}

// Frontend-specific types
export interface QueueItem {
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
  isAutoplay?: boolean;
}

export interface PlayerState {
  status: 'playing' | 'paused' | 'stopped';
  currentTrack?: QueueItem;
  queue: QueueItem[];
  position: number;
  volume: number;
}

export interface HistoryTrack extends QueueItem {
  id: string;
  artist?: string;
  playedAt: string;
} 