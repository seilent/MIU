import { useState, useEffect, useRef } from 'react';
import Image from 'next/image';
import { motion, AnimatePresence } from 'framer-motion';
import env from '@/utils/env';

interface AnimatedQueueItemProps {
  track: any;
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
  const [isVisible, setIsVisible] = useState(true);
  
  // Calculate a staggered delay based on index for wave effect
  const animationDelay = index * 0.08; // 80ms stagger between items
  
  useEffect(() => {
    if (isRemoving) {
      const timer = setTimeout(() => {
        setIsVisible(false);
      }, animationDelay * 1000);
      
      return () => clearTimeout(timer);
    }
  }, [isRemoving, animationDelay]);

  return (
    <AnimatePresence mode="wait" onExitComplete={onAnimationComplete}>
      {isVisible && (
        <motion.div
          initial={isRemoving ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -20, height: 0, marginBottom: 0, overflow: 'hidden' }}
          transition={{ 
            duration: 0.4, 
            delay: isRemoving ? animationDelay : 0,
            ease: [0.4, 0, 0.2, 1] // Custom easing for more natural motion
          }}
          className="flex items-center space-x-4 bg-white/5 rounded-lg p-4 
                   hover:bg-white/10 transition-all duration-200 
                   border border-white/5 hover:border-white/10
                   relative group mb-4"
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
        </motion.div>
      )}
    </AnimatePresence>
  );
} 