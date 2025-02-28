'use client';

import { createContext, useContext, useEffect, useRef } from 'react';
import { useAuthStore } from '@/lib/store/authStore';
import env from '@/utils/env';

interface PresenceProviderProps {
  children: React.ReactNode;
}

const PresenceContext = createContext<null>(null);

export function PresenceProvider({ children }: PresenceProviderProps) {
  const { token } = useAuthStore();
  const heartbeatIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const consecutiveErrorsRef = useRef(0);

  useEffect(() => {
    if (!token) return;

    const sendHeartbeat = async () => {
      try {
        const response = await fetch(`${env.apiUrl}/api/discord/presence`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        });

        if (!response.ok) {
          throw new Error('Failed to update presence');
        }

        // Reset error count on success
        consecutiveErrorsRef.current = 0;
      } catch (error) {
        consecutiveErrorsRef.current++;
        console.error('Presence update error:', error);

        // Implement exponential backoff
        if (consecutiveErrorsRef.current > 3) {
          const backoffTime = Math.min(Math.pow(2, consecutiveErrorsRef.current - 3) * 30000, 300000);
          if (heartbeatIntervalRef.current) {
            clearInterval(heartbeatIntervalRef.current);
          }
          retryTimeoutRef.current = setTimeout(() => {
            startHeartbeat();
          }, backoffTime);
          return;
        }
      }
    };

    const startHeartbeat = () => {
      // Clear any existing intervals
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
      }
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
      }

      // Start with an immediate update
      sendHeartbeat();
      
      // Then set up the interval
      heartbeatIntervalRef.current = setInterval(sendHeartbeat, 30000);
    };

    startHeartbeat();

    return () => {
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
      }
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
      }
    };
  }, [token]);

  return (
    <PresenceContext.Provider value={null}>
      {children}
    </PresenceContext.Provider>
  );
}

export default PresenceProvider;
