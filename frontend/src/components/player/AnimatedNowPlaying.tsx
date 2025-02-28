import { useState, useEffect } from 'react';
import Image from 'next/image';
import { motion, AnimatePresence } from 'framer-motion';
import { PlayIcon, PauseIcon } from '@heroicons/react/24/solid';
import { PlayerControls } from '@/components/player/PlayerControls';

interface AnimatedNowPlayingProps {
  track: any;
  isPlaying: boolean;
  onPlayPause: () => void;
}

export function AnimatedNowPlaying({ 
  track, 
  isPlaying, 
  onPlayPause
}: AnimatedNowPlayingProps) {
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
          src={track.thumbnail}
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
        <div className="flex items-center space-x-2 text-sm">
          <span className="text-white/40">Requested by</span>
          <span className="text-white/60">{track.requestedBy.username}</span>
          {track.requestedBy.avatar && (
            <img
              key={`${track.requestedBy.id}-${track.requestedBy.avatar}`}
              src={`https://cdn.discordapp.com/avatars/${track.requestedBy.id}/${track.requestedBy.avatar}.png`}
              alt={track.requestedBy.username}
              className="h-4 w-4 rounded-full opacity-60"
            />
          )}
        </div>
      </motion.div>
    </motion.div>
  );
} 