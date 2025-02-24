'use client';

import { useAuthStore } from '@/lib/store/authStore';
import { usePlayerStore } from '@/lib/store/playerStore';
import { usePlayerProvider } from '@/providers/PlayerProvider';
import { cn } from '@/lib/utils/cn';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { useEffect, useState } from 'react';

interface PlayerControlsProps {
  size?: 'sm' | 'md' | 'lg';
  showVolume?: boolean;
  vertical?: boolean;
  className?: string;
}

export function PlayerControls({
  size = 'md',
  showVolume = true,
  vertical = false,
  className,
}: PlayerControlsProps) {
  const { token } = useAuthStore();
  const { isLoading } = usePlayerStore();
  const { sendCommand } = usePlayerProvider();
  const storedVolume = usePlayerStore((state) => state.volume);

  // Client-side volume control
  const [volume, setVolume] = useState(storedVolume);
  const [isMuted, setIsMuted] = useState(false);

  // Sync with stored volume changes
  useEffect(() => {
    setVolume(storedVolume);
  }, [storedVolume]);

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVolume = parseFloat(e.target.value);
    setVolume(newVolume);
    usePlayerStore.getState().setVolume(newVolume);
    
    // If changing volume, unmute
    if (isMuted) {
      setIsMuted(false);
    }
  };

  const toggleMute = () => {
    setIsMuted(!isMuted);
  };

  // Apply volume to the singleton audio instance
  useEffect(() => {
    const audio = document.querySelector('audio');
    if (audio) {
      audio.volume = isMuted ? 0 : volume;
    }
  }, [volume, isMuted]);

  if (!showVolume) {
    return null;
  }

  return (
    <div className={cn(
      "flex flex-col items-center",
      vertical && "h-full",
      className
    )}>
      <div className={cn(
        "group relative flex items-center justify-center",
        vertical ? [
          "h-full w-0.5",
          "flex items-center justify-center"
        ] : "w-full max-w-[200px] mt-5",
        className
      )}>
        <div 
          className={cn(
            "relative",
            vertical ? "h-full w-0.5" : "w-full h-0.5",
            "flex items-center justify-center"
          )}
          onClick={(e) => e.stopPropagation()}>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={isMuted ? 0 : volume}
            onChange={handleVolumeChange}
            onClick={(e) => e.stopPropagation()}
            className={cn(
              "cursor-pointer absolute",
              vertical ? [
                "h-full w-0.5",
                "-rotate-180",
                "[writing-mode:bt-lr]",
                "[writing-mode:vertical-lr]",
                "appearance-none",
                "bg-white/10"
              ] : [
                "w-full h-0.5",
                "appearance-none",
                "bg-white/10"
              ],
              // Webkit (Chrome, Safari, Edge)
              vertical ? [
                "[&::-webkit-slider-thumb]:h-1",
                "[&::-webkit-slider-thumb]:w-2.5"
              ] : [
                "[&::-webkit-slider-thumb]:h-1",
                "[&::-webkit-slider-thumb]:w-2.5"
              ],
              "[&::-webkit-slider-thumb]:appearance-none",
              "[&::-webkit-slider-thumb]:rounded-none",
              "[&::-webkit-slider-thumb]:bg-white",
              "[&::-webkit-slider-thumb]:cursor-pointer",
              "[&::-webkit-slider-thumb]:opacity-0",
              "[&::-webkit-slider-thumb]:group-hover:opacity-100",
              "[&::-webkit-slider-thumb]:transition-opacity",
              vertical ? [
                "[&::-webkit-slider-thumb]:hover:w-3"
              ] : [
                "[&::-webkit-slider-thumb]:hover:w-3"
              ],
              // Firefox thumb
              vertical ? [
                "[&::-moz-range-thumb]:h-1",
                "[&::-moz-range-thumb]:w-2.5",
                "[&::-moz-range-thumb]:translate-x-0",
                "[&::-moz-range-thumb]:translate-y-0"
              ] : [
                "[&::-moz-range-thumb]:h-1",
                "[&::-moz-range-thumb]:w-2.5",
                "[&::-moz-range-thumb]:translate-x-0"
              ],
              "[&::-moz-range-thumb]:appearance-none",
              "[&::-moz-range-thumb]:rounded-none",
              "[&::-moz-range-thumb]:border-0",
              "[&::-moz-range-thumb]:bg-white",
              "[&::-moz-range-thumb]:cursor-pointer",
              "[&::-moz-range-thumb]:opacity-0",
              "[&::-moz-range-thumb]:group-hover:opacity-100",
              "[&::-moz-range-thumb]:transition-opacity",
              vertical ? [
                "[&::-moz-range-thumb]:hover:w-3"
              ] : [
                "[&::-moz-range-thumb]:hover:w-3"
              ],
              // Firefox track
              vertical ? [
                "[&::-moz-range-track]:appearance-none",
                "[&::-moz-range-track]:bg-white/10",
                "[&::-moz-range-track]:w-0.5",
                "[&::-moz-range-track]:border-0",
                "[&::-moz-range-track]:transition-colors",
                "[&::-moz-range-progress]:appearance-none",
                "[&::-moz-range-progress]:bg-white/30",
                "[&::-moz-range-progress]:w-0.5",
                "[&::-moz-range-progress]:border-0",
                "[&::-moz-range-progress]:transition-colors"
              ] : [
                "[&::-moz-range-track]:appearance-none",
                "[&::-moz-range-track]:bg-white/10",
                "[&::-moz-range-track]:h-0.5",
                "[&::-moz-range-track]:border-0",
                "[&::-moz-range-track]:transition-colors",
                "[&::-moz-range-progress]:appearance-none",
                "[&::-moz-range-progress]:bg-white/30",
                "[&::-moz-range-progress]:h-0.5",
                "[&::-moz-range-progress]:border-0",
                "[&::-moz-range-progress]:transition-colors"
              ],
              "hover:bg-white/20",
              "transition-colors"
            )}
          />
        </div>
        {!vertical && (
          <div className={cn(
            "absolute opacity-0 group-hover:opacity-100 transition-opacity",
            "bg-white text-black text-xs px-1.5 py-0.5 rounded pointer-events-none",
            "left-[var(--volume-indicator-pos)] -top-6 -translate-x-1/2"
          )}
          style={{
            '--volume-indicator-pos': `${volume * 100}%`
          } as React.CSSProperties}
          >
            {Math.round(volume * 100)}%
          </div>
        )}
      </div>
    </div>
  );
} 