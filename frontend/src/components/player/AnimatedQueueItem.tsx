'use client';

import { motion } from 'framer-motion';
import Image from 'next/image';
import env from '@/utils/env';

interface AnimatedQueueItemProps {
  track: {
    youtubeId: string;
    title: string;
    thumbnail: string;
    requestedBy: {
      username: string;
      id: string;
      avatar?: string;
    };
    isAutoplay?: boolean;
  };
  index: number;
  isLeaving: boolean;
  onAnimationComplete?: () => void;
}

export function AnimatedQueueItem({ 
  track, 
  index,
  isLeaving,
  onAnimationComplete
}: AnimatedQueueItemProps) {
  // Simplified animation variants
  const variants = {
    enter: {
      y: 20,
      opacity: 0
    },
    center: {
      y: 0,
      opacity: 1,
      transition: {
        duration: 0.3,
        ease: "easeOut"
      }
    },
    exit: {
      x: -100,
      opacity: 0,
      transition: {
        duration: 0.2,
        ease: "easeIn"
      }
    }
  };

  return (
    <motion.div
      variants={variants}
      initial="enter"
      animate="center"
      exit="exit"
      onAnimationComplete={onAnimationComplete}
      className="flex items-center space-x-4 bg-white/5 rounded-lg p-4 mb-2
                 hover:bg-white/10 transition-colors 
                 border border-white/5 hover:border-white/10
                 relative group"
    >
      {/* Track thumbnail */}
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

      {/* Track info */}
      <div className="flex-1 min-w-0">
        <h3 className="text-white font-medium truncate">
          {track.title}
        </h3>
        <div className="flex items-center space-x-2 text-sm mt-1">
          <span className="text-white/30">by</span>
          <span className="text-white/50">
            {track.requestedBy.username}
          </span>
          {track.requestedBy.avatar && (
            <img
              src={`https://cdn.discordapp.com/avatars/${track.requestedBy.id}/${track.requestedBy.avatar}.png`}
              alt={track.requestedBy.username}
              className="h-4 w-4 rounded-full opacity-50"
            />
          )}
        </div>
      </div>

      {/* Queue number */}
      <div className="text-sm text-white/40">
        #{index + 1}
      </div>
    </motion.div>
  );
} 