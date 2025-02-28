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
        await hlsManager.attachMedia(audio, currentTrack.youtubeId);
      } else {
        const streamUrl = `${env.apiUrl}/api/music/stream?ts=${Date.now()}&track=${currentTrack.youtubeId}`;
        audio.src = streamUrl;
        audio.load();
      }
      
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          const handleMetadata = () => {
            cleanup();
            resolve();
          };

          const handleError = (error: Event) => {
            cleanup();
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

      if (statusRef.current === 'playing') {
        const response = await fetch(`${env.apiUrl}/api/music/position`);
        const data = await response.json();
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

    const startPlayback = async () => {
      try {
        const audioContext = await initializeAudioContext();
        if (audioContext.state === 'suspended') {
          await audioContext.resume();
        }

        const response = await fetch(`${env.apiUrl}/api/music/position`);
        const data = await response.json();
        audio.currentTime = data.position;
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

    const handlePosition = (data: any) => {
      if (!mountedRef.current || !audioRef.current || !audioRef.current.paused) return;
      audioRef.current.currentTime = data.position;
      setPosition(data.position);
    };

    const handleTrack = (data: any) => {
      if (!mountedRef.current) return;
      if (data.youtubeId !== trackIdRef.current) {
        setupStream();
      }
    };

    const handleStatus = (data: any) => {
      if (!mountedRef.current) return;
      statusRef.current = data.status;
      setPlayerState({ status: data.status });
    };

    const handleState = (data: any) => {
      if (!mountedRef.current) return;
      
      const oldTrackId = trackIdRef.current;
      const newTrackId = data.currentTrack?.youtubeId;
      
      console.log('AudioSync: State update details', {
        oldTrackId,
        newTrackId,
        status: {
          current: statusRef.current,
          new: data.status
        },
        track: data.currentTrack ? {
          id: data.currentTrack.youtubeId,
          title: data.currentTrack.title,
          requestedBy: {
            username: data.currentTrack.requestedBy?.username,
            avatar: data.currentTrack.requestedBy?.avatar,
            id: data.currentTrack.requestedBy?.id
          }
        } : null,
        queueLength: data.queue?.length || 0,
        isTrackChange: oldTrackId !== newTrackId,
        isInitialized
      });
      
      // Update all state at once to prevent race conditions
      const playerState = usePlayerStore.getState();
      const oldTrack = playerState.currentTrack;
      
      usePlayerStore.getState().setPlayerState({
        status: data.status,
        currentTrack: data.currentTrack,
        queue: data.queue,
        position: data.position
      });
      
      // Log state change details
      console.log('AudioSync: Player state updated', {
        oldTrack: oldTrack ? {
          id: oldTrack.youtubeId,
          title: oldTrack.title,
          requestedBy: {
            username: oldTrack.requestedBy?.username,
            avatar: oldTrack.requestedBy?.avatar,
            id: oldTrack.requestedBy?.id
          }
        } : null,
        newTrack: data.currentTrack ? {
          id: data.currentTrack.youtubeId,
          title: data.currentTrack.title,
          requestedBy: {
            username: data.currentTrack.requestedBy?.username,
            avatar: data.currentTrack.requestedBy?.avatar,
            id: data.currentTrack.requestedBy?.id
          }
        } : null,
        statusChanged: statusRef.current !== data.status
      });
      
      // Update track ID and initialize if needed
      if (data.currentTrack) {
        trackIdRef.current = data.currentTrack.youtubeId;
        setIsInitialized(true);
        
        // Log track change
        if (oldTrackId !== data.currentTrack.youtubeId) {
          console.log('AudioSync: Track change details', {
            from: {
              id: oldTrackId,
              track: oldTrack ? {
                title: oldTrack.title,
                requestedBy: {
                  username: oldTrack.requestedBy?.username,
                  avatar: oldTrack.requestedBy?.avatar,
                  id: oldTrack.requestedBy?.id
                }
              } : null
            },
            to: {
              id: data.currentTrack.youtubeId,
              track: {
                title: data.currentTrack.title,
                requestedBy: {
                  username: data.currentTrack.requestedBy?.username,
                  avatar: data.currentTrack.requestedBy?.avatar,
                  id: data.currentTrack.requestedBy?.id
                }
              }
            }
          });
          
          // Setup stream if track changed
          setupStream();
        }
      }
    };

    sseManager.addEventListener('position', handlePosition);
    sseManager.addEventListener('track', handleTrack);
    sseManager.addEventListener('status', handleStatus);
    sseManager.addEventListener('state', handleState);

    sseManager.connect(token).catch(error => {
      console.error('Failed to establish SSE connection:', error);
    });

    return () => {
      sseSubscriptionRef.current = false;
      sseManager.removeEventListener('position', handlePosition);
      sseManager.removeEventListener('track', handleTrack);
      sseManager.removeEventListener('status', handleStatus);
      sseManager.removeEventListener('state', handleState);
    };
  }, [token]);

  // Track change effect
  useEffect(() => {
    if (!currentTrack || !mountedRef.current || loadingRef.current || !isInitialized) return;
    
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
      const img = new Image();
      img.onload = () => {
        console.log('AudioSync: Setting media session metadata', {
          title: currentTrack.title,
          artist: currentTrack.requestedBy.username,
          artwork: currentTrack.thumbnail
        });
        
        navigator.mediaSession.metadata = new MediaMetadata({
          title: currentTrack.title,
          artist: currentTrack.requestedBy.username,
          artwork: [{
            src: currentTrack.thumbnail.startsWith('http') 
              ? currentTrack.thumbnail 
              : `${env.apiUrl}/api/albumart/${currentTrack.youtubeId}`,
            sizes: `${img.width}x${img.height}`,
            type: 'image/jpeg'
          }]
        });
      };
      img.src = currentTrack.thumbnail.startsWith('http') 
        ? currentTrack.thumbnail 
        : `${env.apiUrl}/api/albumart/${currentTrack.youtubeId}`;
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