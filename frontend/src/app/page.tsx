'use client';

import { usePlayerStore } from '@/lib/store/playerStore';
import { useAuthStore } from '@/lib/store/authStore';
import { useState, useEffect } from 'react';
import { usePlayerProvider } from '@/providers/PlayerProvider';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { PlayerControls } from '@/components/player/PlayerControls';
import { PlayIcon, PauseIcon, ClockIcon } from '@heroicons/react/24/solid';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { useView } from '@/components/layout/AppShell';
import env from '@/utils/env';

export default function Home() {
  const router = useRouter();
  const { currentTrack, queue, isLoading, status } = usePlayerStore();
  const { user, token } = useAuthStore();
  const { sendCommand } = usePlayerProvider();
  const [isPlaying, setIsPlaying] = useState(false);
  const { showHistory, toggleView } = useView();
  const [history, setHistory] = useState<any[]>([]);
  const [connectionError, setConnectionError] = useState(false);

  // Separate user requests from autoplay tracks
  const userRequests = queue.filter(track => !track.isAutoplay);
  const autoplayTracks = queue.filter(track => track.isAutoplay);
  const displayQueue = [...userRequests, ...autoplayTracks];

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
        console.error('Backend connection error:', error);
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
        console.error('Failed to fetch history:', error);
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

  const handlePlayPause = async () => {
    const audio = document.querySelector('audio');
    if (!audio || !token || !currentTrack) return;
    
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
          console.error('Failed to play audio:', err);
        });
      } catch (err) {
        console.error('Failed to sync position:', err);
        // Still try to play even if sync fails
        await audio.play().catch(err => {
          console.error('Failed to play audio:', err);
        });
      }
    } else {
      audio.pause();
    }
  };

  // Show default homepage only when explicitly in stopped state or no track
  if (!currentTrack || status === 'stopped') {
    return (
      <div className="container mx-auto px-4 py-8 flex flex-col items-center justify-center min-h-[calc(100vh-11rem)]">
        <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold text-theme-accent mb-12">MIU</h1>
        <div className="relative w-[16rem] h-[16rem] sm:w-[24rem] sm:h-[24rem] lg:w-[32rem] lg:h-[32rem] mb-8">
          <Image
            src="/images/DEFAULT.jpg"
            alt="休み"
            fill
            className="object-cover rounded-lg shadow-xl ring-1 ring-theme-accent/50"
            priority
          />
        </div>
        <h2 className="text-2xl sm:text-3xl lg:text-4xl font-bold text-theme-accent mb-4">休み</h2>
      </div>
    );
  }

  const items = showHistory ? history : displayQueue;
  const title = showHistory ? "History" : "Queue";

  return (
    <div className="container mx-auto px-4 py-8">
      {/* Now Playing Section */}
      <div className="flex flex-col md:flex-row items-center md:items-start gap-4 md:gap-1 mb-12">
        {/* Album art with play/pause */}
        <div className="relative w-[16rem] h-[16rem] md:w-[24rem] md:h-[24rem] flex-shrink-0 group cursor-pointer"
          onClick={handlePlayPause}>
          <Image
            src={currentTrack.thumbnail}
            alt={currentTrack.title}
            fill
            className="object-cover rounded-lg shadow-xl ring-1 ring-theme-accent/50"
            priority
          />
          {/* Play/Pause Overlay */}
          <div className="absolute inset-0 bg-theme-primary/50 opacity-0 group-hover:opacity-100 transition-opacity rounded-lg flex items-center justify-center">
            {isPlaying ? (
              <PauseIcon className="h-16 w-16 text-theme-accent" />
            ) : (
              <PlayIcon className="h-16 w-16 text-theme-accent" />
            )}
          </div>
        </div>

        {/* Volume control - mobile only */}
        <div className="w-full md:hidden -mt-5">
          <PlayerControls 
            showVolume={true} 
            vertical={false} 
            size="md" 
            className="w-full h-1 bg-theme-accent/20"
          />
        </div>

        {/* Volume control - desktop only */}
        <div className="hidden md:block flex-shrink-0">
          <div className="h-[24rem] flex items-center overflow-hidden">
            <div className="h-full flex items-center">
              <PlayerControls 
                showVolume={true} 
                vertical={true} 
                size="md" 
                className="h-full w-0.5 mx-4 max-h-[24rem]"
              />
            </div>
          </div>
        </div>

        <div className="flex flex-col items-center md:items-start flex-grow mt-3 md:mt-0">
          <h1 className="text-3xl md:text-4xl font-bold text-white mb-4">Now Playing</h1>
          <h2 className="text-xl md:text-2xl font-bold text-white/90 mb-2">{currentTrack.title}</h2>
          <div className="flex items-center space-x-2 text-sm">
            <span className="text-white/40">Requested by</span>
            <span className="text-white/60">{currentTrack.requestedBy.username}</span>
            {currentTrack.requestedBy.avatar && (
              <img
                src={`https://cdn.discordapp.com/avatars/${currentTrack.requestedBy.id}/${currentTrack.requestedBy.avatar}.png`}
                alt={currentTrack.requestedBy.username}
                className="h-4 w-4 rounded-full opacity-60"
              />
            )}
          </div>
        </div>
      </div>

      {/* Queue/History Section */}
      <div className="mt-8">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-x-2">
            <h2 className="text-2xl font-bold text-white">{title}</h2>
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
            {displayQueue.length > 0 ? (
              <div className="space-y-4">
                {displayQueue.map((track, index) => (
                  <div
                    key={`${track.youtubeId}-${track.requestedAt}-${index}`}
                    className="flex items-center space-x-4 bg-white/5 rounded-lg p-4 
                             hover:bg-white/10 transition-all duration-200 
                             border border-white/5 hover:border-white/10
                             relative group"
                  >
                    {/* Track content */}
                    <div className="relative h-16 w-16 flex-shrink-0">
                      <Image
                        src={track.thumbnail.startsWith('http') ? track.thumbnail : `${env.apiUrl}/api/albumart/${track.youtubeId}`}
                        alt={track.title}
                        fill
                        className="object-cover rounded-md"
                        unoptimized={track.thumbnail.startsWith('http')}
                      />
                      {track.isAutoplay && (
                        <div className="absolute bottom-0 right-0 bg-theme-accent/80 text-xs px-1.5 py-0.5 rounded text-white/90">
                          Auto
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="text-white font-medium truncate">{track.title}</h3>
                      <div className="flex items-center space-x-2 text-sm mt-1">
                        <span className="text-white/30">by</span>
                        <span className="text-white/50">{track.requestedBy.username}</span>
                        {track.requestedBy.avatar && (
                          <img
                            src={`https://cdn.discordapp.com/avatars/${track.requestedBy.id}/${track.requestedBy.avatar}.png`}
                            alt={track.requestedBy.username}
                            className="h-4 w-4 rounded-full opacity-50"
                          />
                        )}
                      </div>
                    </div>
                    <div className="text-sm text-white/40">
                      #{index + 1}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-12 text-white/40 bg-white/5 rounded-lg border border-white/5">
                No tracks in queue
              </div>
            )}
          </div>
          <div className={`transition-all duration-300 ${!showHistory ? 'opacity-0 -translate-x-4' : 'opacity-100 translate-x-0'} ${showHistory ? 'relative' : 'absolute inset-0 pointer-events-none'}`}>
            {history.length > 0 ? (
              <div className="space-y-4">
                {history.map((track, index) => (
                  <div
                    key={`${track.youtubeId}-${track.requestedAt}-${index}`}
                    className="flex items-center space-x-4 bg-white/5 rounded-lg p-4 
                             hover:bg-white/10 transition-all duration-200 
                             border border-white/5 hover:border-white/10
                             relative group"
                  >
                    {/* Track content */}
                    <div className="relative h-16 w-16 flex-shrink-0">
                      <Image
                        src={track.thumbnail.startsWith('http') ? track.thumbnail : `${env.apiUrl}/api/albumart/${track.youtubeId}`}
                        alt={track.title}
                        fill
                        className="object-cover rounded-md"
                        unoptimized={track.thumbnail.startsWith('http')}
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="text-white font-medium truncate">{track.title}</h3>
                      <div className="flex items-center space-x-2 text-sm mt-1">
                        <span className="text-white/30">by</span>
                        <span className="text-white/50">{track.requestedBy.username}</span>
                        {track.requestedBy.avatar && (
                          <img
                            src={`https://cdn.discordapp.com/avatars/${track.requestedBy.id}/${track.requestedBy.avatar}.png`}
                            alt={track.requestedBy.username}
                            className="h-4 w-4 rounded-full opacity-50"
                          />
                        )}
                      </div>
                    </div>
                    <div className="text-sm text-white/40">
                      {new Date(track.requestedAt).toLocaleDateString()}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-12 text-white/40 bg-white/5 rounded-lg border border-white/5">
                No history
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
