'use client';

import React, { useEffect, useState } from 'react';
import Image from 'next/image';
import { motion, AnimatePresence } from 'framer-motion';
import env from '@/utils/env';
import { usePlayerStore } from '@/lib/store/playerStore';

interface FrostedBackgroundProps {
  className?: string;
}

export const FrostedBackground = React.memo(function FrostedBackground({ className = '' }: FrostedBackgroundProps) {
  const { currentTrack } = usePlayerStore();
  const [imageUrl, setImageUrl] = useState('/images/DEFAULT.jpg');

  useEffect(() => {
    if (currentTrack?.youtubeId) {
      const newUrl = env.apiUrl 
        ? `${env.apiUrl}/api/albumart/${currentTrack.youtubeId}`
        : `/api/albumart/${currentTrack.youtubeId}`;
      setImageUrl(newUrl);
    } else {
      setImageUrl('/images/DEFAULT.jpg');
    }
  }, [currentTrack?.youtubeId]);

  return (
    <div className={`fixed inset-0 w-screen h-screen overflow-hidden pointer-events-none z-[-1] ${className}`}>
      <AnimatePresence mode="wait">
        <motion.div
          key={imageUrl}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.5 }}
          className="absolute inset-[-50px] w-[calc(100%+100px)] h-[calc(100%+100px)]"
        >
          {/* Background Image */}
          <div className="absolute inset-0 scale-125">
            <Image
              src={imageUrl}
              alt="Background"
              fill
              className="object-cover filter blur-[5px]"
              priority={false}
              loading="lazy"
              quality={75}
              sizes="100vw"
            />
          </div>

          {/* Multiple blurred layers for more consistent effect */}
          <div className="absolute inset-0 backdrop-blur-[80px] bg-black/30" />
          <div className="absolute inset-0 backdrop-blur-[60px] bg-black/20" />
          
          {/* Final overlay for color adjustment */}
          <div className="absolute inset-0 bg-gradient-to-b from-black/10 via-transparent to-black/10" />
        </motion.div>
      </AnimatePresence>
    </div>
  );
}); 