'use client';

import { usePlayerStore } from '@/lib/store/playerStore';
import { useAuthStore } from '@/lib/store/authStore';
import { useState, useEffect, useRef } from 'react';
import { usePlayerProvider } from '@/providers/PlayerProvider';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PlayerControls } from '@/components/player/PlayerControls';
import { PlayIcon, PauseIcon, ClockIcon } from '@heroicons/react/24/solid';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { useView } from '@/components/layout/AppShell';
import env from '@/utils/env';
import { AnimatedQueueItem } from '@/components/player/AnimatedQueueItem';
import { AnimatedNowPlaying } from '@/components/player/AnimatedNowPlaying';
import { motion, AnimatePresence } from 'framer-motion';
import SSEManager from '@/lib/sse/SSEManager';
import HLSManager from '@/lib/hls/HLSManager';

export default function Home() {
  const router = useRouter();
  const { 
    status,
    currentTrack,
    queue,
    setQueue,
    setCurrentTrack,
    setStatus,
    setPosition,
    setPlayerState
  } = usePlayerStore();
  const { user, token } = useAuthStore();
  const { sendCommand } = usePlayerProvider();
  const [isPlaying, setIsPlaying] = useState(false);
  const { showHistory, toggleView } = useView();
  const [history, setHistory] = useState<any[]>([]);
  const [connectionError, setConnectionError] = useState(false);
  const [previousTrack, setPreviousTrack] = useState<any>(null);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const transitionTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [showHomeTimeout, setShowHomeTimeout] = useState<NodeJS.Timeout | null>(null);
  const [shouldShowPlayer, setShouldShowPlayer] = useState(!!currentTrack);
  const animationTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [loading, setLoading] = useState(false);
  const sseSubscriptionRef = useRef(false);

  // Add queue state validation
  const validQueue = queue?.filter(track => 
    track && 
    track.youtubeId && 
    track.title && 
    (!track.requestedBy || (
      track.requestedBy.id && 
      track.requestedBy.username
    ))
  ) ?? [];

  // Separate user requests from autoplay tracks with validation
  const userRequests = validQueue.filter(track => !track.isAutoplay);
  const autoplayTracks = validQueue.filter(track => track.isAutoplay);

  // Create display queue with proper position tracking
  const displayQueue = [...userRequests, ...autoplayTracks].map((track, index) => ({
    ...track,
    queuePosition: index + 1,
    key: `${track.youtubeId}-${track.requestedAt}-${index}` // Unique key for React
  }));

  // Debug logging for queue updates
  useEffect(() => {
    console.log('Queue state updated:', {
      rawQueue: queue,
      userRequests: userRequests.length,
      autoplayTracks: autoplayTracks.length,
      displayQueue: displayQueue.length
    });
  }, [queue]);

  // Track transitions effect
  useEffect(() => {
    if (!currentTrack) {
      if (previousTrack) {
        console.log('Page: Track ended, showing previous track', {
          previous: {
            id: previousTrack.youtubeId,
            title: previousTrack.title,
            requestedBy: previousTrack.requestedBy ? {
              username: previousTrack.requestedBy.username,
              avatar: previousTrack.requestedBy.avatar,
              id: previousTrack.requestedBy.id
            } : null
          }
        });
        
        if (transitionTimeoutRef.current) {
          clearTimeout(transitionTimeoutRef.current);
        }
        
        transitionTimeoutRef.current = setTimeout(() => {
          setPreviousTrack(null);
          setIsTransitioning(false);
        }, 300);
      }
      return;
    }

    // Only trigger transition if track ID changed
    const trackChanged = !previousTrack || previousTrack.youtubeId !== currentTrack.youtubeId;
    const avatarChanged = previousTrack && 
      previousTrack.requestedBy?.avatar !== currentTrack.requestedBy?.avatar;

    if (trackChanged || avatarChanged) {
      // Deep clone the current track to prevent reference issues
      const currentTrackData = {
        ...currentTrack,
        requestedBy: currentTrack.requestedBy ? {
          ...currentTrack.requestedBy
        } : null
      };

      console.log('Page: Track transition started', {
        current: {
          id: currentTrack.youtubeId,
          title: currentTrack.title,
          requestedBy: currentTrack.requestedBy ? {
            username: currentTrack.requestedBy.username,
            avatar: currentTrack.requestedBy.avatar,
            id: currentTrack.requestedBy.id
          } : null
        },
        previous: previousTrack ? {
          id: previousTrack.youtubeId,
          title: previousTrack.title,
          requestedBy: previousTrack.requestedBy ? {
            username: previousTrack.requestedBy.username,
            avatar: previousTrack.requestedBy.avatar,
            id: previousTrack.requestedBy.id
          } : null
        } : null,
        isAvatarPreserved: previousTrack ? 
          previousTrack.requestedBy?.avatar === currentTrack.requestedBy?.avatar : true,
        isTrackChange: trackChanged,
        isAvatarChange: avatarChanged
      });

      setIsTransitioning(true);
      setPreviousTrack(currentTrackData);

      if (transitionTimeoutRef.current) {
        clearTimeout(transitionTimeoutRef.current);
      }

      transitionTimeoutRef.current = setTimeout(() => {
        console.log('Page: Transition complete', {
          track: {
            id: currentTrackData.youtubeId,
            requestedBy: currentTrackData.requestedBy ? {
              username: currentTrackData.requestedBy.username,
              avatar: currentTrackData.requestedBy.avatar,
              id: currentTrackData.requestedBy.id
            } : null
          },
          avatarPreserved: currentTrackData.requestedBy?.avatar === currentTrack.requestedBy?.avatar
        });
        setIsTransitioning(false);
      }, 300);
    }

    return () => {
      if (transitionTimeoutRef.current) {
        clearTimeout(transitionTimeoutRef.current);
      }
    };
  }, [currentTrack?.youtubeId, currentTrack?.requestedBy?.avatar]); // Only trigger on track ID or avatar changes

  // Use currentTrack if available, otherwise use previousTrack during transition
  const displayTrack = currentTrack || (isTransitioning ? previousTrack : null);

  // Auth check effect
  useEffect(() => {
    if (!token) {
      router.replace('/login');
    }
  }, [token, router]);

  // Backend connection check effect
  useEffect(() => {
    if (!token) return;
    
    const sseManager = SSEManager.getInstance();
    
    const handleConnectionError = () => {
      setConnectionError(true);
      if (currentTrack) {
        router.replace('/');
      }
    };

    const handleHeartbeat = () => {
      setConnectionError(false);
    };

    sseManager.addEventListener('heartbeat', handleHeartbeat);
    sseManager.addErrorListener(handleConnectionError);

    return () => {
      sseManager.removeEventListener('heartbeat', handleHeartbeat);
      sseManager.removeErrorListener(handleConnectionError);
    };
  }, [token, currentTrack, router]);

  // Fetch history effect
  useEffect(() => {
    const fetchHistory = async () => {
      if (!token || !showHistory) return;
      
      try {
        const response = await fetch(`${env.apiUrl}/api/history`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'X-Internal-Request': 'true'
          }
        });

        if (!response.ok) {
          throw new Error('Failed to fetch history');
        }

        const data = await response.json();
        // Ensure we're getting the tracks array from the response
        setHistory(Array.isArray(data) ? data : (data.tracks || []));
      } catch (error) {
        // Failed to fetch history
      }
    };

    fetchHistory();
  }, [token, showHistory]);

  // Audio play/pause effect
  useEffect(() => {
    // Only run this effect if we're authenticated and have a current track
    if (!token || !currentTrack) return;
    
    const audio = document.querySelector('audio');
    if (!audio) return;

    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);

    audio.addEventListener('play', handlePlay);
    audio.addEventListener('pause', handlePause);

    // Initialize state
    setIsPlaying(!audio.paused);

    return () => {
      audio.removeEventListener('play', handlePlay);
      audio.removeEventListener('pause', handlePause);
    };
  }, [currentTrack, token]); // Re-run when track or auth changes

  // Track change effect
  useEffect(() => {
    if (currentTrack) {
      const trackData = {
        id: currentTrack.youtubeId,
        title: currentTrack.title,
        requestedBy: currentTrack.requestedBy ? {
          username: currentTrack.requestedBy.username,
          avatar: currentTrack.requestedBy.avatar,
          id: currentTrack.requestedBy.id,
          hasAvatar: !!currentTrack.requestedBy.avatar
        } : null
      };
      
      console.log('Page: Track changed', trackData);
    }
  }, [currentTrack?.youtubeId, currentTrack?.requestedBy?.avatar]); // Only log on actual changes

  // Replace the SSE effect with improved version
  useEffect(() => {
    if (!token) return;

    const sseManager = SSEManager.getInstance();
    let isSubscribed = false;

    const setupSSE = async () => {
      if (isSubscribed) return;
      isSubscribed = true;

      const stateListener = (data: any) => {
        console.log('Page: State update received', {
          status: data.status,
          track: data.currentTrack ? {
            id: data.currentTrack.youtubeId,
            title: data.currentTrack.title,
            requestedBy: {
              username: data.currentTrack.requestedBy?.username,
              avatar: data.currentTrack.requestedBy?.avatar,
              id: data.currentTrack.requestedBy?.id,
              hasAvatar: !!data.currentTrack.requestedBy?.avatar
            }
          } : null
        });
        if (setStatus && setPosition) {
          setStatus(data.status);
          setPosition(data.position);
        }
      };

      const statusListener = (data: any) => {
        if (setStatus) {
          setStatus(data.status);
          if (data.status === 'stopped' && setCurrentTrack) {
            setCurrentTrack(undefined);
          }
        }
      };

      const trackListener = (data: any) => {
        console.log('Page: Track update received', {
          id: data.youtubeId,
          title: data.title,
          requestedBy: data.requestedBy ? {
            username: data.requestedBy.username,
            avatar: data.requestedBy.avatar,
            id: data.requestedBy.id,
            hasAvatar: !!data.requestedBy.avatar
          } : null
        });
        
        if (setCurrentTrack) {
          if (!data || !data.youtubeId) {
            setCurrentTrack(undefined);
          } else if (data.youtubeId !== currentTrack?.youtubeId || 
                     data.requestedBy?.avatar !== currentTrack?.requestedBy?.avatar) {
            // Deep clone to prevent reference issues and ensure requestedBy data is complete
            setCurrentTrack({
              ...data,
              requestedBy: data.requestedBy ? {
                id: data.requestedBy.id,
                username: data.requestedBy.username,
                avatar: data.requestedBy.avatar || undefined,
                hasAvatar: !!data.requestedBy.avatar
              } : null,
              requestedAt: data.requestedAt || new Date().toISOString()
            });
          }
        }
      };

      const queueListener = (data: any) => {
        if (!data) {
          console.log('Queue update received empty data');
          return;
        }
        
        console.log('Queue update received:', data);
        
        if (setQueue) {
          const processedQueue = data.map((track: any) => ({
            ...track,
            requestedBy: track.requestedBy ? {
              id: track.requestedBy.id,
              username: track.requestedBy.username,
              avatar: track.requestedBy.avatar || undefined,
              hasAvatar: !!track.requestedBy.avatar
            } : null,
            requestedAt: track.requestedAt || new Date().toISOString(),
            isAutoplay: !!track.isAutoplay // Ensure boolean
          }));
          
          // Only update if queue has changed
          setQueue(prevQueue => {
            const hasChanged = JSON.stringify(prevQueue) !== JSON.stringify(processedQueue);
            if (hasChanged) {
              console.log('Queue changed, updating state');
            }
            return hasChanged ? processedQueue : prevQueue;
          });
        }
      };

      // Add event listeners
      sseManager.addEventListener('state', stateListener);
      sseManager.addEventListener('status', statusListener);
      sseManager.addEventListener('track', trackListener);
      sseManager.addEventListener('queue', queueListener);

      // Connect with token and handle errors
      try {
        await sseManager.connect(token);
        console.log('SSE connection established');
      } catch (error) {
        console.error('Failed to connect SSE:', error);
        setConnectionError(true);
      }

      return () => {
        isSubscribed = false;
        sseManager.removeEventListener('state', stateListener);
        sseManager.removeEventListener('status', statusListener);
        sseManager.removeEventListener('track', trackListener);
        sseManager.removeEventListener('queue', queueListener);
      };
    };

    setupSSE();

    return () => {
      isSubscribed = false;
    };
  }, [token, setQueue, setStatus, setPosition, setCurrentTrack, currentTrack]);

  const handlePlayPause = async () => {
    try {
      const audio = document.querySelector('audio');
      if (!audio) {
        console.error('No audio element found');
        return;
      }

      if (audio.paused) {
        // Get fresh position before playing
        const response = await fetch(`${env.apiUrl}/api/music/position`);
        const data = await response.json();
        
        console.log('Player: Fresh position before play:', {
          position: data.position,
          serverTime: new Date(data.timestamp).toISOString()
        });
        
        // Set position and play
        audio.currentTime = data.position;
        await audio.play();
      } else {
        audio.pause();
      }
    } catch (error) {
      console.error('Play/pause error:', error);
    }
  };

  // Remove loading check for the entire page
  if (!token) {
    return null;
  }

  // Show player if we have a track to display
  if (displayTrack) {
    return (
      <div className="container mx-auto px-4 py-8">
        {/* Now Playing Section */}
        <AnimatePresence mode="wait">
          <motion.div
            key={displayTrack.youtubeId}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.3 }}
          >
            <AnimatedNowPlaying 
              track={displayTrack}
              isPlaying={isPlaying}
              onPlayPause={handlePlayPause}
            />
          </motion.div>
        </AnimatePresence>

        {/* Queue Section */}
        <div className="mt-8">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-x-2">
              <h2 className="text-2xl font-bold text-white">{showHistory ? "History" : "Queue"}</h2>
              <button
                onClick={toggleView}
                className="p-2 rounded-full hover:bg-theme-accent/10 transition-colors flex-shrink-0"
                title={showHistory ? "Show Queue" : "Show History"}
              >
                <ClockIcon className="h-5 w-5 text-theme-accent transform rotate-135" />
              </button>
            </div>
          </div>

          <div className="relative overflow-hidden">
            <div className="relative w-full">
              {/* History View */}
              <motion.div
                initial={false}
                animate={{
                  opacity: showHistory ? 1 : 0,
                  x: showHistory ? 0 : 20,
                  position: 'relative',
                  zIndex: showHistory ? 1 : 0,
                  display: showHistory ? 'block' : 'none'
                }}
                transition={{ duration: 0.15 }}
              >
                <div className="space-y-4">
                  {history.map((track, index) => (
                    <AnimatedQueueItem
                      key={`${track.youtubeId}-${track.requestedAt}-${index}`}
                      track={track}
                      position={index + 1}
                      showPosition={false}
                    />
                  ))}
                  {history.length === 0 && (
                    <div className="text-center text-gray-400 py-8">
                      No history available
                    </div>
                  )}
                </div>
              </motion.div>

              {/* Queue View */}
              <motion.div
                initial={false}
                animate={{
                  opacity: showHistory ? 0 : 1,
                  x: showHistory ? -20 : 0,
                  position: 'relative',
                  zIndex: showHistory ? 0 : 1,
                  display: showHistory ? 'none' : 'block'
                }}
                transition={{ duration: 0.15 }}
              >
                <div className="space-y-4">
                  {displayQueue.map((track) => (
                    <AnimatedQueueItem
                      key={track.key}
                      track={track}
                      position={track.queuePosition}
                      showPosition={true}
                    />
                  ))}
                  {displayQueue.length === 0 && (
                    <div className="text-center text-gray-400 py-8">
                      Queue is empty
                    </div>
                  )}
                </div>
              </motion.div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // If no track to display, return null
  return null;
}