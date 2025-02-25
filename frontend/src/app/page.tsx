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

export default function Home() {
  const router = useRouter();
  const { currentTrack, queue, isLoading, status } = usePlayerStore();
  const { user, token } = useAuthStore();
  const { sendCommand } = usePlayerProvider();
  const [isPlaying, setIsPlaying] = useState(false);
  const { showHistory, toggleView } = useView();
  const [history, setHistory] = useState<any[]>([]);
  const [connectionError, setConnectionError] = useState(false);
  const [previousTrack, setPreviousTrack] = useState<any>(null);
  const [animatingQueue, setAnimatingQueue] = useState(false);
  const [previousQueue, setPreviousQueue] = useState<any[]>([]);
  const [transitioningTrackId, setTransitioningTrackId] = useState<string | null>(null);
  const queueAnimationCompleteCount = useRef(0);
  const [showHomeTimeout, setShowHomeTimeout] = useState<NodeJS.Timeout | null>(null);
  const [shouldShowPlayer, setShouldShowPlayer] = useState(!!currentTrack);

  // Separate user requests from autoplay tracks
  const userRequests = queue.filter(track => !track.isAutoplay);
  const autoplayTracks = queue.filter(track => track.isAutoplay);
  const displayQueue = [...userRequests, ...autoplayTracks];

  // Track transitions with a delay to prevent UI flicker
  useEffect(() => {
    if (currentTrack) {
      if (showHomeTimeout) {
        clearTimeout(showHomeTimeout);
        setShowHomeTimeout(null);
      }
      setShouldShowPlayer(true);
      
      // If we have a current track and it's different from the previous one
      if (previousTrack && previousTrack.youtubeId !== currentTrack.youtubeId) {
        // Store the transitioning track ID
        setTransitioningTrackId(previousTrack.youtubeId);
        
        // Store the previous queue for animation, but only include the transitioning track
        // and the current queue to ensure proper indexing
        setPreviousQueue([previousTrack, ...queue]);
        
        // Start queue animation
        setAnimatingQueue(true);
        
        // Reset animation completion counter
        queueAnimationCompleteCount.current = 0;
      }
      
      // Update previous track
      setPreviousTrack(currentTrack);
    } else if (previousTrack && !showHomeTimeout) {
      const timeout = setTimeout(() => {
        setShouldShowPlayer(false);
        setShowHomeTimeout(null);
      }, 5000);
      
      setShowHomeTimeout(timeout);
    }
    
    return () => {
      if (showHomeTimeout) {
        clearTimeout(showHomeTimeout);
      }
    };
  }, [currentTrack, queue, previousTrack, showHomeTimeout]);

  // Handle queue animation completion
  const handleQueueItemAnimationComplete = () => {
    queueAnimationCompleteCount.current += 1;
    
    // When all items have completed their animation
    if (queueAnimationCompleteCount.current >= previousQueue.length) {
      // Small delay before resetting animation state to ensure smooth transition
      setTimeout(() => {
        setAnimatingQueue(false);
        setTransitioningTrackId(null);
        setPreviousQueue([]);
      }, 100);
    }
  };

  // Auth check effect
  useEffect(() => {
    if (!isLoading && !token) {
      router.replace('/login');
    }
  }, [token, isLoading, router]);

  // Backend connection check effect
  useEffect(() => {
    const checkBackendConnection = async () => {
      if (!token) return;
      
      try {
        const response = await fetch(`${env.apiUrl}/api/music/state`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'X-Internal-Request': 'true'
          }
        });

        if (!response.ok) {
          throw new Error('Backend connection failed');
        }

        // Reset connection error if successful
        setConnectionError(false);
      } catch (error) {
        // Backend connection error
        setConnectionError(true);
        
        // If we're on the player page and there's a connection error, redirect to main
        if (currentTrack) {
          router.replace('/');
        }
      }
    };

    // Check connection immediately and then every 10 seconds
    checkBackendConnection();
    const interval = setInterval(checkBackendConnection, 10000);

    return () => clearInterval(interval);
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

  // Use previousTrack as a fallback during track transitions
  const displayTrack = currentTrack || previousTrack;

  // Function to handle play/pause
  const handlePlayPause = async () => {
    const audio = document.querySelector('audio');
    if (!audio || !token || !displayTrack) return;
    
    if (audio.paused) {
      try {
        // Get current position from server before resuming
        const response = await fetch(`${env.apiUrl}/api/music/position`, {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        });
        
        if (!response.ok) {
          throw new Error('Failed to get playback position');
        }

        const data = await response.json();
        audio.currentTime = data.position;
        
        // Now play from the synced position
        await audio.play().catch(err => {
          // Failed to play audio
        });
      } catch (err) {
        // Failed to sync position
        // Still try to play even if sync fails
        await audio.play().catch(err => {
          // Failed to play audio
        });
      }
    } else {
      audio.pause();
    }
  };

  // Show loading state while checking auth or fetching initial state
  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[calc(100vh-11rem)]">
        <LoadingSpinner size="lg" className="text-theme-accent" />
      </div>
    );
  }

  // Don't render anything if not authenticated
  if (!token) {
    return null;
  }

  // Show player if we have a track or are in the delay period
  if (displayTrack && (shouldShowPlayer || currentTrack)) {
    return (
      <div className="container mx-auto px-4 py-8">
        {/* Now Playing Section */}
        <AnimatePresence mode="wait">
          <AnimatedNowPlaying 
            key={displayTrack.youtubeId} 
            track={displayTrack} 
            isPlaying={isPlaying} 
            onPlayPause={handlePlayPause}
          />
        </AnimatePresence>

        {/* Queue/History Section */}
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
          <div className="relative">
            <div className={`transition-all duration-300 ${showHistory ? 'opacity-0 translate-x-4' : 'opacity-100 translate-x-0'} ${!showHistory ? 'relative' : 'absolute inset-0 pointer-events-none'}`}>
              <AnimatePresence mode="sync">
                {animatingQueue ? (
                  // During track transition, show previous queue with animations
                  previousQueue.map((track, index) => {
                    const isTransitioning = track.youtubeId === transitioningTrackId;
                    // Adjust index to reflect new position in queue
                    const adjustedIndex = isTransitioning ? index : index - 1;
                    
                    return (
                      <AnimatedQueueItem
                        key={`${track.youtubeId}-${track.requestedAt}-${index}`}
                        track={track}
                        index={adjustedIndex}
                        isRemoving={isTransitioning}
                        onAnimationComplete={handleQueueItemAnimationComplete}
                      />
                    );
                  })
                ) : displayQueue.length > 0 ? (
                  // Normal queue display
                  displayQueue.map((track, index) => (
                    <AnimatedQueueItem
                      key={`${track.youtubeId}-${track.requestedAt}-${index}`}
                      track={track}
                      index={index}
                      isRemoving={false}
                    />
                  ))
                ) : (
                  <motion.div 
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ 
                      duration: 0.5, 
                      delay: 0.2,
                      type: "spring",
                      stiffness: 100,
                      damping: 20
                    }}
                    className="text-center py-12 text-white/40 bg-white/5 rounded-lg border border-white/5"
                  >
                    No tracks in queue
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            <div className={`transition-all duration-300 ${!showHistory ? 'opacity-0 -translate-x-4' : 'opacity-100 translate-x-0'} ${showHistory ? 'relative' : 'absolute inset-0 pointer-events-none'}`}>
              {history.length > 0 ? (
                <div className="space-y-4">
                  {history.map((track, index) => (
                    <motion.div
                      key={`${track.youtubeId}-${track.requestedAt}-${index}`}
                      layout="position"
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ 
                        type: "spring", 
                        stiffness: 300, 
                        damping: 25,
                        delay: index * 0.05,
                        layout: { duration: 0.3 }
                      }}
                      className="flex items-center space-x-4 bg-white/5 rounded-lg p-4 
                               hover:bg-white/10 transition-all duration-200 
                               border border-white/5 hover:border-white/10
                               relative group"
                    >
                      {/* Track thumbnail with loading animation */}
                      <div className="relative h-16 w-16 flex-shrink-0">
                        <motion.div
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          transition={{ duration: 0.3 }}
                        >
                          <Image
                            src={track.thumbnail.startsWith('http') ? track.thumbnail : `${env.apiUrl}/api/albumart/${track.youtubeId}`}
                            alt={track.title}
                            fill
                            className="object-cover rounded-md"
                            unoptimized={track.thumbnail.startsWith('http')}
                          />
                        </motion.div>
                        {track.isAutoplay && (
                          <motion.div
                            initial={{ scale: 0 }}
                            animate={{ scale: 1 }}
                            transition={{ type: "spring", stiffness: 400, damping: 25 }}
                            className="absolute bottom-0 right-0 bg-theme-accent/80 text-xs px-1.5 py-0.5 rounded text-white/90"
                          >
                            Auto
                          </motion.div>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <motion.h3 
                          layout
                          className="text-white font-medium truncate"
                        >
                          {track.title}
                        </motion.h3>
                        <div className="flex items-center space-x-2 text-sm mt-1">
                          <span className="text-white/30">by</span>
                          <motion.span 
                            layout
                            className="text-white/50"
                          >
                            {track.requestedBy.username}
                          </motion.span>
                          {track.requestedBy.avatar && (
                            <motion.img
                              initial={{ scale: 0.8, opacity: 0 }}
                              animate={{ scale: 1, opacity: 0.5 }}
                              src={`https://cdn.discordapp.com/avatars/${track.requestedBy.id}/${track.requestedBy.avatar}.png`}
                              alt={track.requestedBy.username}
                              className="h-4 w-4 rounded-full"
                            />
                          )}
                        </div>
                      </div>
                      <motion.div 
                        layout
                        className="text-sm text-white/40"
                        whileHover={{ scale: 1.05, opacity: 1 }}
                      >
                        {new Date(track.requestedAt).toLocaleDateString([], { 
                          hour: '2-digit', 
                          minute: '2-digit' 
                        })}
                      </motion.div>
                    </motion.div>
                  ))}
                </div>
              ) : (
                <motion.div 
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.5 }}
                  className="text-center py-12 text-white/40 bg-white/5 rounded-lg border border-white/5"
                >
                  No history
                </motion.div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Show default homepage only when explicitly in stopped state or no track
  if (!displayTrack || status === 'stopped') {
    return (
      <div className="container mx-auto px-4 py-8 flex flex-col items-center justify-center min-h-[calc(100vh-11rem)]">
        <motion.h1 
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="text-4xl sm:text-5xl lg:text-6xl font-bold text-theme-accent mb-12"
        >
          MIU
        </motion.h1>
        <motion.div 
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.5, delay: 0.2 }}
          className="relative w-[16rem] h-[16rem] sm:w-[24rem] sm:h-[24rem] lg:w-[32rem] lg:h-[32rem] mb-8"
        >
          <Image
            src="/images/DEFAULT.jpg"
            alt="休み"
            fill
            className="object-cover rounded-lg shadow-xl ring-1 ring-theme-accent/50"
            priority
          />
        </motion.div>
        <motion.h2 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.4 }}
          className="text-2xl sm:text-3xl lg:text-4xl font-bold text-theme-accent mb-4"
        >
          休み
        </motion.h2>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8">
      {/* Now Playing Section */}
      <AnimatePresence mode="wait">
        <AnimatedNowPlaying 
          key={displayTrack.youtubeId} 
          track={displayTrack} 
          isPlaying={isPlaying} 
          onPlayPause={handlePlayPause}
        />
      </AnimatePresence>

      {/* Queue/History Section */}
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
        <div className="relative">
          <div className={`transition-all duration-300 ${showHistory ? 'opacity-0 translate-x-4' : 'opacity-100 translate-x-0'} ${!showHistory ? 'relative' : 'absolute inset-0 pointer-events-none'}`}>
            <AnimatePresence mode="sync">
              {animatingQueue ? (
                // During track transition, show previous queue with animations
                previousQueue.map((track, index) => {
                  const isTransitioning = track.youtubeId === transitioningTrackId;
                  // Adjust index to reflect new position in queue
                  const adjustedIndex = isTransitioning ? index : index - 1;
                  
                  return (
                    <AnimatedQueueItem
                      key={`${track.youtubeId}-${track.requestedAt}-${index}`}
                      track={track}
                      index={adjustedIndex}
                      isRemoving={isTransitioning}
                      onAnimationComplete={handleQueueItemAnimationComplete}
                    />
                  );
                })
              ) : displayQueue.length > 0 ? (
                // Normal queue display
                displayQueue.map((track, index) => (
                  <AnimatedQueueItem
                    key={`${track.youtubeId}-${track.requestedAt}-${index}`}
                    track={track}
                    index={index}
                    isRemoving={false}
                  />
                ))
              ) : (
                <motion.div 
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ 
                    duration: 0.5, 
                    delay: 0.2,
                    type: "spring",
                    stiffness: 100,
                    damping: 20
                  }}
                  className="text-center py-12 text-white/40 bg-white/5 rounded-lg border border-white/5"
                >
                  No tracks in queue
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          <div className={`transition-all duration-300 ${!showHistory ? 'opacity-0 -translate-x-4' : 'opacity-100 translate-x-0'} ${showHistory ? 'relative' : 'absolute inset-0 pointer-events-none'}`}>
            {history.length > 0 ? (
              <div className="space-y-4">
                {history.map((track, index) => (
                  <motion.div
                    key={`${track.youtubeId}-${track.requestedAt}-${index}`}
                    layout="position"
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ 
                      type: "spring", 
                      stiffness: 300, 
                      damping: 25,
                      delay: index * 0.05,
                      layout: { duration: 0.3 }
                    }}
                    className="flex items-center space-x-4 bg-white/5 rounded-lg p-4 
                             hover:bg-white/10 transition-all duration-200 
                             border border-white/5 hover:border-white/10
                             relative group"
                  >
                    {/* Track thumbnail with loading animation */}
                    <div className="relative h-16 w-16 flex-shrink-0">
                      <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ duration: 0.3 }}
                      >
                        <Image
                          src={track.thumbnail.startsWith('http') ? track.thumbnail : `${env.apiUrl}/api/albumart/${track.youtubeId}`}
                          alt={track.title}
                          fill
                          className="object-cover rounded-md"
                          unoptimized={track.thumbnail.startsWith('http')}
                        />
                      </motion.div>
                      {track.isAutoplay && (
                        <motion.div
                          initial={{ scale: 0 }}
                          animate={{ scale: 1 }}
                          transition={{ type: "spring", stiffness: 400, damping: 25 }}
                          className="absolute bottom-0 right-0 bg-theme-accent/80 text-xs px-1.5 py-0.5 rounded text-white/90"
                        >
                          Auto
                        </motion.div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <motion.h3 
                        layout
                        className="text-white font-medium truncate"
                      >
                        {track.title}
                      </motion.h3>
                      <div className="flex items-center space-x-2 text-sm mt-1">
                        <span className="text-white/30">by</span>
                        <motion.span 
                          layout
                          className="text-white/50"
                        >
                          {track.requestedBy.username}
                        </motion.span>
                        {track.requestedBy.avatar && (
                          <motion.img
                            initial={{ scale: 0.8, opacity: 0 }}
                            animate={{ scale: 1, opacity: 0.5 }}
                            src={`https://cdn.discordapp.com/avatars/${track.requestedBy.id}/${track.requestedBy.avatar}.png`}
                            alt={track.requestedBy.username}
                            className="h-4 w-4 rounded-full"
                          />
                        )}
                      </div>
                    </div>
                    <motion.div 
                      layout
                      className="text-sm text-white/40"
                      whileHover={{ scale: 1.05, opacity: 1 }}
                    >
                      {new Date(track.requestedAt).toLocaleDateString([], { 
                        hour: '2-digit', 
                        minute: '2-digit' 
                      })}
                    </motion.div>
                  </motion.div>
                ))}
              </div>
            ) : (
              <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.5 }}
                className="text-center py-12 text-white/40 bg-white/5 rounded-lg border border-white/5"
              >
                No history
              </motion.div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
