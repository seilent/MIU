'use client';

import { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';
import { useAuthStore } from '@/lib/store/authStore';
import { usePlayerStore } from '@/lib/store/playerStore';
import env from '@/utils/env';
import SSEManager from '@/lib/sse/SSEManager';

interface PlayerContextType {
  sendCommand: (command: string, params?: Record<string, any>) => Promise<any>;
  isConnected: boolean;
}

const PlayerContext = createContext<PlayerContextType | null>(null);

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const { token } = useAuthStore();
  const { setPlayerState, setQueue } = usePlayerStore();
  const [isConnected, setIsConnected] = useState(false);
  const sseConnectionRef = useRef(false);

  // Centralized SSE connection management
  useEffect(() => {
    if (!token || sseConnectionRef.current) return;

    const sseManager = SSEManager.getInstance();
    sseConnectionRef.current = true;
    
    // Handle state updates (current track, status, position)
    const handleState = (data: any) => {
      console.log('PlayerProvider: State update received', {
        status: data.status,
        track: data.currentTrack ? {
          id: data.currentTrack.youtubeId,
          title: data.currentTrack.title
        } : null
      });
      
      // Update all state at once to prevent race conditions
      if (data.currentTrack) {
        setPlayerState({
          status: data.status,
          position: data.position,
          currentTrack: {
            ...data.currentTrack,
            requestedBy: data.currentTrack.requestedBy ? {
              id: data.currentTrack.requestedBy.id,
              username: data.currentTrack.requestedBy.username,
              avatar: data.currentTrack.requestedBy.avatar || undefined,
              hasAvatar: !!data.currentTrack.requestedBy.avatar
            } : null,
            requestedAt: data.currentTrack.requestedAt || new Date().toISOString()
          }
        });
      } else {
        setPlayerState({
          status: data.status,
          position: data.position,
          currentTrack: undefined
        });
      }
      
      // Process queue data from state event if available
      if (data.queue && Array.isArray(data.queue)) {
        console.log('PlayerProvider: Queue update from state event', { 
          queueLength: data.queue.length 
        });
        
        const processedQueue = data.queue.map((track: any) => ({
          ...track,
          requestedBy: track.requestedBy ? {
            id: track.requestedBy.id,
            username: track.requestedBy.username,
            avatar: track.requestedBy.avatar || undefined,
            hasAvatar: !!track.requestedBy.avatar
          } : null,
          requestedAt: track.requestedAt || new Date().toISOString(),
          isAutoplay: !!track.isAutoplay
        }));
        
        setQueue(processedQueue);
      }
    };
    
    // Handle heartbeat for connection status
    const handleHeartbeat = () => {
      setIsConnected(true);
    };
    
    // Handle connection errors
    const handleConnectionError = () => {
      setIsConnected(false);
    };
    
    // Add event listeners
    sseManager.addEventListener('state', handleState);
    sseManager.addEventListener('heartbeat', handleHeartbeat);
    sseManager.addErrorListener(handleConnectionError);
    
    // Connect with token
    sseManager.connect(token).catch(error => {
      console.error('PlayerProvider: Failed to connect SSE:', error);
      setIsConnected(false);
    });
    
    return () => {
      sseConnectionRef.current = false;
      sseManager.removeEventListener('state', handleState);
      sseManager.removeEventListener('heartbeat', handleHeartbeat);
      sseManager.removeErrorListener(handleConnectionError);
    };
  }, [token, setPlayerState, setQueue]);

  const sendCommand = useCallback(async (command: string, params: Record<string, any> = {}) => {
    if (!token) {
      throw new Error('Not authenticated');
    }

    try {
      const response = await fetch(`${env.apiUrl}/api/music/command/${command}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'X-Internal-Request': 'true'
        },
        body: JSON.stringify(params)
      });

      if (!response.ok) {
        throw new Error(`Command failed: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error(`Error sending command ${command}:`, error);
      throw error;
    }
  }, [token]);

  return (
    <PlayerContext.Provider value={{ sendCommand, isConnected }}>
      {children}
    </PlayerContext.Provider>
  );
}

export function usePlayerProvider() {
  const context = useContext(PlayerContext);
  if (!context) {
    throw new Error('usePlayerProvider must be used within a PlayerProvider');
  }
  return context;
}
