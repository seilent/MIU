import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { QueueItem, PlayerState, HistoryTrack } from '../types';
import env from '@/utils/env';

interface Track {
  id: string;
  youtubeId: string;
  title: string;
  artist?: string;
  thumbnail: string;
  duration: number;
  requestedBy: {
    id: string;
    username: string;
    avatar?: string;
  };
  requestedAt: string;
  playedAt: string;
}

interface PlayerStore extends PlayerState {
  isLoading: boolean;
  history: HistoryTrack[];
  setPlayerState: (state: Partial<PlayerState>) => void;
  setPosition: (position: number) => void;
  setVolume: (volume: number) => void;
  setLoading: (loading: boolean) => void;
  setHistory: (history: HistoryTrack[]) => void;
}

// Helper function to transform YouTube video ID into our thumbnail URL
const getThumbnailUrl = (youtubeId: string): string => {
  // If env.apiUrl is undefined, use a relative URL
  if (!env.apiUrl) {
    return `/api/albumart/${youtubeId}`;
  }
  const baseUrl = env.apiUrl.endsWith('/') ? env.apiUrl.slice(0, -1) : env.apiUrl;
  return `${baseUrl}/api/albumart/${youtubeId}`;
};

// Helper function to transform track data and ensure thumbnail uses our endpoint
function transformTrack<T extends { youtubeId: string; thumbnail: string }>(track: T): T {
  if (!track) return track;
  
  // If the thumbnail is already a full URL and not our albumart endpoint, use it directly
  if (track.thumbnail.startsWith('http') && !track.thumbnail.includes('/api/albumart/')) {
    return track;
  }
  
  return {
    ...track,
    thumbnail: getThumbnailUrl(track.youtubeId)
  };
}

export const usePlayerStore = create<PlayerStore>()(
  persist(
    (set) => ({
      status: 'stopped',
      currentTrack: undefined,
      queue: [],
      position: 0,
      volume: 0.5,
      isLoading: true,
      history: [],
      setPlayerState: (state) => set((prev) => {
        // Transform currentTrack if it exists
        const transformedState = {
          ...state,
          currentTrack: state.currentTrack ? transformTrack(state.currentTrack) : state.currentTrack,
          // Transform queue tracks if they exist
          queue: state.queue ? state.queue.map(track => transformTrack(track)) : state.queue
        };
        return { ...prev, ...transformedState };
      }),
      setPosition: (position) => set({ position }),
      setVolume: (volume) => set({ volume: Math.max(0, Math.min(1, volume)) }),
      setLoading: (loading) => set({ isLoading: loading }),
      setHistory: (history) => set({ history: history.map(track => transformTrack(track)) }),
    }),
    {
      name: 'player-preferences',
      partialize: (state) => ({
        volume: state.volume, // Only persist user preferences like volume
      }),
      version: 1, // Add version for future migrations if needed
    }
  )
); 