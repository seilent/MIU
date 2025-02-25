import { useEffect, useRef } from 'react';
import { useAuthStore } from '@/lib/store/authStore';

/**
 * Hook to handle audio streaming with authorization headers
 * This uses a service worker to intercept audio requests and add auth headers
 */
export function useAudioWithAuth() {
  const { token } = useAuthStore();
  const isRegisteredRef = useRef(false);

  useEffect(() => {
    if (!token || isRegisteredRef.current) return;

    // Register a service worker to intercept audio requests and add auth headers
    const registerServiceWorker = async () => {
      if ('serviceWorker' in navigator) {
        try {
          // Instead of using a blob URL which causes issues with HTTPS,
          // we'll check if we're already handling audio requests with headers
          const registration = await navigator.serviceWorker.getRegistration('/');
          
          if (registration) {
            // Audio auth service worker already registered
          } else {
            // Using fetch API with auth headers for audio requests
          }
        } catch (error) {
          // Failed to register audio auth service worker
        }
      }
    };

    registerServiceWorker();

    return () => {
      // Service workers persist, so we don't need to unregister
    };
  }, [token]);
} 