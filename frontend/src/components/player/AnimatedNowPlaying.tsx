import { useState, useEffect } from 'react';
import Image from 'next/image';
import { motion, AnimatePresence } from 'framer-motion';
import { PlayIcon, PauseIcon, XMarkIcon } from '@heroicons/react/24/solid';
import { PlayerControls } from '@/components/player/PlayerControls';
import { useAuthStore } from '@/lib/store/authStore';
import env from '@/utils/env';

interface AnimatedNowPlayingProps {
  track: {
    youtubeId: string;
    title: string;
    thumbnail?: string;
    duration: number;
    channelTitle?: string;
    requestedBy?: {
      id: string;
      username: string;
      avatar?: string;
    };
  };
  isPlaying: boolean;
  onPlayPause: () => void;
}

export function AnimatedNowPlaying({
  track,
  isPlaying,
  onPlayPause
}: AnimatedNowPlayingProps) {
  const { user } = useAuthStore();
  const isAdmin = user?.roles?.includes('admin') || false;
  const [showBanOptions, setShowBanOptions] = useState(false);

  const handleSkip = async () => {
    try {
      const token = localStorage.getItem('token');
      const headers: HeadersInit = {
        'Content-Type': 'application/json'
      };

      // Only add Authorization header if token exists
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const response = await fetch('/backend/api/music/skip', {
        method: 'POST',
        headers
      });

      if (!response.ok) {
        throw new Error('Failed to skip track');
      }
    } catch (error) {
      console.error('Error skipping track:', error);
    }
  };

  const handleBanTrack = async () => {
    try {
      const token = localStorage.getItem('token');
      const headers: HeadersInit = {
        'Content-Type': 'application/json'
      };

      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const response = await fetch('/backend/api/music/ban', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          block_channel: false
        })
      });

      if (!response.ok) {
        throw new Error('Failed to ban track');
      }
    } catch (error) {
      console.error('Error banning track:', error);
    }
  };

  const handleBanChannel = async () => {
    try {
      const token = localStorage.getItem('token');
      const headers: HeadersInit = {
        'Content-Type': 'application/json'
      };

      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const response = await fetch('/backend/api/music/ban', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          block_channel: true
        })
      });

      if (!response.ok) {
        throw new Error('Failed to ban channel');
      }
    } catch (error) {
      console.error('Error banning channel:', error);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      transition={{
        duration: 0.5,
        ease: [0.4, 0, 0.2, 1]
      }}
      className="flex flex-col md:flex-row items-center md:items-start gap-4 md:gap-1 mb-12"
    >
      {/* Album art with play/pause */}
      <motion.div
        className="relative w-[16rem] h-[16rem] md:w-[24rem] md:h-[24rem] flex-shrink-0 group cursor-pointer"
        onClick={onPlayPause}
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.98 }}
      >
        <Image
          src={env.apiUrl
            ? `${env.apiUrl}/api/albumart/${track.youtubeId}`
            : `/api/albumart/${track.youtubeId}`}
          alt={track.title}
          fill
          className="object-cover rounded-lg shadow-xl ring-1 ring-theme-accent/50"
          priority
        />
        {/* Play/Pause Overlay */}
        <div className="absolute inset-0 bg-theme-background/60 opacity-0 group-hover:opacity-100 transition-opacity rounded-lg flex items-center justify-center">
          {isPlaying ? (
            <PauseIcon className="h-16 w-16 text-theme-accent" />
          ) : (
            <PlayIcon className="h-16 w-16 text-theme-accent" />
          )}
        </div>
      </motion.div>

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

      <motion.div
        className="flex flex-col items-center md:items-start flex-grow mt-3 md:mt-0"
        initial={{ opacity: 0, x: -20 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.5, delay: 0.2 }}
      >
        <h1 className="text-3xl md:text-4xl font-bold text-white mb-4">Now Playing</h1>
        <h2 className="text-xl md:text-2xl font-bold text-white/90 mb-2">{track.title}</h2>
        {track.channelTitle && (
          <div className="text-sm text-white/60 mb-2">
            {track.channelTitle}
          </div>
        )}
        <div className="flex items-center space-x-2 text-sm mb-3">
          <span className="text-white/40">Requested by</span>
          <span className="text-white/60">{track.requestedBy?.username}</span>
          {track.requestedBy?.avatar && (
            <img
              key={`${track.requestedBy.id}-${track.requestedBy.avatar}`}
              src={`https://cdn.discordapp.com/avatars/${track.requestedBy.id}/${track.requestedBy.avatar}.png`}
              alt={track.requestedBy.username}
              className="h-4 w-4 rounded-full opacity-60"
            />
          )}
        </div>
        {isAdmin && (
          <div className="flex items-center gap-2 mt-2 relative group">
            <button
              onClick={handleSkip}
              className="p-2 rounded-full bg-theme-accent/20 hover:bg-theme-accent/30
                         text-theme-accent hover:text-theme-accent transition-colors
                         flex items-center justify-center backdrop-blur-sm
                         border border-theme-accent/30 hover:border-theme-accent/50"
              title="Skip track"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                <path d="M4.555 5.168A1 1 0 003 6v8a1 1 0 001.555.832L10 11.202V14a1 1 0 001.555.832l6-4a1 1 0 000-1.664l-6-4A1 1 0 0010 6v2.798l-5.445-3.63z"/>
              </svg>
            </button>

            {/* Expandable Ban Button */}
            <div className="relative">
              <motion.div
                className="flex items-center justify-start"
                onHoverStart={() => setShowBanOptions(true)}
                onHoverEnd={() => setShowBanOptions(false)}
              >
                <motion.button
                  onClick={handleBanTrack}
                  className="p-2 rounded-full bg-red-500/20 hover:bg-red-500/30
                             text-red-400 hover:text-red-300 transition-colors
                             flex items-center justify-center backdrop-blur-sm
                             border border-red-500/30 hover:border-red-500/50
                             shadow-lg shadow-red-500/10 hover:shadow-red-500/20
                             relative z-10"
                  title="Ban track"
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                >
                  <XMarkIcon className="w-4 h-4" />
                </motion.button>

                {/* Expanding Ban Channel Option */}
                <AnimatePresence>
                  {showBanOptions && (
                    <motion.button
                      initial={{ opacity: 0, x: -20, scale: 0.8 }}
                      animate={{ opacity: 1, x: 0, scale: 1 }}
                      exit={{ opacity: 0, x: -20, scale: 0.8 }}
                      transition={{
                        type: "spring",
                        stiffness: 300,
                        damping: 20,
                        duration: 0.2
                      }}
                      onClick={handleBanChannel}
                      className="p-2 rounded-full bg-purple-500/20 hover:bg-purple-500/30
                                 text-purple-400 hover:text-purple-300 transition-colors
                                 flex items-center justify-center backdrop-blur-sm
                                 border border-purple-500/30 hover:border-purple-500/50
                                 shadow-lg shadow-purple-500/10 hover:shadow-purple-500/20
                                 ml-2 relative z-0"
                      title="Ban channel"
                      whileHover={{ scale: 1.05 }}
                      whileTap={{ scale: 0.95 }}
                    >
                      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M3 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clipRule="evenodd"/>
                        <path d="M13.477 14.89A6 6 0 715.11 6.524l8.367 8.368zm1.414-1.414L6.524 5.11a6 6 0 018.367 8.367z"/>
                      </svg>
                    </motion.button>
                  )}
                </AnimatePresence>
              </motion.div>

              </div>
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}