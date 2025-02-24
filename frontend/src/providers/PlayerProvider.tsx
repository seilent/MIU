'use client';

import { createContext, useContext, useEffect, useRef, useCallback, useState } from 'react';
import { usePlayerStore } from '@/lib/store/playerStore';
import { useAuthStore } from '@/lib/store/authStore';
import { QueueItem } from '@/lib/types';
import { useRouter } from 'next/navigation';
import { toast } from 'react-hot-toast';
import env from '@/utils/env';

type MusicCommand = 
  | 'search'
  | 'queue'
  | 'playback'
  | 'skip'
  | 'history';

interface SearchCommandPayload {
  query: string;
}

interface QueueCommandPayload {
  youtubeId: string;
}

interface PlaybackCommandPayload {
  action: 'play' | 'pause';
}

type CommandPayload = 
  | SearchCommandPayload 
  | QueueCommandPayload 
  | PlaybackCommandPayload 
  | Record<string, never>;

interface PlayerProviderContextType {
  sendCommand: (command: MusicCommand, data?: CommandPayload) => Promise<void>;
}

const PlayerProviderContext = createContext<PlayerProviderContextType>({
  sendCommand: async () => {},
});

export const usePlayerProvider = () => useContext(PlayerProviderContext);

interface PlayerProviderProps {
  children: React.ReactNode;
}

export function PlayerProvider({ children }: PlayerProviderProps) {
  const { token } = useAuthStore();
  const pollTimeoutRef = useRef<number | undefined>(undefined);
  const {
    setPlayerState,
    setHistory,
    setLoading,
  } = usePlayerStore();
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const [lastPingTime, setLastPingTime] = useState<number>(Date.now());

  const clearTimeouts = useCallback(() => {
    if (pollTimeoutRef.current !== undefined) {
      window.clearTimeout(pollTimeoutRef.current);
      pollTimeoutRef.current = undefined;
    }
  }, []);

  const { logout } = useAuthStore();

  const fetchState = useCallback(async () => {
    if (!token) {
      setLoading(false);
      return;
    }
    
    try {
      const response = await fetch(`${env.apiUrl}/api/music/state`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-Internal-Request': 'true'
        }
      });
      
      if (!response.ok) {
        if (response.status === 401) {
          setLoading(false);
          logout();
          return;
        }
        throw new Error('Failed to fetch state');
      }

      const data = await response.json();
      setPlayerState(data);
      setLoading(false);
    } catch (err) {
      console.error('Failed to fetch state:', err);
      setLoading(false);
    }
  }, [token, logout, setPlayerState, setLoading]);

  const fetchHistory = useCallback(async () => {
    if (!token) return;
    
    try {
      const response = await fetch(`${env.apiUrl}/api/history`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-Internal-Request': 'true'
        }
      });
      
      if (!response.ok) {
        if (response.status === 401) {
          logout();
          return;
        }
        throw new Error('Failed to fetch history');
      }

      const data = await response.json();
      setHistory(data.tracks || []);
    } catch (err) {
      console.error('Failed to fetch history:', err);
    }
  }, [token, logout, setHistory]);

  const startPolling = useCallback(() => {
    const STATE_POLL_INTERVAL = 500; // Poll every 500ms for more responsiveness

    const pollState = async () => {
      if (!token) {
        setLoading(false);
        return;
      }
      
      try {
        const response = await fetch(`${env.apiUrl}/api/music/state`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'X-Internal-Request': 'true'
          }
        });
        
        if (!response.ok) {
          if (response.status === 401) {
            setLoading(false);
            logout();
            return;
          }
          throw new Error('Failed to fetch state');
        }

        const data = await response.json();
        const currentState = usePlayerStore.getState();
        
        // Always update state if we have new data
        if (data) {
          setPlayerState({
            ...data,
            // Preserve current track during loading if new data doesn't have one
            currentTrack: data.currentTrack || currentState.currentTrack,
            // Ensure queue items have proper isAutoplay flag
            queue: data.queue?.map((track: QueueItem) => ({
              ...track,
              isAutoplay: track.isAutoplay ?? false
            })) || currentState.queue
          });

          // If track changed or started playing, fetch history
          if (data.currentTrack?.youtubeId !== currentState.currentTrack?.youtubeId ||
              (data.status === 'playing' && currentState.status !== 'playing')) {
            fetchHistory();
          }
        }

        setLoading(false);
      } catch (err) {
        console.error('Failed to fetch state:', err);
        setLoading(false);
      }

      // Schedule next poll
      pollTimeoutRef.current = window.setTimeout(pollState, STATE_POLL_INTERVAL);
    };

    clearTimeouts();
    pollState();

    return () => {
      clearTimeouts();
    };
  }, [token, logout, setPlayerState, clearTimeouts, fetchHistory, setLoading]);

  useEffect(() => {
    if (token) {
      startPolling();
      fetchHistory();
    }

    return () => {
      clearTimeouts();
    };
  }, [token, startPolling, clearTimeouts, fetchHistory]);

  const sendCommand = useCallback(async (command: MusicCommand, payload?: CommandPayload) => {
    if (!token) {
      console.error('Authentication required');
      return;
    }

    try {
      setLoading(true);
      
      const response = await fetch(`/api/music/${command.toLowerCase()}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'X-Internal-Request': 'true'
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        if (response.status === 401) {
          logout();
          return;
        }
        throw new Error('Failed to send command');
      }

      // Fetch updated state immediately after command
      await fetchState();
      
      // If it was a history-related command, fetch history too
      if (command.toLowerCase().includes('history')) {
        await fetchHistory();
      }
    } catch (err) {
      console.error('Failed to send command:', err);
    } finally {
      setLoading(false);
    }
  }, [token, setLoading, fetchState, fetchHistory, logout]);

  // Server connection monitoring
  useEffect(() => {
    let pingInterval: NodeJS.Timeout;
    let checkInterval: NodeJS.Timeout;

    const pingServer = async () => {
      try {
        const response = await fetch(`${env.apiUrl}/api/health`, {
          headers: {
            'Authorization': `Bearer ${token}`,
          }
        });
        if (response.ok) {
          setLastPingTime(Date.now());
          setServerError(null);
        }
      } catch (error) {
        console.error('Server ping failed:', error);
      }
    };

    const checkConnection = () => {
      const timeSinceLastPing = Date.now() - lastPingTime;
      if (timeSinceLastPing > 10000) { // 10 seconds timeout
        setServerError('Server connection lost');
        router.push('/');
      }
    };

    if (token) {
      pingInterval = setInterval(pingServer, 5000); // Ping every 5 seconds
      checkInterval = setInterval(checkConnection, 2000); // Check every 2 seconds
    }

    return () => {
      clearInterval(pingInterval);
      clearInterval(checkInterval);
    };
  }, [token, lastPingTime, router]);

  // Show error toast when server connection is lost
  useEffect(() => {
    if (serverError) {
      toast.error(serverError, {
        position: 'bottom-right',
        duration: 5000,
      });
    }
  }, [serverError]);

  return (
    <PlayerProviderContext.Provider value={{ sendCommand }}>
      {children}
    </PlayerProviderContext.Provider>
  );
}

export default PlayerProvider;
