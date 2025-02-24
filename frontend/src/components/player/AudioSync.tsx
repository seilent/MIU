'use client';

import { useRef, useEffect } from 'react';
import { useAuthStore } from '@/lib/store/authStore';
import { usePlayerStore } from '@/lib/store/playerStore';
import env from '@/utils/env';

// Singleton audio instance
let globalAudioInstance: HTMLAudioElement | null = null;

export default function AudioSync() {
  const audioRef = useRef<HTMLAudioElement>(null);
  const loadingRef = useRef<boolean>(false);
  const activeRequestRef = useRef<AbortController | null>(null);
  const mountedRef = useRef<boolean>(false);
  const { token } = useAuthStore();
  const { 
    status, 
    currentTrack,
    setPosition,
    setPlayerState
  } = usePlayerStore();

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

    const audio = audioRef.current;
    let lastTime = audio.currentTime;
    
    const updatePosition = () => {
      if (audio.currentTime !== lastTime) {
        setPosition(audio.currentTime);
        lastTime = audio.currentTime;
      }
    };

    const intervalId = setInterval(updatePosition, 1000);
    return () => clearInterval(intervalId);
  }, [status, setPosition]);

  // Load and play audio
  useEffect(() => {
    if (!mountedRef.current || !currentTrack?.youtubeId || !token || !audioRef.current) return;
    if (loadingRef.current) return;

    const audio = audioRef.current;
    const audioUrl = `${env.apiUrl}/api/music/audio/${currentTrack.youtubeId}`;

    loadingRef.current = true;

    if (activeRequestRef.current) {
      activeRequestRef.current.abort();
      activeRequestRef.current = null;
    }

    if (audio.dataset.blobUrl) {
      URL.revokeObjectURL(audio.dataset.blobUrl);
      delete audio.dataset.blobUrl;
    }
    audio.removeAttribute('src');
    audio.load();

    // Create a new AbortController for this request
    const abortController = new AbortController();
    activeRequestRef.current = abortController;

    // Function to handle playback after buffering
    const startPlayback = async () => {
      try {
        const response = await fetch(`${env.apiUrl}/api/music/position`, {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        });
        const data = await response.json();
        
        if (mountedRef.current && audioRef.current) {
          audioRef.current.currentTime = data.position;
          setPosition(data.position);
          
          if (status === 'playing') {
            const playPromise = audioRef.current.play();
            if (playPromise) {
              playPromise.catch(() => {
                // If autoplay is blocked, we'll handle it gracefully
                if (status === 'playing') {
                  setPlayerState({ status: 'paused' });
                }
              });
            }
          }
        }
      } catch (error) {
        console.error('Failed to sync position:', error);
        if (status === 'playing' && audioRef.current) {
          const playPromise = audioRef.current.play();
          if (playPromise) {
            playPromise.catch(() => {
              if (status === 'playing') {
                setPlayerState({ status: 'paused' });
              }
            });
          }
        }
      }
    };

    // Handle buffering and playback
    const bufferAndPlay = async () => {
      try {
        console.log('Fetching audio from:', audioUrl);
        const response = await fetch(audioUrl, {
          headers: {
            'Authorization': `Bearer ${token}`
          },
          signal: abortController.signal
        });

        if (!response.ok) {
          console.error('Failed to fetch audio:', response.status, response.statusText);
          throw new Error(`Failed to fetch audio: ${response.status} ${response.statusText}`);
        }

        const blob = await response.blob();
        if (!mountedRef.current || activeRequestRef.current !== abortController) return;

        console.log('Audio blob received, size:', blob.size);
        const url = URL.createObjectURL(blob);
        audio.src = url;
        audio.dataset.blobUrl = url;

        // Wait for enough of the audio to be loaded
        const handleCanPlay = () => {
          console.log('Audio can play event triggered');
          audio.removeEventListener('canplay', handleCanPlay);
          loadingRef.current = false;
          startPlayback();
        };

        const handleError = (error: Event) => {
          console.error('Audio loading error:', error);
          audio.removeEventListener('error', handleError);
          loadingRef.current = false;
          if (mountedRef.current) {
            setPlayerState({ status: 'paused' });
          }
        };

        audio.addEventListener('canplay', handleCanPlay);
        audio.addEventListener('error', handleError);

        // Start loading the audio
        audio.load();
      } catch (error) {
        console.error('Failed to buffer audio:', error);
        if (error && typeof error === 'object' && 'name' in error && error.name !== 'AbortError' && mountedRef.current) {
          setPlayerState({ status: 'paused' });
        }
        loadingRef.current = false;
      }
    };

    bufferAndPlay();

    return () => {
      if (activeRequestRef.current === abortController) {
        abortController.abort();
        activeRequestRef.current = null;
      }

      if (audio.dataset.blobUrl) {
        URL.revokeObjectURL(audio.dataset.blobUrl);
        delete audio.dataset.blobUrl;
      }

      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      loadingRef.current = false;
    };
  }, [currentTrack?.youtubeId, token, status, setPosition, setPlayerState]);

  // Handle play/pause
  useEffect(() => {
    if (!mountedRef.current || !audioRef.current || loadingRef.current) return;

    const audio = audioRef.current;
    if (status === 'playing') {
      const playPromise = audio.play();
      if (playPromise) {
        playPromise.catch(() => {
          if (status === 'playing') {
            setPlayerState({ status: 'paused' });
          }
        });
      }
    } else {
      audio.pause();
    }
  }, [status, setPlayerState]);

  return (
    <audio 
      ref={audioRef} 
      preload="auto"
      style={{ display: 'none' }} 
    />
  );
} 