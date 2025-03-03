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
  const { sendCommand, isConnected } = usePlayerProvider();
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
  const [showEmptyState, setShowEmptyState] = useState(false);
  const emptyStateTimeoutRef = useRef<NodeJS.Timeout | null>(null);

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
        
        // Set a timeout to show the empty state after 5 seconds of no track
        if (emptyStateTimeoutRef.current) {
          clearTimeout(emptyStateTimeoutRef.current);
        }
        
        emptyStateTimeoutRef.current = setTimeout(() => {
          if (!currentTrack) {
            console.log('Page: No track playing for 5 seconds, showing empty state');
            setShowEmptyState(true);
          }
        }, 5000);
      } else {
        // If there was no previous track, show empty state immediately
        setShowEmptyState(true);
      }
    } else {
      // Reset empty state when a track is playing
      setShowEmptyState(false);
      
      // Clear any pending empty state timeout
      if (emptyStateTimeoutRef.current) {
        clearTimeout(emptyStateTimeoutRef.current);
        emptyStateTimeoutRef.current = null;
      }
    }

    // Only trigger transition if track ID changed
    const trackChanged = !previousTrack || previousTrack.youtubeId !== currentTrack?.youtubeId;
    const avatarChanged = previousTrack && currentTrack && 
      previousTrack.requestedBy?.avatar !== currentTrack.requestedBy?.avatar;

    if (currentTrack && (trackChanged || avatarChanged)) {
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
      if (emptyStateTimeoutRef.current) {
        clearTimeout(emptyStateTimeoutRef.current);
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
    
    // Update connection error state based on isConnected from PlayerProvider
    setConnectionError(!isConnected);
    
    if (!isConnected && currentTrack) {
      router.replace('/');
    }
  }, [isConnected, token, currentTrack, router]);

  // Fetch history effect
  useEffect(() => {
    const fetchHistory = async () => {
      if (!token || !showHistory) return;
      
      try {
        const response = await fetch(`${env.apiUrl}/api/music/history`, {
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
        const historyData = Array.isArray(data) ? data : (data.tracks || []);
        
        // Filter out autoplay tracks from history
        const filteredHistory = historyData.filter((track: { isAutoplay?: boolean }) => !track.isAutoplay);
        setHistory(filteredHistory);
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

  const handlePlayPause = async () => {
    try {
      const audio = document.querySelector('audio');
      if (!audio) {
        console.error('No audio element found');
        return;
      }

      if (audio.paused) {
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

  // If no track to display, show empty state
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

  // If no track to display and we've waited long enough, show empty state
  if (showEmptyState) {
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
          <div className="relative w-[16rem] h-[16rem] sm:w-[20rem] sm:h-[20rem] md:w-[24rem] md:h-[24rem] mb-8">
            <Image
              src="/images/DEFAULT.jpg"
              alt="No music playing"
              width={448}
              height={448}
              className="object-cover rounded-lg shadow-xl ring-1 ring-theme-accent/50"
              priority
            />
          </div>
          <h2 className="text-2xl font-bold text-theme-accent mb-4">No music playing</h2>
          <p className="text-theme-accent/70 mb-8 max-w-md">
            Request a song in Discord to start the music player.
          </p>
          
          {connectionError && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-4 text-sm text-red-500 mb-4 max-w-md">
              Connection to server lost. Trying to reconnect...
            </div>
          )}
          
          {/* Queue Section */}
          <div className="w-full max-w-2xl mt-8">
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
      </div>
    );
  }
  
  // Show loading state during transitions
  return (
    <div className="container mx-auto px-4 py-8 flex items-center justify-center min-h-[60vh]">
      <LoadingSpinner size="lg" />
    </div>
  );
}