'use client';

import { useRef, useEffect, useState, useCallback } from 'react';
import { useAuthStore } from '@/lib/store/authStore';
import { usePlayerStore } from '@/lib/store/playerStore';
import env from '@/utils/env';
import { useAudioWithAuth } from '@/hooks/useAudioWithAuth';

// Singleton audio instance
let globalAudioInstance: HTMLAudioElement | null = null;

export default function AudioSync() {
  const audioRef = useRef<HTMLAudioElement>(null);
  const loadingRef = useRef<boolean>(false);
  const mountedRef = useRef<boolean>(false);
  const startTimeRef = useRef<number>(0);
  const trackIdRef = useRef<string | null>(null);
  const [streamError, setStreamError] = useState<boolean>(false);
  const { token } = useAuthStore();
  const { 
    status, 
    currentTrack,
    setPosition,
    setPlayerState
  } = usePlayerStore();
  
  // Use our custom hook to handle auth headers for audio streaming
  useAudioWithAuth();

  // Initialize singleton audio instance
  useEffect(() => {
    if (!audioRef.current) return;
    
    if (globalAudioInstance) {
      // Sync the current audio element with the global instance
      audioRef.current.src = globalAudioInstance.src;
      audioRef.current.currentTime = globalAudioInstance.currentTime;
      audioRef.current.volume = globalAudioInstance.volume;
    } else {
      globalAudioInstance = audioRef.current;
    }
    
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (globalAudioInstance === audioRef.current) {
        globalAudioInstance = null;
      }
    };
  }, []);

  // Position update effect
  useEffect(() => {
    if (!mountedRef.current || !audioRef.current || status !== 'playing') return;

    const updatePosition = async () => {
      try {
        const res = await fetch('/api/music/position');
        if (!res.ok) throw new Error('Failed to fetch position');
        const data = await res.json();
        
        // Use audio's currentTime directly instead of calculating elapsed time
        const currentPosition = audioRef.current?.currentTime || 0;
        setPosition(Math.min(currentPosition, data.duration));
      } catch (error) {
        console.error('Error updating position:', error);
      }
    };

    const intervalId = setInterval(updatePosition, 1000);
    return () => clearInterval(intervalId);
  }, [status, setPosition]);

  // Track change effect
  useEffect(() => {
    if (!currentTrack || !audioRef.current) return;

    const setupStream = async () => {
      try {
        loadingRef.current = true;
        const res = await fetch('/api/music/position');
        if (!res.ok) throw new Error('Failed to fetch position');
        const data = await res.json();
        
        startTimeRef.current = Date.now();
        trackIdRef.current = data.trackId;
        
        const audio = audioRef.current;
        if (!audio) return;

        // Create a promise to handle metadata loading
        const metadataLoaded = new Promise<void>((resolve) => {
          const handleMetadata = () => {
            audio.currentTime = data.position;
            resolve();
          };

          if (audio.readyState >= 1) {
            // Metadata is already loaded
            handleMetadata();
          } else {
            // Wait for metadata to load
            audio.addEventListener('loadedmetadata', handleMetadata, { once: true });
          }
        });

        // Set new source
        audio.src = `/api/music/stream?ts=${Date.now()}`;
        
        // Wait for metadata to load and position to be set
        await metadataLoaded;

        if (status === 'playing') {
          await audio.play();
        }
        
        setStreamError(false);
      } catch (error) {
        console.error('Stream setup error:', error);
        setStreamError(true);
      } finally {
        loadingRef.current = false;
      }
    };

    if (currentTrack.youtubeId !== trackIdRef.current) {
      setupStream();
    }
  }, [currentTrack, status]);

  // Play/pause effect
  useEffect(() => {
    if (!audioRef.current || loadingRef.current) return;

    const audio = audioRef.current;
    
    if (status === 'playing' && audio.paused) {
      audio.play().catch(error => {
        console.error('Playback error:', error);
        setPlayerState({ status: 'paused' });
      });
    } else if (status === 'paused' && !audio.paused) {
      audio.pause();
    }
  }, [status, setPlayerState]);

  // Add timeupdate handler to sync position with audio element
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleTimeUpdate = () => {
      setPosition(audio.currentTime);
    };

    audio.addEventListener('timeupdate', handleTimeUpdate);
    return () => audio.removeEventListener('timeupdate', handleTimeUpdate);
  }, [setPosition]);

  return (
    <audio 
      ref={audioRef}
      onError={() => setStreamError(true)}
    />
  );
} 