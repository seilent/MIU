export interface SearchResult {
  youtubeId: string;
  title: string;
  thumbnail: string;
  duration: number;
}

export interface TrackInfo {
  title: string;
  artist?: string;
  thumbnail: string;
  duration: number;
}

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
  queuePosition?: number;
  willPlayNext: boolean;
  isPlaying: boolean;
} 