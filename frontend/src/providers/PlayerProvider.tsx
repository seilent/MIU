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
  const trackTransitionTimeoutRef = useRef<number | undefined>(undefined);
  const {
    setPlayerState,
    setHistory,
    setLoading,
  } = usePlayerStore();
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const [lastPingTime, setLastPingTime] = useState<number>(Date.now());
  const [isConnected, setIsConnected] = useState<boolean>(true);
  const [consecutiveErrors, setConsecutiveErrors] = useState<number>(0);
  const [pollingInterval, setPollingInterval] = useState<number>(2000);

  const clearTimeouts = useCallback(() => {
    if (pollTimeoutRef.current !== undefined) {
      window.clearTimeout(pollTimeoutRef.current);
      pollTimeoutRef.current = undefined;
    }
    
    if (trackTransitionTimeoutRef.current !== undefined) {
      window.clearTimeout(trackTransitionTimeoutRef.current);
      trackTransitionTimeoutRef.current = undefined;
    }
  }, []);

  const { logout } = useAuthStore();

  const fetchState = useCallback(async () => {
    if (!token) return;
    
    try {
      setLoading(true);
      
      // Fetch state from API
      const response = await fetch(`${env.apiUrl}/api/music/state`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      
      if (response.status === 401) {
        // Authentication failed
        logout();
        return;
      }
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const data = await response.json();
      setPlayerState(data);
      setLoading(false);
      setIsConnected(true);
      setConsecutiveErrors(0);
    } catch (err) {
      setLoading(false);
      setConsecutiveErrors(prev => prev + 1);
    }
  }, [token, logout]);

  const fetchHistory = useCallback(async () => {
    if (!token) return;
    
    try {
      // Fetch history from API
      const response = await fetch(`${env.apiUrl}/api/music/history`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      
      if (response.status === 401) {
        // Authentication failed
        logout();
        return;
      }
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const data = await response.json();
      setHistory(data);
    } catch (err) {
      // Failed to fetch history
    }
  }, [token, logout]);

  const startPolling = useCallback(() => {
    const STATE_POLL_INTERVAL = 2000; // Poll every 2 seconds instead of 500ms
    let consecutiveErrors = 0;
    const MAX_CONSECUTIVE_ERRORS = 3;
    
    const pollState = async () => {
      try {
        // Poll state from API
        const response = await fetch(`${env.apiUrl}/api/music/state`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'X-Internal-Request': 'true'
          }
        });
        
        if (!response.ok) {
          if (response.status === 401) {
            // Authentication failed, logging out
            logout();
            return;
          }
          throw new Error(`Failed to fetch state: ${response.status}`);
        }
        
        // Reset error counter on success
        consecutiveErrors = 0;
        
        const data = await response.json();
        const currentState = usePlayerStore.getState();
        
        // Check if this is a track transition
        const isTrackTransition = 
          data.currentTrack?.youtubeId !== currentState.currentTrack?.youtubeId && 
          data.currentTrack !== null && 
          currentState.currentTrack !== undefined;
        
        // Update player state
        if (isTrackTransition) {
          // For continuous streaming, we don't need to delay the track update
          // Just update the state immediately
          setPlayerState({
            ...data,
            queue: data.queue?.map((track: QueueItem) => ({
              ...track,
              isAutoplay: track.isAutoplay ?? false
            })) || currentState.queue
          });
          
          // Fetch history when track changes
          if (data.currentTrack?.youtubeId !== currentState.currentTrack?.youtubeId) {
            fetchHistory();
          }
        } else {
          setPlayerState({
            ...data,
            currentTrack: data.currentTrack || currentState.currentTrack,
            queue: data.queue?.map((track: QueueItem) => ({
              ...track,
              isAutoplay: track.isAutoplay ?? false
            })) || currentState.queue
          });
        }

        setLoading(false);
      } catch (err) {
        setLoading(false);
        
        // Increment error counter and implement backoff
        consecutiveErrors++;
        
        // If we've had multiple consecutive errors, increase the polling interval temporarily
        let currentInterval = STATE_POLL_INTERVAL;
        if (consecutiveErrors > MAX_CONSECUTIVE_ERRORS) {
          // Exponential backoff: double the interval for each consecutive error beyond the threshold
          const backoffFactor = Math.min(Math.pow(2, consecutiveErrors - MAX_CONSECUTIVE_ERRORS), 10);
          currentInterval = STATE_POLL_INTERVAL * backoffFactor;
        }
        
        // Schedule next poll with potentially increased interval
        pollTimeoutRef.current = window.setTimeout(pollState, currentInterval);
        return; // Skip the normal scheduling below
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
      return;
    }

    try {
      setLoading(true);
      
      const response = await fetch(`${env.apiUrl}/api/music/${command.toLowerCase()}`, {
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
      // Failed to send command
    } finally {
      setLoading(false);
    }
  }, [token, setLoading, fetchState, fetchHistory, logout]);

  // Server connection monitoring
  useEffect(() => {
    let pingInterval: NodeJS.Timeout;
    let checkInterval: NodeJS.Timeout;
    let lastConnectionState = true; // Track connection state to only log changes
    
    const pingServer = async () => {
      try {
        const response = await fetch(`${env.apiUrl}/api/health`, {
          headers: {
            'Authorization': token ? `Bearer ${token}` : '',
            'X-Internal-Request': 'true'
          }
        });
        
        if (response.ok) {
          setLastPingTime(Date.now());
          
          // Only update state if it changed
          if (!lastConnectionState) {
            lastConnectionState = true;
          }
          
          setServerError(null);
        } else {
          lastConnectionState = false;
        }
      } catch (error) {
        lastConnectionState = false;
      }
    };

    const checkConnection = () => {
      const timeSinceLastPing = Date.now() - lastPingTime;
      if (timeSinceLastPing > 10000) { // 10 seconds timeout
        if (lastConnectionState) {
          lastConnectionState = false;
        }
        setServerError('Server connection lost');
        // Don't redirect immediately, allow for reconnection attempts
      }
    };

    if (token) {
      pingServer(); // Ping immediately
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
