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
  return `${env.apiUrl}/api/albumart/${youtubeId}`;
};

// Helper function to transform track data and ensure thumbnail uses our endpoint
function transformTrack(track: Track): Track {
  if (!track) return track;
  
  return {
    ...track,
    thumbnail: track.thumbnail.startsWith('http') && !track.thumbnail.includes('/api/albumart/') 
      ? track.thumbnail 
      : getThumbnailUrl(track.youtubeId)
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
      setPlayerState: (state) => set((prev) => ({ ...prev, ...state })),
      setPosition: (position) => set({ position }),
      setVolume: (volume) => set({ volume: Math.max(0, Math.min(1, volume)) }),
      setLoading: (loading) => set({ isLoading: loading }),
      setHistory: (history) => set({ history }),
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