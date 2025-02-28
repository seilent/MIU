'use client';

import { createContext, useContext, useEffect, useRef, useCallback, useState } from 'react';
import { usePlayerStore } from '@/lib/store/playerStore';
import { useAuthStore } from '@/lib/store/authStore';
import { QueueItem } from '@/lib/types';
import { useRouter } from 'next/navigation';
import { toast } from 'react-hot-toast';
import env from '@/utils/env';
import SSEManager from '@/lib/sse/SSEManager';

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
  const { logout } = useAuthStore();
  const {
    setPlayerState,
    setHistory,
    setLoading,
  } = usePlayerStore();
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<'connected' | 'disconnected'>('connected');
  const sseManager = useRef<SSEManager>(SSEManager.getInstance());

  const fetchState = useCallback(async () => {
    if (!token) return;
    
    try {
      setLoading(true);
      const response = await fetch(`${env.apiUrl}/api/music/state`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      
      if (response.status === 401) {
        logout();
        return;
      }
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const data = await response.json();
      setPlayerState(data);
      setLoading(false);
    } catch (err) {
      setLoading(false);
      console.error('Error fetching state:', err);
    }
  }, [token, logout, setPlayerState, setLoading]);

  const fetchHistory = useCallback(async () => {
    if (!token) return;
    
    try {
      const response = await fetch(`${env.apiUrl}/api/music/history`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      
      if (response.status === 401) {
        logout();
        return;
      }
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const data = await response.json();
      setHistory(data);
    } catch (err) {
      console.error('Error fetching history:', err);
    }
  }, [token, logout, setHistory]);

  // Initialize SSE connection
  useEffect(() => {
    if (!token) {
      sseManager.current.disconnect();
      return;
    }

    // Set up event listeners
    const handleState = (data: any) => {
      setPlayerState(data);
    };

    const handleHistory = (data: any) => {
      setHistory(data.tracks);
    };

    const handleHeartbeat = () => {
      setConnectionStatus('connected');
      setServerError(null);
    };

    const handleError = () => {
      setConnectionStatus('disconnected');
      setServerError('Server connection lost');
    };

    // Add listeners
    sseManager.current.addEventListener('state', handleState);
    sseManager.current.addEventListener('history', handleHistory);
    sseManager.current.addEventListener('heartbeat', handleHeartbeat);
    sseManager.current.addErrorListener(handleError);

    // Connect to SSE
    sseManager.current.connect();

    // Initial data fetch
    fetchState();
    fetchHistory();

    return () => {
      // Remove listeners
      sseManager.current.removeEventListener('state', handleState);
      sseManager.current.removeEventListener('history', handleHistory);
      sseManager.current.removeEventListener('heartbeat', handleHeartbeat);
      sseManager.current.removeErrorListener(handleError);
    };
  }, [token, fetchState, fetchHistory, setPlayerState]);

  // Show error toast when server connection is lost
  useEffect(() => {
    if (serverError) {
      toast.error(serverError, {
        position: 'bottom-right',
        duration: 5000,
      });
    }
  }, [serverError]);

  const sendCommand = useCallback(async (command: MusicCommand, payload?: CommandPayload) => {
    if (!token) return;

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
    } catch (err) {
      console.error('Error sending command:', err);
    } finally {
      setLoading(false);
    }
  }, [token, setLoading, logout]);

  return (
    <PlayerProviderContext.Provider value={{ sendCommand }}>
      {children}
    </PlayerProviderContext.Provider>
  );
}

export default PlayerProvider;
