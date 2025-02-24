'use client';

import { createContext, useContext, useEffect } from 'react';
import { useAuthStore } from '@/lib/store/authStore';
import { usePlayerStore } from '@/lib/store/playerStore';

interface PresenceProviderProps {
  children: React.ReactNode;
}

const PresenceContext = createContext({});

export const usePresence = () => useContext(PresenceContext);

export function PresenceProvider({ children }: PresenceProviderProps) {
  const { token } = useAuthStore();
  const { currentTrack } = usePlayerStore();

  useEffect(() => {
    if (!token) return;

    // Send heartbeat immediately
    const sendHeartbeat = async () => {
      try {
        await fetch(`/api/presence/heartbeat`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'X-Internal-Request': 'true',
            'X-Keep-Playing': currentTrack ? 'true' : 'false'  // Signal to keep music playing if we have a track
          }
        });
      } catch (error) {
        console.error('Failed to send heartbeat:', error);
      }
    };

    // Send initial heartbeat
    sendHeartbeat();

    // Set up interval for heartbeat (every 30 seconds)
    const interval = setInterval(sendHeartbeat, 30000);

    // Cleanup interval on unmount or token change
    return () => clearInterval(interval);
  }, [token, currentTrack]); // Add currentTrack to dependencies

  return (
    <PresenceContext.Provider value={{}}>
      {children}
    </PresenceContext.Provider>
  );
}

export default PresenceProvider;
