'use client';

import { useRef, useEffect, useState, useCallback } from 'react';
import { useAuthStore } from '@/lib/store/authStore';
import { usePlayerStore } from '@/lib/store/playerStore';
import env from '@/utils/env';
import { useAudioWithAuth } from '@/hooks/useAudioWithAuth';
import SSEManager from '@/lib/sse/SSEManager';
import HLSManager from '@/lib/hls/HLSManager';

// Singleton audio instance
let globalAudioInstance: HTMLAudioElement | null = null;

export default function AudioSync() {
  const audioRef = useRef<HTMLAudioElement>(null);
  const loadingRef = useRef<boolean>(false);
  const mountedRef = useRef<boolean>(false);
  const startTimeRef = useRef<number>(0);
  const trackIdRef = useRef<string | null>(null);
  const sseManagerRef = useRef<SSEManager | null>(null);
  const statusRef = useRef<string>('stopped');
  const [streamError, setStreamError] = useState<boolean>(false);
  const { token } = useAuthStore();
  const { 
    status, 
    currentTrack,
    setPosition,
    setPlayerState
  } = usePlayerStore();
  
  const audioContextRef = useRef<AudioContext | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const sseSubscriptionRef = useRef(false);
  
  useAudioWithAuth();

  const setupStream = useCallback(async () => {
    if (!mountedRef.current || !audioRef.current || !currentTrack) return;

    console.log('Audio: Setting up stream', {
      trackId: currentTrack.youtubeId,
      loading: loadingRef.current,
      initialized: isInitialized
    });

    if (loadingRef.current) {
      let retryCount = 0;
      while (loadingRef.current && retryCount < 10) {
        await new Promise(resolve => setTimeout(resolve, 100));
        retryCount++;
      }
      if (loadingRef.current) return;
    }
    
    try {
      loadingRef.current = true;
      const audio = audioRef.current;
      setStreamError(false);
      
      const hlsManager = HLSManager.getInstance();
      if (hlsManager.isSupported()) {
        console.log('Audio: Using HLS for playback');
        await hlsManager.attachMedia(audio, currentTrack.youtubeId);
      } else {
        console.log('Audio: Using direct stream URL for playback');
        const streamUrl = `${env.apiUrl}/api/music/stream?ts=${Date.now()}&track=${currentTrack.youtubeId}`;
        audio.src = streamUrl;
        audio.load();
      }
      
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          const handleMetadata = () => {
            cleanup();
            console.log('Audio: Metadata loaded successfully');
            resolve();
          };

          const handleError = (error: Event) => {
            cleanup();
            console.error('Audio: Metadata loading error', error);
            reject(error);
          };

          const cleanup = () => {
            audio.removeEventListener('loadedmetadata', handleMetadata);
            audio.removeEventListener('error', handleError);
          };

          audio.addEventListener('loadedmetadata', handleMetadata, { once: true });
          audio.addEventListener('error', handleError, { once: true });
        }),
        new Promise<void>((_, reject) => 
          setTimeout(() => reject(new Error('Metadata loading timeout after 10 seconds')), 10000)
        )
      ]);

      trackIdRef.current = currentTrack.youtubeId;
      console.log('Audio: Stream setup complete for track', currentTrack.youtubeId);

      if (statusRef.current === 'playing') {
        const response = await fetch(`${env.apiUrl}/api/music/position`);
        const data = await response.json();
        console.log('Audio: Setting position from API', data.position);
        audio.currentTime = data.position;
        await audio.play();
      }
    } catch (error) {
      console.error('Audio: Stream setup error:', error);
      setStreamError(true);
    } finally {
      if (mountedRef.current) {
        loadingRef.current = false;
      }
    }
  }, [currentTrack]);

  const initializeAudioContext = useCallback(async () => {
    if (!audioContextRef.current) {
      const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
      audioContextRef.current = new AudioContext();
    }
    return audioContextRef.current;
  }, []);

  const playAudio = async (audio: HTMLAudioElement) => {
    try {
      if (!audio.paused) {
        console.log('Audio: Already playing');
        return;
      }

      // Initialize audio context and play
      const audioContext = await initializeAudioContext();
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }

      console.log('Audio: Starting playback from position:', audio.currentTime);
      const playPromise = audio.play();
      if (playPromise !== undefined) {
        await playPromise;
        console.log('Audio: Playback started successfully');
      }
    } catch (error) {
      console.error('Audio: Playback failed:', error);
      if (error instanceof DOMException && error.name === 'NotAllowedError') {
        console.log('Audio: Playback blocked by browser, waiting for user interaction');
        // Add user interaction handler
        return new Promise<void>((resolve) => {
          const handleInteraction = async () => {
            cleanup();
            try {
              const audioContext = await initializeAudioContext();
              if (audioContext.state === 'suspended') {
                await audioContext.resume();
              }
              await audio.play();
              resolve();
            } catch (retryError) {
              console.error('Audio: Retry play failed:', retryError);
            }
          };

          const cleanup = () => {
            document.removeEventListener('click', handleInteraction);
            document.removeEventListener('touchstart', handleInteraction);
          };

          document.addEventListener('click', handleInteraction);
          document.addEventListener('touchstart', handleInteraction);
        });
      }
    }
  };

  // Status change effect
  useEffect(() => {
    if (!audioRef.current || !mountedRef.current || !isInitialized || loadingRef.current) return;

    const audio = audioRef.current;
    console.log('Audio: Status change effect triggered', { 
      status, 
      isPaused: audio.paused,
      isInitialized,
      currentTrack: currentTrack?.youtubeId
    });

    const startPlayback = async () => {
      try {
        const audioContext = await initializeAudioContext();
        if (audioContext.state === 'suspended') {
          await audioContext.resume();
        }

        const response = await fetch(`${env.apiUrl}/api/music/position`);
        const data = await response.json();
        audio.currentTime = data.position;
        console.log('Audio: Starting playback from position', data.position);
        await audio.play();
      } catch (error) {
        console.error('Audio: Failed to start playback:', error);
        setPlayerState({ status: 'paused' });
      }
    };

    if (status === 'playing' && audio.paused) {
      startPlayback();
    } else if (status === 'paused' && !audio.paused) {
      audio.pause();
    }
  }, [status, isInitialized]);

  // Initialize singleton audio instance
  useEffect(() => {
    if (!audioRef.current) return;
    
    const initAudio = async () => {
      const audio = audioRef.current;
      if (!audio) return;

      audio.preload = 'auto';
      audio.setAttribute('playsinline', 'true');
      audio.setAttribute('webkit-playsinline', 'true');
      audio.setAttribute('x-webkit-airplay', 'allow');
      
      audio.volume = usePlayerStore.getState().volume;
      
      if (globalAudioInstance) {
        audio.src = globalAudioInstance.src;
        audio.currentTime = globalAudioInstance.currentTime;
        audio.volume = globalAudioInstance.volume;
      } else {
        globalAudioInstance = audio;
      }

      const handleError = async (e: Event) => {
        const target = e.target as HTMLAudioElement;
        const error = target?.error;
        console.error('Audio: Playback error:', error?.message);
        
        if (currentTrack && !loadingRef.current) {
          try {
            await setupStream();
            setStreamError(false);
          } catch (recoveryError) {
            console.error('Audio: Stream recovery failed:', recoveryError);
            setStreamError(true);
          }
        } else {
          setStreamError(true);
        }
      };

      audio.addEventListener('error', handleError);
      audio.addEventListener('timeupdate', () => {
        if (mountedRef.current) {
          setPosition(audio.currentTime);
        }
      });

      audio.addEventListener('play', () => {
        if (mountedRef.current) {
          statusRef.current = 'playing';
          setPlayerState({ status: 'playing' });
        }
      });

      audio.addEventListener('pause', () => {
        if (mountedRef.current) {
          statusRef.current = 'paused';
          setPlayerState({ status: 'paused' });
        }
      });

      audio.addEventListener('ended', () => {
        if (mountedRef.current) {
          statusRef.current = 'stopped';
          setPlayerState({ status: 'stopped' });
          trackIdRef.current = null;
        }
      });

      // Set isInitialized to true after audio is set up
      setIsInitialized(true);
      console.log('Audio: Initialization complete');

      return () => {
        audio.removeEventListener('error', handleError);
      };
    };
    
    const cleanup = initAudio();
    mountedRef.current = true;
    
    return () => {
      mountedRef.current = false;
      cleanup?.then(cleanupFn => cleanupFn?.());
      if (globalAudioInstance === audioRef.current) {
        globalAudioInstance = null;
      }
    };
  }, []);

  // Initialize SSE connection
  useEffect(() => {
    if (!token || !mountedRef.current || sseSubscriptionRef.current) return;

    const sseManager = SSEManager.getInstance();
    sseManagerRef.current = sseManager;
    sseSubscriptionRef.current = true;

    // Only listen for position updates for audio synchronization
    // Other state updates are handled by the PlayerProvider
    const handlePosition = (data: any) => {
      if (!mountedRef.current || !audioRef.current || !audioRef.current.paused) return;
      audioRef.current.currentTime = data.position;
      setPosition(data.position);
    };

    sseManager.addEventListener('position', handlePosition);

    return () => {
      sseSubscriptionRef.current = false;
      sseManager.removeEventListener('position', handlePosition);
    };
  }, [token]);

  // Track change effect
  useEffect(() => {
    if (!currentTrack) {
      console.log('AudioSync: No current track available');
      return;
    }
    
    if (!mountedRef.current) {
      console.log('AudioSync: Component not mounted');
      return;
    }
    
    if (loadingRef.current) {
      console.log('AudioSync: Loading in progress, skipping track change');
      return;
    }
    
    if (!isInitialized) {
      console.log('AudioSync: Not initialized yet, skipping track change');
      return;
    }
    
    console.log('AudioSync: Track change effect triggered', {
      id: currentTrack.youtubeId,
      title: currentTrack.title,
      requestedBy: {
        username: currentTrack.requestedBy?.username,
        avatar: currentTrack.requestedBy?.avatar
      },
      loading: loadingRef.current,
      initialized: isInitialized
    });
    
    setStreamError(false);
    trackIdRef.current = currentTrack.youtubeId;

    if ('mediaSession' in navigator) {
      // Always use the original youtubeId for artwork
      const originalYoutubeId = currentTrack.youtubeId;
      
      const img = new Image();
      img.onload = () => {
        console.log('AudioSync: Setting media session metadata', {
          title: currentTrack.title,
          artist: currentTrack.requestedBy.username,
          originalId: originalYoutubeId
        });
        
        // Create base URL for artwork using the original youtubeId
        // This is important because the database stores thumbnails using the original ID, not any resolved ID
        const baseUrl = env.apiUrl 
          ? `${env.apiUrl}/api/albumart/${originalYoutubeId}`
          : `/api/albumart/${originalYoutubeId}`;
            
        // For mobile lockscreen players, we need to ensure square images
        // Add a crop parameter to force square aspect ratio
        const artworkUrl = `${baseUrl}?square=1`;
            
        console.log('AudioSync: Using artwork URL:', artworkUrl);

        navigator.mediaSession.metadata = new MediaMetadata({
          title: currentTrack.title,
          artist: currentTrack.requestedBy.username,
          // Provide multiple sizes with the square parameter for different devices
          artwork: [
            { src: artworkUrl, sizes: '96x96', type: 'image/jpeg' },
            { src: artworkUrl, sizes: '128x128', type: 'image/jpeg' },
            { src: artworkUrl, sizes: '192x192', type: 'image/jpeg' },
            { src: artworkUrl, sizes: '256x256', type: 'image/jpeg' },
            { src: artworkUrl, sizes: '384x384', type: 'image/jpeg' },
            { src: artworkUrl, sizes: '512x512', type: 'image/jpeg' }
          ]
        });
        
        // Set media session action handlers
        navigator.mediaSession.setActionHandler('play', () => {
          const audio = document.querySelector('audio');
          if (audio && audio.paused) {
            audio.play().catch(err => console.error('Failed to play:', err));
          }
        });
        
        navigator.mediaSession.setActionHandler('pause', () => {
          const audio = document.querySelector('audio');
          if (audio && !audio.paused) {
            audio.pause();
          }
        });
      };
      
      // Load the image to trigger onload - use the same originalYoutubeId for consistency
      img.src = currentTrack.thumbnail.startsWith('http') 
        ? currentTrack.thumbnail 
        : env.apiUrl 
          ? `${env.apiUrl}/api/albumart/${originalYoutubeId}?square=1`
          : `/api/albumart/${originalYoutubeId}?square=1`;
    }
    
    setupStream().catch(error => {
      console.error('Audio: Failed to setup stream:', error);
      setStreamError(true);
    });
  }, [currentTrack, setupStream, isInitialized]);

  // Cleanup effect
  useEffect(() => {
    return () => {
      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
      // Cleanup HLS
      const hlsManager = HLSManager.getInstance();
      hlsManager.destroy();
    };
  }, []);

  return (
    <audio 
      ref={audioRef}
      onError={(e) => {
        const target = e.target as HTMLAudioElement;
        const error = target?.error;
        console.error('Audio: Element error:', error?.message);
        setStreamError(true);
      }}
      onLoadStart={() => console.log('Audio: Load started')}
      onLoadedData={() => console.log('Audio: Data loaded')}
      onCanPlay={() => console.log('Audio: Can play')}
      onPlaying={() => console.log('Audio: Playing')}
      playsInline
      webkit-playsinline="true"
      preload="auto"
    />
  );
} 