import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { QueueItem, PlayerState, HistoryTrack } from '../types';
import env from '@/utils/env';

interface PlayerStore extends PlayerState {
  isLoading: boolean;
  history: HistoryTrack[];
  setPlayerState: (state: Partial<PlayerState>) => void;
  setCurrentTrack: (track: QueueItem | undefined) => void;
  setQueue: (queue: QueueItem[]) => void;
  setStatus: (status: 'playing' | 'paused' | 'stopped') => void;
  setPosition: (position: number) => void;
  setVolume: (volume: number) => void;
  setLoading: (loading: boolean) => void;
  setHistory: (history: HistoryTrack[]) => void;
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
      setCurrentTrack: (track) => set({ currentTrack: track }),
      setQueue: (queue) => set({ queue }),
      setStatus: (status) => set({ status }),
      setPosition: (position) => set({ position }),
      setVolume: (volume) => set({ volume: Math.max(0, Math.min(1, volume)) }),
      setLoading: (loading) => set({ isLoading: loading }),
      setHistory: (history) => set({ history }),
    }),
    {
      name: 'player-preferences',
      partialize: (state) => ({
        volume: state.volume,
      }),
      version: 1,
    }
  )
); 