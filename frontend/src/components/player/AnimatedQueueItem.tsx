'use client';

import { motion } from 'framer-motion';
import Image from 'next/image';
import env from '@/utils/env';

interface AnimatedQueueItemProps {
  track: {
    youtubeId: string;
    title: string;
    thumbnail?: string;
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
  // Simplified animation variants
  const variants = {
    enter: {
      y: 20,
      opacity: 0,
      scale: 0.95
    },
    center: {
      y: 0,
      opacity: 1,
      scale: 1,
      transition: {
        duration: 0.4,
        ease: [0.4, 0, 0.2, 1], // Custom easing for fluid motion
        scale: {
          type: "spring",
          damping: 15,
          stiffness: 100
        }
      }
    },
    exit: position === 1 ? {
      y: -20,
      opacity: 0,
      scale: 0.95,
      transition: {
        duration: 0.3,
        ease: [0.4, 0, 0.2, 1]
      }
    } : {
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
        <h3 className="text-white font-medium truncate">
          {track.title}
        </h3>
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

      {/* Queue number */}
      {showPosition && (
        <div className="text-sm text-white/40">
          #{position}
        </div>
      )}
    </motion.div>
  );
} 