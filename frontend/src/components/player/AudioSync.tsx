'use client';

import { useRef, useEffect, useState, useCallback } from 'react';
import { useAuthStore } from '@/lib/store/authStore';
import { usePlayerStore } from '@/lib/store/playerStore';
import env from '@/utils/env';
import { useAudioWithAuth } from '@/hooks/useAudioWithAuth';
import Hls from 'hls.js';

// Singleton audio instance
let globalAudioInstance: HTMLAudioElement | null = null;

// Audio context for WebSocket audio processing
let audioContext: AudioContext | null = null;
let audioQueue: AudioBuffer[] = [];
let isPlaying = false;
let sourceNode: AudioBufferSourceNode | null = null;
let gainNode: GainNode | null = null;

export default function AudioSync() {
  const audioRef = useRef<HTMLAudioElement>(null);
  const loadingRef = useRef<boolean>(false);
  const activeRequestRef = useRef<AbortController | null>(null);
  const mountedRef = useRef<boolean>(false);
  const prefetchedTracksRef = useRef<Set<string>>(new Set());
  const previousTrackRef = useRef<string | null>(null);
  const streamUrlRef = useRef<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const mediaSourceRef = useRef<MediaSource | null>(null);
  const sourceBufferRef = useRef<SourceBuffer | null>(null);
  const bufferQueueRef = useRef<ArrayBuffer[]>([]);
  const [streamError, setStreamError] = useState<boolean>(false);
  const [streamMethod, setStreamMethod] = useState<'websocket' | 'hls' | 'http' | null>(null);
  const mediaSessionRef = useRef<boolean>(false);
  const { token } = useAuthStore();
  const { 
    status, 
    currentTrack,
    queue,
    setPosition,
    setPlayerState
  } = usePlayerStore();
  
  // Use our custom hook to handle auth headers for audio streaming
  useAudioWithAuth();

  // Initialize audio context for WebSocket streaming
  const initAudioContext = useCallback(() => {
    if (!audioContext) {
      try {
        audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
        gainNode = audioContext.createGain();
        gainNode.gain.value = 1.0; // Default volume
        gainNode.connect(audioContext.destination);
        // Only log in development
        if (process.env.NODE_ENV === 'development') {
          // Audio context initialized
        }
      } catch (error) {
        setStreamError(true);
      }
    }
    return audioContext;
  }, []);

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

  // WebSocket audio streaming setup
  const setupWebSocketAudio = useCallback(() => {
    if (!token || wsRef.current || !audioRef.current) return;
    
    try {
      // Instead of using MediaSource Extensions which isn't supported for MP3,
      // we'll use a direct audio element approach
      const audio = audioRef.current;
      
      // Create WebSocket connection
      const wsUrl = `${env.apiUrl.replace('https://', 'wss://').replace('http://', 'ws://')}/api/music/ws-stream?token=${token}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      
      // Handle WebSocket events
      ws.binaryType = 'arraybuffer';
      
      ws.onopen = () => {
        setStreamMethod('websocket');
      };
      
      ws.onmessage = async (event) => {
        try {
          // Handle text messages (like connection confirmation)
          if (typeof event.data === 'string') {
            // Try to parse as JSON
            try {
              const message = JSON.parse(event.data);
              
              // Handle track change notifications
              if (message.type === 'track_change' && message.youtubeId) {
                // We'll let the normal state polling handle the actual track change
              }
            } catch (e) {
              // Not JSON, just a regular message
            }
            
            return;
          }
          
          // For binary data, we'll use a simpler approach
          // Instead of trying to decode it directly, we'll just wait
          // for the server to implement a compatible streaming format
        } catch (error) {
          // Error processing WebSocket message
        }
      };
      
      ws.onerror = (error) => {
        setStreamError(true);
        wsRef.current = null;
      };
      
      ws.onclose = () => {
        wsRef.current = null;
      };
      
    } catch (error) {
      setStreamError(true);
    }
  }, [token, setPlayerState]);
  
  // HLS streaming setup
  const setupHLSStreaming = useCallback(() => {
    if (!token || !audioRef.current || !currentTrack?.youtubeId || !Hls.isSupported()) {
      // Fall back to HTTP streaming if HLS is not supported
      setupHTTPStreaming();
      return;
    }
    
    try {
      // Clean up existing HLS instance
      if (hlsRef.current) {
        hlsRef.current.destroy();
      }
      
      const audio = audioRef.current;
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 90
      });
      
      hlsRef.current = hls;
      
      // Set up HLS
      const hlsUrl = `${env.apiUrl}/api/music/hls/${currentTrack.youtubeId}/playlist.m3u8`;
      
      hls.loadSource(hlsUrl);
      hls.attachMedia(audio);
      
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setStreamMethod('hls');
        
        if (status === 'playing') {
          audio.play().catch(error => {
            setPlayerState({ status: 'paused' });
          });
        }
      });
      
      hls.on(Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
          hls.destroy();
          hlsRef.current = null;
          setStreamError(true);
          
          // Fall back to HTTP streaming
          setupHTTPStreaming();
        }
      });
      
    } catch (error) {
      setStreamError(true);
      
      // Fall back to HTTP streaming
      setupHTTPStreaming();
    }
  }, [token, currentTrack?.youtubeId, status, setPlayerState]);
  
  // HTTP streaming setup (fallback)
  const setupHTTPStreaming = useCallback(() => {
    if (!token || !audioRef.current || !currentTrack?.youtubeId) return;
    
    try {
      const audio = audioRef.current;
      const streamUrl = `${env.apiUrl}/api/music/stream`;
      
      // Set up the audio stream
      audio.src = streamUrl;
      audio.crossOrigin = 'anonymous';
      
      // Add event listeners
      const handleCanPlay = () => {
        loadingRef.current = false;
        setStreamMethod('http');
        
        if (status === 'playing') {
          audio.play().catch(error => {
            setPlayerState({ status: 'paused' });
          });
        }
      };
      
      const handleError = (error: Event) => {
        setStreamError(true);
        
        // Try to fall back to individual file playback
        if (currentTrack?.youtubeId && !audio.src.includes(currentTrack.youtubeId)) {
          audio.src = `${env.apiUrl}/api/music/audio/${currentTrack.youtubeId}`;
          audio.load();
        }
      };
      
      audio.addEventListener('canplay', handleCanPlay);
      audio.addEventListener('error', handleError);
      
      // Load the stream
      audio.load();
      
      return () => {
        audio.removeEventListener('canplay', handleCanPlay);
        audio.removeEventListener('error', handleError);
      };
    } catch (error) {
      setStreamError(true);
    }
  }, [token, currentTrack?.youtubeId, status, setPlayerState]);

  // Set up audio streaming based on available methods
  useEffect(() => {
    if (!mountedRef.current || !token) return;
    
    // Only use WebSocket streaming as requested
    setupWebSocketAudio();
    
    return () => {
      // Clean up WebSocket
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      
      // Clean up MediaSource
      if (mediaSourceRef.current) {
        if (mediaSourceRef.current.readyState === 'open') {
          try {
            mediaSourceRef.current.endOfStream();
          } catch (error) {
            // Error ending MediaSource stream
          }
        }
        mediaSourceRef.current = null;
        sourceBufferRef.current = null;
        bufferQueueRef.current = [];
      }
      
      // Clean up HLS
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [token, setupWebSocketAudio]);

  // Setup MediaSession API for mobile devices
  useEffect(() => {
    // Check if MediaSession API is available
    if (!mountedRef.current || !audioRef.current || !currentTrack) return;
    if (!('mediaSession' in navigator)) {
      console.log('MediaSession API not supported in this browser');
      return;
    }
    
    const audio = audioRef.current;
    
    try {
      // Set metadata for MediaSession
      if ('MediaMetadata' in window) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: currentTrack.title,
          artist: currentTrack.requestedBy?.username || 'Unknown',
          album: 'MIU',
          artwork: [
            { src: currentTrack.thumbnail, sizes: '512x512', type: 'image/jpeg' }
          ]
        });
      }
      
      // Set playback state
      navigator.mediaSession.playbackState = status === 'playing' ? 'playing' : 'paused';
      
      // Set action handlers
      if (typeof navigator.mediaSession.setActionHandler === 'function') {
        // Set play/pause handlers
        navigator.mediaSession.setActionHandler('play', () => {
          if (audio.paused) {
            audio.play().catch(error => {
              setPlayerState({ status: 'paused' });
            });
          }
        });
        
        navigator.mediaSession.setActionHandler('pause', () => {
          if (!audio.paused) {
            audio.pause();
          }
        });
        
        // Set next/previous handlers if needed
        navigator.mediaSession.setActionHandler('nexttrack', () => {
          // Send command to play next track
          fetch(`${env.apiUrl}/api/music/skip`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json'
            }
          }).catch(error => {
            console.error('Failed to skip track:', error);
          });
        });
        
        // Completely disable all seeking-related actions
        try {
          // Check if we're on iOS
          const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
          
          if (isIOS) {
            // On iOS, we need a different approach
            // First, try setting to null (works on some browsers)
            try {
              navigator.mediaSession.setActionHandler('seekto', null);
              navigator.mediaSession.setActionHandler('seekforward', null);
              navigator.mediaSession.setActionHandler('seekbackward', null);
            } catch (e) {
              // If that fails, use no-op functions
              const noopSeekHandler = () => {
                console.log('Seek attempt prevented');
                // Do nothing - this effectively prevents seeking
              };
              
              navigator.mediaSession.setActionHandler('seekto', noopSeekHandler);
              navigator.mediaSession.setActionHandler('seekforward', noopSeekHandler);
              navigator.mediaSession.setActionHandler('seekbackward', noopSeekHandler);
            }
          } else {
            // For non-iOS, setting to null usually works
            navigator.mediaSession.setActionHandler('seekto', null);
            navigator.mediaSession.setActionHandler('seekforward', null);
            navigator.mediaSession.setActionHandler('seekbackward', null);
          }
        } catch (e) {
          console.log('Error setting up seek prevention:', e);
        }
        
        // If position state is supported, set it but don't allow seeking
        if (navigator.mediaSession.setPositionState) {
          navigator.mediaSession.setPositionState({
            duration: currentTrack.duration,
            playbackRate: 1,
            position: 0 // We'll update this separately
          });
        }
      }
      
      mediaSessionRef.current = true;
    } catch (error) {
      console.error('Failed to setup MediaSession:', error);
    }
    
    // Update position state periodically for MediaSession
    let positionUpdateInterval: NodeJS.Timeout | null = null;
    
    if (navigator.mediaSession.setPositionState) {
      positionUpdateInterval = setInterval(() => {
        try {
          if (audio.currentTime > 0 && !audio.paused) {
            navigator.mediaSession.setPositionState({
              duration: currentTrack.duration,
              playbackRate: 1,
              position: audio.currentTime
            });
          }
        } catch (error) {
          console.error('Failed to update position state:', error);
        }
      }, 1000);
    }
    
    return () => {
      if (positionUpdateInterval) {
        clearInterval(positionUpdateInterval);
      }
    };
  }, [currentTrack, status, token, setPlayerState]);

  // Update MediaSession playback state when status changes
  useEffect(() => {
    if (!mediaSessionRef.current) return;
    if (!('mediaSession' in navigator)) return;
    
    try {
      navigator.mediaSession.playbackState = status === 'playing' ? 'playing' : 'paused';
    } catch (error) {
      console.error('Failed to update MediaSession playback state:', error);
    }
  }, [status]);

  // Handle play/pause and track changes
  useEffect(() => {
    if (!mountedRef.current || !audioRef.current || !currentTrack || !token) return;
    
    const audio = audioRef.current;
    loadingRef.current = true;
    
    // Set up direct audio URL for the current track
    if (currentTrack.youtubeId) {
      // Create a URL with the token as a query parameter for authentication
      const audioUrl = `${env.apiUrl}/api/music/audio/${currentTrack.youtubeId}?token=${encodeURIComponent(token)}`;
      
      if (audio.src !== audioUrl) {
        // Add event listeners
        const handleCanPlay = () => {
          loadingRef.current = false;
          
          if (status === 'playing') {
            audio.play().catch(error => {
              setPlayerState({ status: 'paused' });
            });
          }
        };
        
        const handleError = (e: Event) => {
          loadingRef.current = false;
          setStreamError(true);
        };
        
        // Remove any existing listeners
        audio.removeEventListener('canplay', handleCanPlay);
        audio.removeEventListener('error', handleError);
        
        // Add new listeners
        audio.addEventListener('canplay', handleCanPlay);
        audio.addEventListener('error', handleError);
        
        // Set the source and load
        audio.src = audioUrl;
        audio.crossOrigin = 'anonymous'; // Enable CORS
        
        // Store the current position to prevent seeking
        let lastKnownPosition = 0;
        let isSeeking = false;
        let isUserInitiatedSeek = false;
        
        const updateLastKnownPosition = () => {
          if (audio.currentTime > 0 && !isSeeking) {
            lastKnownPosition = audio.currentTime;
          }
        };
        
        // Update the last known position periodically
        const positionInterval = setInterval(updateLastKnownPosition, 250);
        
        // Handle seeking start - mark that we're in a seeking state
        const handleSeekStart = () => {
          isSeeking = true;
          // Determine if this is a user-initiated seek
          isUserInitiatedSeek = document.activeElement === audio || 
                               document.querySelector('audio:focus-within') !== null;
        };
        
        // Handle seeking end - reset to the last known position
        const handleSeekEnd = () => {
          if (isSeeking && isUserInitiatedSeek) {
            // Only reset if there was a significant change and it was user-initiated
            const seekDifference = Math.abs(audio.currentTime - lastKnownPosition);
            if (seekDifference > 1) {
              console.log('Preventing user-initiated seek, resetting to', lastKnownPosition);
              
              // Use requestAnimationFrame to avoid visual glitches
              requestAnimationFrame(() => {
                audio.currentTime = lastKnownPosition;
              });
            }
          }
          isSeeking = false;
          isUserInitiatedSeek = false;
        };
        
        // Listen for seeking events
        audio.addEventListener('seeking', handleSeekStart);
        audio.addEventListener('seeked', handleSeekEnd);
        
        audio.load();
        
        // Clean up function
        return () => {
          audio.removeEventListener('canplay', handleCanPlay);
          audio.removeEventListener('error', handleError);
          audio.removeEventListener('seeking', handleSeekStart);
          audio.removeEventListener('seeked', handleSeekEnd);
          clearInterval(positionInterval);
        };
      }
    }
    
    // If we already have the audio loaded, just handle play/pause
    if (!loadingRef.current) {
      if (status === 'playing') {
        const playPromise = audio.play();
        if (playPromise) {
          playPromise.catch((error) => {
            if (status === 'playing') {
              setPlayerState({ status: 'paused' });
            }
          });
        }
      } else {
        audio.pause();
      }
    }
  }, [status, setPlayerState, currentTrack, token]);

  // Disable prefetch as requested
  // Prefetch next track in queue - DISABLED
  useEffect(() => {
    // This effect is intentionally disabled as requested
    // No prefetching will occur
  }, [token, queue]);

  return (
    <>
      <audio 
        ref={audioRef} 
        preload="auto"
        style={{ display: process.env.NODE_ENV === 'development' ? 'block' : 'none' }} 
        controls={process.env.NODE_ENV === 'development'}
      />
      {streamMethod && (
        <div className={process.env.NODE_ENV === 'development' ? '' : 'hidden'}>
          Using {streamMethod} streaming
        </div>
      )}
    </>
  );
} 