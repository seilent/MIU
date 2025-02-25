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
    
    const initAudio = async () => {
      try {
        // Initialize audio context first
        const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
        const audioContext = new AudioContext();
        
        // Resume audio context if suspended (important for iOS)
        if (audioContext.state === 'suspended') {
          await audioContext.resume();
        }
        
        // Configure audio element for mobile
        const audio = audioRef.current;
        if (!audio) return;

        audio.preload = 'metadata';
        audio.setAttribute('playsinline', 'true');
        audio.setAttribute('webkit-playsinline', 'true');
        audio.setAttribute('x-webkit-airplay', 'allow');
        
        // Set initial volume
        audio.volume = usePlayerStore.getState().volume;
        
        if (globalAudioInstance) {
          // Sync with existing instance
          audio.src = globalAudioInstance.src;
          audio.currentTime = globalAudioInstance.currentTime;
          audio.volume = globalAudioInstance.volume;
        } else {
          globalAudioInstance = audio;
        }
        
        // Add error handler with detailed logging
        audio.addEventListener('error', (e) => {
          const target = e.target as HTMLAudioElement;
          const error = target?.error;
          console.error('Audio error:', {
            code: error?.code,
            message: error?.message,
            state: audioContext.state,
            readyState: target.readyState,
            networkState: target.networkState,
            src: target.src
          });
          setStreamError(true);
        });
      } catch (error) {
        console.error('Audio initialization error:', error);
        setStreamError(true);
      }
    };
    
    initAudio();
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

  // Track change effect with improved error handling
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

        // Reset any previous errors
        setStreamError(false);

        // Create a promise to handle metadata loading
        const metadataLoaded = new Promise<void>((resolve, reject) => {
          const handleMetadata = () => {
            try {
              audio.currentTime = data.position;
              resolve();
            } catch (error) {
              reject(error);
            }
          };

          const handleError = (error: Event) => {
            reject(new Error('Metadata loading failed'));
          };

          if (audio.readyState >= 1) {
            handleMetadata();
          } else {
            audio.addEventListener('loadedmetadata', handleMetadata, { once: true });
            audio.addEventListener('error', handleError, { once: true });
          }
        });

        // Set new source with cache-busting
        const streamUrl = `/api/music/stream?ts=${Date.now()}&track=${currentTrack.youtubeId}`;
        audio.src = streamUrl;
        
        try {
          // Wait for metadata to load and position to be set
          await metadataLoaded;

          if (status === 'playing') {
            // Ensure audio context is resumed before playing
            const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
            const audioContext = new AudioContext();
            if (audioContext.state === 'suspended') {
              await audioContext.resume();
            }
            
            await audio.play();
          }
        } catch (error) {
          console.error('Playback setup error:', error);
          setStreamError(true);
          throw error;
        }
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
      playsInline
      webkit-playsinline="true"
      preload="metadata"
    />
  );
} 