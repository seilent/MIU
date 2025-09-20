'use client';

import { motion, AnimatePresence } from 'framer-motion';
import { useState } from 'react';
import Image from 'next/image';
import { XMarkIcon } from '@heroicons/react/24/solid';
import env from '@/utils/env';
import { useAuthStore } from '@/lib/store/authStore';

interface AnimatedQueueItemProps {
  track: {
    youtubeId: string;
    title: string;
    thumbnail?: string;
    channelTitle?: string;
    requestedBy: {
      username: string;
      id: string;
      avatar?: string;
    };
    isAutoplay?: boolean;
    autoplaySource?: 'Pool: Playlist' | 'Pool: History' | 'Pool: Popular' | 'Pool: YouTube Mix' | 'Pool: Random';
  };
  position: number;
  showPosition?: boolean;
  isLeaving?: boolean;
  onAnimationComplete?: () => void;
}

export function AnimatedQueueItem({
  track,
  position,
  showPosition = true,
  isLeaving = false,
  onAnimationComplete
}: AnimatedQueueItemProps) {
  const { user } = useAuthStore();
  const isAdmin = user?.roles?.includes('admin') || false;
  const [showBanOptions, setShowBanOptions] = useState(false);

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
          position: position,
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
          position: position,
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
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: isLeaving ? 0 : 1, x: isLeaving ? -100 : 0 }}
      exit={{ opacity: 0, x: 100 }}
      transition={{
        duration: 0.3,
        ease: [0.4, 0, 0.2, 1]
      }}
      onAnimationComplete={onAnimationComplete}
      className="flex items-center space-x-4 bg-white/5 backdrop-blur-sm rounded-lg p-4 mb-2
                 hover:bg-white/10 transition-colors
                 border border-white/10 hover:border-white/20
                 relative group"
    >
      {/* Track thumbnail */}
      <div className="relative h-16 w-16 flex-shrink-0">
        <Image
          src={env.apiUrl
            ? `${env.apiUrl}/api/albumart/${track.youtubeId}?square=1`
            : `/api/albumart/${track.youtubeId}?square=1`}
          alt={track.title}
          fill
          className="object-cover rounded-md filter-thumbnail"
          unoptimized={false}
        />
        {track.isAutoplay && (
          <div className="absolute top-0 right-0 bg-black/40 backdrop-blur-sm text-[9px] w-4 h-4
                          flex items-center justify-center rounded-bl-md rounded-tr-md
                          text-theme-accent font-semibold">
            A
          </div>
        )}
      </div>

      {/* Track info */}
      <div className="flex-1 min-w-0">
        <h3 className="text-white font-medium truncate text-left">
          {track.title}
        </h3>
        {track.channelTitle && (
          <div className="text-xs text-white/50 truncate">
            {track.channelTitle}
          </div>
        )}
        <div className="flex items-center flex-wrap gap-x-2 gap-y-1 text-sm mt-1">
          <div className="flex items-center gap-x-2">
            <span className="text-white/30">by</span>
            <div className="flex items-center">
              <span className="text-white/50">
                {track.requestedBy.username}
              </span>
              {track.requestedBy.avatar && (
                <img
                  key={`${track.requestedBy.id}-${track.requestedBy.avatar}`}
                  src={`https://cdn.discordapp.com/avatars/${track.requestedBy.id}/${track.requestedBy.avatar}.png`}
                  alt={track.requestedBy.username}
                  className="h-4 w-4 rounded-full opacity-50 ml-2"
                />
              )}

              {/* Display autoplay source right after avatar */}
              {track.isAutoplay && track.autoplaySource && (
                <>
                  <span className="text-white/30 mx-2">-</span>
                  <span className="text-white/50 text-xs">
                    {track.autoplaySource.replace('Pool: ', '')}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Admin controls */}
      {isAdmin && (
        <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
          {/* Expandable Ban Button */}
          <div className="relative">
            <motion.div
              className="flex items-center justify-end"
              onHoverStart={() => setShowBanOptions(true)}
              onHoverEnd={() => setShowBanOptions(false)}
            >
              {/* Expanding Ban Channel Option */}
              <AnimatePresence>
                {showBanOptions && (
                  <motion.button
                    initial={{ opacity: 0, x: 20, scale: 0.8 }}
                    animate={{ opacity: 1, x: 0, scale: 1 }}
                    exit={{ opacity: 0, x: 20, scale: 0.8 }}
                    transition={{
                      type: "spring",
                      stiffness: 300,
                      damping: 20,
                      duration: 0.2
                    }}
                    onClick={handleBanChannel}
                    className="p-2 rounded-full bg-purple-500/20 hover:bg-purple-500/30
                               text-purple-400 hover:text-purple-300 transition-colors
                               backdrop-blur-sm border border-purple-500/30 hover:border-purple-500/50
                               shadow-lg shadow-purple-500/10 hover:shadow-purple-500/20
                               mr-2 relative z-0"
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

              <motion.button
                onClick={handleBanTrack}
                className="p-2 rounded-full bg-red-500/20 hover:bg-red-500/30
                           text-red-400 hover:text-red-300 transition-colors
                           backdrop-blur-sm border border-red-500/30 hover:border-red-500/50
                           shadow-lg shadow-red-500/10 hover:shadow-red-500/20
                           relative z-10"
                title="Ban track"
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
              >
                <XMarkIcon className="w-4 h-4" />
              </motion.button>
            </motion.div>

            </div>
        </div>
      )}

      {/* Queue number */}
      {showPosition && (
        <div className="text-sm text-white/40">
          #{position}
        </div>
      )}
    </motion.div>
  );
}