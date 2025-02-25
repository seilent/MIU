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
  isRemoving: boolean;
  onAnimationComplete?: () => void;
}

export function AnimatedQueueItem({ 
  track, 
  index, 
  isRemoving,
  onAnimationComplete 
}: AnimatedQueueItemProps) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 20 }}
      animate={{ 
        opacity: 1, 
        y: 0,
        transition: {
          type: "spring",
          stiffness: 300,
          damping: 25,
          delay: index * 0.05 // Stagger effect
        }
      }}
      exit={isRemoving ? {
        x: -100,
        opacity: 0,
        transition: {
          duration: 0.3,
          ease: "easeInOut"
        }
      } : {
        opacity: 0,
        y: -20,
        transition: {
          duration: 0.2
        }
      }}
      onAnimationComplete={onAnimationComplete}
      className="flex items-center space-x-4 bg-white/5 rounded-lg p-4 
                 hover:bg-white/10 transition-all duration-200 
                 border border-white/5 hover:border-white/10
                 relative group mb-4"
    >
      {/* Track thumbnail */}
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

      {/* Track info */}
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

      {/* Queue number */}
      <motion.div 
        layout
        className="text-sm text-white/40"
        whileHover={{ scale: 1.05, opacity: 1 }}
      >
        #{index + 1}
      </motion.div>
    </motion.div>
  );
} 