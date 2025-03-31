'use client';

import { useRef, useEffect, useState, useCallback } from 'react';
import { useAuthStore } from '@/lib/store/authStore';
import { usePlayerStore } from '@/lib/store/playerStore';
import env from '@/utils/env';
import { useAudioWithAuth } from '@/hooks/useAudioWithAuth';
import SSEManager from '@/lib/sse/SSEManager';

// Constant for track playback offset (in seconds)
const TRACK_PLAYBACK_OFFSET = 0;

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
  const trackEndTimerRef = useRef<NodeJS.Timeout | null>(null);
  const wakeLockRef = useRef<any>(null);
  const requestTimeRef = useRef<number>(0); // Track when position requests are made
  const playbackStartTimeRef = useRef<number>(0); // Track when playback actually starts
  const hasInitialSyncRef = useRef<boolean>(false);
  const initialSyncTimeRef = useRef<number>(0); // When we got the server time
  const serverPositionRef = useRef<number>(0);  // Position from server
  const positionSyncInProgressRef = useRef<boolean>(false); // Lock to prevent multiple position requests
  const bufferingCompensationAppliedRef = useRef<boolean>(false); // Track if buffering compensation was applied
  const lastStatusChangeTimeRef = useRef<number>(0); // Track time of last status change
  
  const lastSyncTimeRef = useRef<number>(0);
  const originalPlaybackRateRef = useRef<number>(1);
  const crossfadeAudioRef = useRef<HTMLAudioElement | null>(null);
  
  // Add reference for tracking playback start timestamp
  const playbackStartedAtRef = useRef<number>(0);
  const lastBackgroundReturnTimeRef = useRef<number>(0);
  
  useAudioWithAuth();

  // Function to reset sync state when track changes
  const resetSyncState = useCallback(() => {
    hasInitialSyncRef.current = false;
    initialSyncTimeRef.current = 0;
    serverPositionRef.current = 0;
    console.log('Audio: Reset sync state');
  }, []);

  // Function to fetch position from API with latency compensation
  const fetchPositionWithLatencyCompensation = useCallback(async (audio: HTMLAudioElement) => {
    // Prevent multiple simultaneous position requests
    if (positionSyncInProgressRef.current) {
      console.log('Audio: Position sync already in progress, skipping request');
      return { position: audio.currentTime };
    }
    
    try {
      positionSyncInProgressRef.current = true;
      
    // Record the time before making the request
    requestTimeRef.current = performance.now();
    const response = await fetch(`${env.apiUrl}/api/music/position`);
    const data = await response.json();
    
    // Calculate request duration
    const requestDuration = performance.now() - requestTimeRef.current;
    console.log(`Audio: Position request took ${requestDuration.toFixed(2)}ms`);
    
    // Compensate for network delay and apply offset
    const adjustedPosition = Math.max(0, data.position - (requestDuration / 1000) - TRACK_PLAYBACK_OFFSET);
    
    console.log('Audio: Setting position from API', {
      original: data.position,
      adjusted: adjustedPosition,
      compensation: requestDuration / 1000,
      offset: TRACK_PLAYBACK_OFFSET,
      serverTime: data.timestamp
    });
    
    // Store the sync data with both timestamp references
    // - performance.now() for high-precision timing when tab is active
    // - Date.now() for absolute timestamps that work across background periods
    hasInitialSyncRef.current = true;
    initialSyncTimeRef.current = performance.now();
    lastSyncTimeRef.current = Date.now();
    serverPositionRef.current = adjustedPosition;
    
    audio.currentTime = adjustedPosition;
    
    // Reset buffering compensation flag
    bufferingCompensationAppliedRef.current = false;
    
    // Record time before attempting to play
    playbackStartTimeRef.current = performance.now();
    
    const handlePlaybackStart = () => {
      if (bufferingCompensationAppliedRef.current) {
        console.log('Audio: Buffering compensation already applied, skipping');
        return;
      }
      
      bufferingCompensationAppliedRef.current = true;
      const playbackStartDelay = performance.now() - playbackStartTimeRef.current;
      console.log(`Audio: Playback actually started after ${playbackStartDelay.toFixed(2)}ms (includes buffering)`);
      const bufferingCompensation = playbackStartDelay / 1000;
      const newPosition = Math.max(0, audio.currentTime + bufferingCompensation);
      console.log(`Audio: Compensating for buffering delay by seeking forward ${bufferingCompensation.toFixed(3)}s to ${newPosition.toFixed(3)}s`);
      audio.currentTime = newPosition;
    };
    
    audio.addEventListener('playing', handlePlaybackStart, { once: true });
    
    return { position: audio.currentTime };
    } finally {
      // Release the lock after a short delay to prevent immediate re-requests
      setTimeout(() => {
        positionSyncInProgressRef.current = false;
      }, 500);
    }
  }, []);

  // Function to get current position without API call
  const getCalculatedPosition = useCallback(() => {
    if (!hasInitialSyncRef.current) {
      console.log('Audio: No initial sync data available, fetching from server');
      return 0; // Will trigger a fetch from server
    }
    
    // Calculate based on absolute timestamps instead of performance metrics
    // This is more reliable with background tabs
    const now = Date.now();
    const serverTimestamp = lastSyncTimeRef.current;
    const elapsedWallClockTime = (now - serverTimestamp) / 1000; // in seconds
    
    // Use wall clock time for background-resilient position calculation
    const calculatedPosition = serverPositionRef.current + elapsedWallClockTime;
    
    // Backup calculation using performance API (more accurate when tab is active)
    const elapsedSinceSync = (performance.now() - initialSyncTimeRef.current) / 1000;
    const perfCalculatedPosition = serverPositionRef.current + elapsedSinceSync;
    
    // Log only occasionally to reduce spam
    if (Math.random() < 0.05) { // ~5% of calls
    console.log('Audio: Calculated position', {
      initial: serverPositionRef.current,
        wallClockElapsed: elapsedWallClockTime,
        perfElapsed: elapsedSinceSync,
        wallClockCalculated: calculatedPosition,
        perfCalculated: perfCalculatedPosition,
        difference: calculatedPosition - perfCalculatedPosition
      });
    }
    
    // If the tab has been in the background (performance API and wall clock differ significantly),
    // prefer the wall clock calculation as it's more reliable across background periods
    const timingDifference = Math.abs(elapsedWallClockTime - elapsedSinceSync);
    if (timingDifference > 1) {
      console.log('Audio: Significant timing difference detected, likely due to background tab:', timingDifference.toFixed(2) + 's');
      return calculatedPosition; // Use wall clock calculation
    }
    
    // When tab is active, performance API is more accurate, so prefer that
    return perfCalculatedPosition;
  }, []);

  // Function to set position with buffering compensation
  const setPositionWithBufferingCompensation = useCallback((audio: HTMLAudioElement, position: number) => {
    // Apply the offset when setting position (subtract offset to make playback delayed)
    audio.currentTime = Math.max(0, position - TRACK_PLAYBACK_OFFSET);
    
    // Reset buffering compensation flag
    bufferingCompensationAppliedRef.current = false;
    
    playbackStartTimeRef.current = performance.now();
    
    const handlePlaybackStart = () => {
      if (bufferingCompensationAppliedRef.current) {
        console.log('Audio: Buffering compensation already applied, skipping');
        return;
      }
      
      bufferingCompensationAppliedRef.current = true;
      const playbackStartDelay = performance.now() - playbackStartTimeRef.current;
      console.log(`Audio: Playback actually started after ${playbackStartDelay.toFixed(2)}ms (includes buffering)`);
      const bufferingCompensation = playbackStartDelay / 1000;
      const newPosition = Math.max(0, audio.currentTime + bufferingCompensation);
      console.log(`Audio: Compensating for buffering delay by seeking forward ${bufferingCompensation.toFixed(3)}s to ${newPosition.toFixed(3)}s`);
      audio.currentTime = newPosition;
    };
    
    audio.addEventListener('playing', handlePlaybackStart, { once: true });
  }, []);

  // Function to setup stream for a track
  const setupStream = useCallback(async () => {
    if (!mountedRef.current || !audioRef.current || !currentTrack) return;

    console.log('Audio: Setting up stream', {
      trackId: currentTrack.youtubeId,
      loading: loadingRef.current,
      initialized: isInitialized,
      currentStatus: statusRef.current
    });

    // If already loading, wait for it to complete or timeout
    if (loadingRef.current) {
      console.log('Audio: Another stream setup is in progress, waiting...');
      let retryCount = 0;
      while (loadingRef.current && retryCount < 10) {
        await new Promise(resolve => setTimeout(resolve, 100));
        retryCount++;
      }
      if (loadingRef.current) {
        console.log('Audio: Timeout waiting for previous stream setup to complete');
        return;
      }
    }
    
    try {
      // Set loading flag first to prevent concurrent setups
      loadingRef.current = true;
      
      // Clear any existing locks
      positionSyncInProgressRef.current = false;
      bufferingCompensationAppliedRef.current = false;
      
      const audio = audioRef.current;
      setStreamError(false);
      
      // Store the track status at the start of setup
      const targetStatus = statusRef.current === 'playing' || usePlayerStore.getState().status === 'playing'
        ? 'playing' : 'paused';
      
      console.log('Audio: Stream setup target status:', targetStatus);
      
      // Prefer direct secure streaming
      console.log('Audio: Using secure direct streaming for playback');
      try {
        // First fetch a secure token
        const tokenResponse = await fetch(`${env.apiUrl}/api/music/secure-token/${currentTrack.youtubeId}`);
        if (!tokenResponse.ok) {
          throw new Error('Failed to obtain secure token');
        }
        
        const { token } = await tokenResponse.json();
        const streamUrl = `${env.apiUrl}/api/music/secure-stream/${token}`;
        audio.src = streamUrl;
        audio.load();
      } catch (secureStreamError) {
        console.error('Audio: Secure streaming failed, falling back to direct stream URL:', secureStreamError);
        const streamUrl = `${env.apiUrl}/api/music/stream?ts=${Date.now()}&track=${currentTrack.youtubeId}`;
        audio.src = streamUrl;
        audio.load();
      }
      
      // Wait for metadata to load
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

      // Get the current player status again (it might have changed during setup)
      const currentStatus = statusRef.current === 'playing' || usePlayerStore.getState().status === 'playing'
        ? 'playing' : 'paused';
        
      console.log('Audio: Current status after stream setup:', currentStatus);

      // If status is playing, setup auto-play once stream is ready
      if (currentStatus === 'playing') {
        console.log('Audio: Current status is playing, preparing to play after stream setup');
        
        // Setup one-time handler for canplay event
        const handleCanPlay = async () => {
          // Remove the listener first to avoid multiple calls
          audio.removeEventListener('canplay', handleCanPlay);
          console.log('Audio: New track can play, attempting to start playback');
          
          // Check status again - it might have changed while waiting for canplay
          if (statusRef.current === 'playing' || usePlayerStore.getState().status === 'playing') {
            try {
              // Use the position from the server to ensure sync
              // Set the lock to prevent duplicate position sync
              if (!positionSyncInProgressRef.current && !hasInitialSyncRef.current) {
                await fetchPositionWithLatencyCompensation(audio);
              } else {
                console.log('Audio: Position sync already performed, using current position:', audio.currentTime);
              }
              
              // Only play if we're still in a playing state
              if (statusRef.current === 'playing' || usePlayerStore.getState().status === 'playing') {
                await audio.play().catch(e => {
                  console.error('Audio: Failed to play new track after setup:', e);
                });
              } else {
                console.log('Audio: Not starting playback - status changed to', statusRef.current);
              }
            } catch (error) {
              console.error('Audio: Error starting playback for new track after setup:', error);
            }
          } else {
            console.log('Audio: Track ready but not starting playback - player state is now', statusRef.current);
          }
        };
        
        // Register the canplay handler
        audio.addEventListener('canplay', handleCanPlay, { once: true });
      } else {
        console.log('Audio: Current status is not playing, skipping auto-play setup');
      }
    } catch (error) {
      console.error('Audio: Stream setup error:', error);
      setStreamError(true);
    } finally {
      // Short delay before releasing loading lock to prevent immediate retriggering
      setTimeout(() => {
      if (mountedRef.current) {
        loadingRef.current = false;
          console.log('Audio: Stream setup loading flag released');
      }
      }, 100);
    }
  }, [currentTrack, isInitialized, fetchPositionWithLatencyCompensation]);

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

      // Position is handled by loadeddata event
      // Just start playback
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

  // Status change effect - optimized with rate limiting
  useEffect(() => {
    if (!audioRef.current || !mountedRef.current || !isInitialized) return;

    // Rate limit status changes to prevent rapid consecutive triggers
    const now = performance.now();
    const timeSinceLastChange = now - lastStatusChangeTimeRef.current;
    if (timeSinceLastChange < 1000) { // Increased debounce to 1000ms
      return;
    }
    
    const audio = audioRef.current;
    const currentAudioState = audio.paused ? 'paused' : 'playing';
    
    // Skip if status and audio state are already aligned
    if ((status === 'playing' && currentAudioState === 'playing') || 
        (status === 'paused' && currentAudioState === 'paused')) {
      return;
    }

    lastStatusChangeTimeRef.current = now;
    
    if (process.env.NODE_ENV === 'development') {
      console.log('Audio: Status change effect triggered', { 
        status, 
        currentAudioState,
        isInitialized,
        currentTrack: currentTrack?.youtubeId,
        hasInitialSync: hasInitialSyncRef.current
      });
    }

    // Don't attempt to play if we're loading a new track
    if (loadingRef.current) {
      if (process.env.NODE_ENV === 'development') {
        console.log('Audio: Loading in progress, deferring playback');
      }
      return;
    }

    const startPlayback = async () => {
      // When starting playback, reset the buffering compensation flag
      bufferingCompensationAppliedRef.current = false;
      
      try {
        const audioContext = await initializeAudioContext();
        if (audioContext.state === 'suspended') {
          await audioContext.resume();
        }

        await audio.play().catch(error => {
          console.error('Audio: Play error in startPlayback:', error);
          if (error.name !== 'NotAllowedError') {
            setPlayerState({ status: 'paused' });
          }
        });
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
  }, [status, isInitialized, currentTrack, initializeAudioContext]);

  // Function to handle track completion
  const handleTrackEnd = useCallback(async () => {
    if (!mountedRef.current || !currentTrack) return;
    
    console.log('AudioSync: Track end detected, handling track completion');
    statusRef.current = 'stopped';
    setPlayerState({ status: 'stopped' });
    trackIdRef.current = null;
    
    // Reset sync state when track ends
    hasInitialSyncRef.current = false;
    positionSyncInProgressRef.current = false;
    bufferingCompensationAppliedRef.current = false;
    
    // We don't need to notify the backend since the server already:
    // 1. Tracks song duration and position internally
    // 2. Advances to next track automatically
    // 3. Broadcasts track changes via SSE to all clients
    console.log('AudioSync: Waiting for server to broadcast next track via SSE');
    
  }, [currentTrack]);
  
  // Add a timer effect to track playback progress and detect end of track
  useEffect(() => {
    if (!currentTrack || !audioRef.current || !isInitialized) return;
    
    // Clear any existing timer
    if (trackEndTimerRef.current) {
      clearInterval(trackEndTimerRef.current);
      trackEndTimerRef.current = null;
    }
    
    const audio = audioRef.current;
    const trackDuration = currentTrack.duration;
    
    // Set up timer to check if we've reached the end of the track
    trackEndTimerRef.current = setInterval(() => {
      if (!audio || audio.paused) return;
      
      // Get current time and compare with duration
      const currentTime = audio.currentTime;
      
      // Add the offset to the current time when comparing with duration
      // This makes the track end timer fire earlier to compensate for delayed playback
      const adjustedCurrentTime = currentTime + TRACK_PLAYBACK_OFFSET;
      const timeRemaining = trackDuration - adjustedCurrentTime;
      
      // Only log at meaningful intervals - remaining time is linear
      // Just log at 30, 20, 10, 5, 3, 2, 1 seconds remaining
      if ([30, 20, 10, 5, 3, 2, 1].includes(Math.round(timeRemaining))) {
        console.log(`AudioSync: Track time remaining: ${timeRemaining.toFixed(1)}s`);
      }
      
      // If we're close to the end of the track (within 0.5 second) or passed it
      if (timeRemaining <= 0.5) {
        console.log('AudioSync: Track end timer detected end of track');
        console.log(`AudioSync: Current time: ${currentTime.toFixed(2)}s, Adjusted time: ${adjustedCurrentTime.toFixed(2)}s, Track duration: ${trackDuration.toFixed(2)}s`);
        handleTrackEnd();
        
        // Clear this timer
        if (trackEndTimerRef.current) {
          clearInterval(trackEndTimerRef.current);
          trackEndTimerRef.current = null;
        }
      }
    }, 500); // Check twice a second is plenty for reliable end detection
    
    return () => {
      if (trackEndTimerRef.current) {
        clearInterval(trackEndTimerRef.current);
        trackEndTimerRef.current = null;
      }
    };
  }, [currentTrack, isInitialized, handleTrackEnd]);

  // Initialize singleton audio instance
  useEffect(() => {
    if (!audioRef.current) return;
    
    console.log('Audio: Starting initialization...');
    
    // Flag that we're mounted at the beginning of initialization
    mountedRef.current = true;
    
    const initAudio = async () => {
      const audio = audioRef.current;
      if (!audio) return;

      // Only set audio properties if they haven't been set yet
      if (!audio.hasAttribute('initialized')) {
      audio.preload = 'auto';
      audio.setAttribute('playsinline', 'true');
      audio.setAttribute('webkit-playsinline', 'true');
      audio.setAttribute('x-webkit-airplay', 'allow');
        audio.setAttribute('initialized', 'true');
      
      audio.volume = usePlayerStore.getState().volume;
      
      if (globalAudioInstance) {
        audio.src = globalAudioInstance.src;
        audio.currentTime = globalAudioInstance.currentTime;
        audio.volume = globalAudioInstance.volume;
      } else {
        globalAudioInstance = audio;
        }
      }

      // Only attach event listeners once
      if (!audio.hasAttribute('listeners-attached')) {
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

      audio.addEventListener('ended', async () => {
        if (mountedRef.current) {
          console.log('AudioSync: Ended event fired from audio element');
          await handleTrackEnd();
        }
      });

        audio.setAttribute('listeners-attached', 'true');

        // Set up cleanup function
        const cleanup = () => {
        audio.removeEventListener('error', handleError);
      };
        
        return cleanup;
      }
      
      return () => {}; // No cleanup needed if listeners already attached
    };
    
    // Initialize and store cleanup function
    const cleanupPromise = initAudio();
    
    // Set isInitialized to true after audio is set up
    setIsInitialized(true);
    console.log('Audio: Initialization complete');
    
    return () => {
      mountedRef.current = false;
      cleanupPromise.then(cleanupFn => {
        if (typeof cleanupFn === 'function') {
          cleanupFn();
        }
      });
      if (globalAudioInstance === audioRef.current) {
        globalAudioInstance = null;
      }
    };
  }, []); // Only run once on mount

  // Initialize SSE connection - optimized to run only once
  useEffect(() => {
    if (!token || !mountedRef.current || sseSubscriptionRef.current) return;

    console.log('Audio: Setting up SSE subscription');
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
      if (sseSubscriptionRef.current) {
        console.log('Audio: Cleaning up SSE subscription');
      sseSubscriptionRef.current = false;
      sseManager.removeEventListener('position', handlePosition);
      }
    };
  }, [token]); // Only run when token changes

  // Track change effect - optimized
  useEffect(() => {
    if (!currentTrack) {
      if (process.env.NODE_ENV === 'development') {
        console.log('AudioSync: No current track available');
      }
      // Reset sync state when we have no track
      hasInitialSyncRef.current = false;
      positionSyncInProgressRef.current = false;
      bufferingCompensationAppliedRef.current = false;
      return;
    }
    
    // Skip if component is not mounted or audio not initialized
    if (!mountedRef.current || !isInitialized) {
      if (process.env.NODE_ENV === 'development') {
        console.log('AudioSync: Component not ready, skipping track change');
      }
      return;
    }
    
    // Skip if already loading
    if (loadingRef.current) {
      if (process.env.NODE_ENV === 'development') {
        console.log('AudioSync: Loading in progress, skipping track change');
      }
      return;
    }
    
    // Skip if track hasn't actually changed
    if (trackIdRef.current === currentTrack.youtubeId) {
      return;
    }
    
    if (process.env.NODE_ENV === 'development') {
      console.log('AudioSync: Track change effect triggered', {
        id: currentTrack.youtubeId,
        title: currentTrack.title,
        requestedBy: {
          username: currentTrack.requestedBy?.username,
          avatar: currentTrack.requestedBy?.avatar
        },
        loading: loadingRef.current,
        initialized: isInitialized,
        syncInProgress: positionSyncInProgressRef.current
      });
    }
    
    // Reset sync state for new track
    resetSyncState();
    
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
      img.src = env.apiUrl 
        ? `${env.apiUrl}/api/albumart/${originalYoutubeId}?square=1`
        : `/api/albumart/${originalYoutubeId}?square=1`;
    }
    
    // Clear any position sync locks before setting up the stream
    positionSyncInProgressRef.current = false;
    
    setupStream().catch(error => {
      console.error('Audio: Failed to setup stream:', error);
      setStreamError(true);
    });
  }, [currentTrack?.youtubeId, isInitialized, setupStream, resetSyncState]);

  // Modify user activity detection to remove drift check calls
  useEffect(() => {
    if (!isInitialized || !audioRef.current) return;
    
    // Use a specific visibility change handler that's more robust
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        console.log('AudioSync: Page became visible, performing immediate sync');
        
        const audio = audioRef.current;
        if (!audio || audio.paused) return;
        
        // Mark the time we returned from background to enable post-background sync period
        lastBackgroundReturnTimeRef.current = Date.now();
        
        // Calculate how long we were in background
        const now = Date.now();
        const lastSyncAge = now - lastSyncTimeRef.current;
        
        console.log(`AudioSync: Last sync was ${lastSyncAge/1000}s ago`);
        
        // When returning from background, always force a resync with server
        const syncAfterBackground = async () => {
          try {
            // Force immediate server position check
            requestTimeRef.current = performance.now();
            const response = await fetch(`${env.apiUrl}/api/music/position`);
            const data = await response.json();
            
            // Compensate for network latency
            const requestDuration = performance.now() - requestTimeRef.current;
            const actualServerPosition = Math.max(0, data.position - (requestDuration / 1000));
            
            console.log('AudioSync: After background, fetched server position:', actualServerPosition);
            
            // Update our reference points
            lastSyncTimeRef.current = now;
            serverPositionRef.current = actualServerPosition;
            initialSyncTimeRef.current = performance.now();
            
            // Apply server position directly
            audio.currentTime = Math.max(0, actualServerPosition - TRACK_PLAYBACK_OFFSET);
            
            console.log('AudioSync: Applied server position after background');
          } catch (error) {
            console.error('AudioSync: Error during visibility change sync:', error);
          }
        };
        
        // Always run background sync correction when becoming visible
        syncAfterBackground();
      } else if (document.visibilityState === 'hidden') {
        // When going to background, record the timestamp for later calculation
        console.log('AudioSync: Page hidden, recording timestamp for later sync calculation');
        
        // Store current state before going to background
        if (audioRef.current && !audioRef.current.paused) {
          const audio = audioRef.current;
          const currentPosition = audio.currentTime;
          
          // Calculate current server position estimate
          const elapsedSinceSync = (performance.now() - initialSyncTimeRef.current) / 1000;
          const estimatedServerPosition = serverPositionRef.current + elapsedSinceSync;
          
          console.log('AudioSync: Before background -', 
            {clientPos: currentPosition, 
             serverEstimate: estimatedServerPosition,
             timestamp: Date.now()}
          );
        }
      }
    };
    
    // Use our specialized visibility handler
    document.addEventListener('visibilitychange', handleVisibilityChange);
    
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isInitialized, currentTrack, getCalculatedPosition]);

  // Update audio play event to record playback start time
  useEffect(() => {
    if (!isInitialized || !audioRef.current) return;
    
    const audio = audioRef.current;
    
    const handlePlay = () => {
      // Record when playback starts to enable initial playback sync period
      playbackStartedAtRef.current = Date.now();
      console.log('AudioSync: Playback started, setting playback start time for initial sync period');
      
      if (mountedRef.current) {
        statusRef.current = 'playing';
        setPlayerState({ status: 'playing' });
      }
    };
    
    // Only attach if not already attached
    if (!audio.hasAttribute('playstart-listener')) {
      audio.addEventListener('play', handlePlay);
      audio.setAttribute('playstart-listener', 'true');
      
      return () => {
        audio.removeEventListener('play', handlePlay);
      };
    }
    
    return undefined;
  }, [isInitialized, setPlayerState]);

  // Cleanup effect
  useEffect(() => {
    return () => {
      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
      // Clean up crossfade audio
      if (crossfadeAudioRef.current) {
        crossfadeAudioRef.current.pause();
        crossfadeAudioRef.current.src = '';
        crossfadeAudioRef.current = null;
      }
    };
  }, []);

  // Function to acquire wake lock to prevent device sleep
  const acquireWakeLock = useCallback(async () => {
    if ('wakeLock' in navigator) {
      try {
        // Release any existing wake lock first
        if (wakeLockRef.current) {
          await wakeLockRef.current.release();
          wakeLockRef.current = null;
        }
        
        // Acquire a new wake lock
        wakeLockRef.current = await navigator.wakeLock.request('screen');
        console.log('AudioSync: Wake Lock acquired to prevent device sleep');
        
        // Add event listener to reacquire wake lock if it's released
        wakeLockRef.current.addEventListener('release', () => {
          console.log('AudioSync: Wake Lock released');
          // Only try to reacquire if we're still playing
          if (statusRef.current === 'playing') {
            acquireWakeLock().catch(error => {
              console.warn('AudioSync: Failed to reacquire Wake Lock:', error);
            });
          }
        });
      } catch (error) {
        console.warn('AudioSync: Failed to acquire Wake Lock:', error);
      }
    } else {
      console.log('AudioSync: Wake Lock API not supported on this device');
    }
  }, []);
  
  // Function to release wake lock
  const releaseWakeLock = useCallback(async () => {
    if (wakeLockRef.current) {
      try {
        await wakeLockRef.current.release();
        wakeLockRef.current = null;
        console.log('AudioSync: Wake Lock released');
      } catch (error) {
        console.warn('AudioSync: Error releasing Wake Lock:', error);
      }
    }
  }, []);
  
  // Wake lock management - optimized to reduce redundant acquisition attempts
  useEffect(() => {
    if (!isInitialized || !audioRef.current) return;
    
    const audio = audioRef.current;
    let wakeLockAcquired = false;
    
    const handlePlay = () => {
      if (!wakeLockAcquired) {
        acquireWakeLock().then(() => {
          wakeLockAcquired = true;
        }).catch(error => {
        console.warn('AudioSync: Play event - Failed to acquire Wake Lock:', error);
      });
      }
    };
    
    const handlePause = () => {
      if (wakeLockAcquired) {
        releaseWakeLock().then(() => {
          wakeLockAcquired = false;
        }).catch(error => {
        console.warn('Audio: Pause event - Failed to release Wake Lock:', error);
      });
      }
    };
    
    // Only attach these listeners once
    if (!audio.hasAttribute('wakelock-listeners')) {
    audio.addEventListener('play', handlePlay);
    audio.addEventListener('pause', handlePause);
      audio.setAttribute('wakelock-listeners', 'true');
    
    // Also manage wake lock based on document visibility
    const handleVisibilityChange = () => {
        if (document.visibilityState === 'visible' && statusRef.current === 'playing' && !wakeLockAcquired) {
          acquireWakeLock().then(() => {
            wakeLockAcquired = true;
          }).catch(console.warn);
      }
    };
    
    document.addEventListener('visibilitychange', handleVisibilityChange);
    
    // Check initial status
      if (statusRef.current === 'playing' && !audio.paused && !wakeLockAcquired) {
        acquireWakeLock().then(() => {
          wakeLockAcquired = true;
        }).catch(console.warn);
    }
    
    return () => {
      audio.removeEventListener('play', handlePlay);
      audio.removeEventListener('pause', handlePause);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (wakeLockAcquired) {
      releaseWakeLock().catch(console.warn);
      }
    }
    };
  }, [isInitialized, acquireWakeLock, releaseWakeLock]);

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
      onLoadedData={() => {
        console.log('Audio: Data loaded');
        
        // Skip position sync if one is already in progress
        if (positionSyncInProgressRef.current) {
          console.log('Audio: Position sync already in progress, skipping sync on data load');
          return;
        }
        
        // This is the perfect time to sync position - audio data is loaded but playback hasn't started
        if (audioRef.current && !hasInitialSyncRef.current && statusRef.current === 'playing') {
          console.log('Audio: First sync - fetching position from server');
          fetchPositionWithLatencyCompensation(audioRef.current).catch(error => {
            console.error('Audio: Failed to fetch position:', error);
          });
        } else if (audioRef.current && hasInitialSyncRef.current && statusRef.current === 'playing') {
          // If we already have sync data, use calculated position
          const calculatedPosition = getCalculatedPosition();
          console.log('Audio: Using calculated position from prior sync:', calculatedPosition);
          setPositionWithBufferingCompensation(audioRef.current, calculatedPosition);
        } else {
          console.log('Audio: Data loaded but not syncing position - current status:', statusRef.current);
        }
      }}
      onCanPlay={() => console.log('Audio: Can play')}
      onPlaying={() => console.log('Audio: Playing')}
      playsInline
      webkit-playsinline="true"
      preload="auto"
    />
  );
}
