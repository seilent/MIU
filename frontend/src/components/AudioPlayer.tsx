import React, { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

interface Position {
  position: number;
  duration: number;
  timestamp: number;
  trackId: string;
  title: string;
  playbackRate: number;
}

export function AudioPlayer() {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const startTimeRef = useRef<number>(0);
  const trackIdRef = useRef<string | null>(null);

  // Fetch current position periodically
  const { data: position } = useQuery<Position>({
    queryKey: ['position'],
    queryFn: async () => {
      const res = await fetch('/api/music/position');
      if (!res.ok) throw new Error('Failed to fetch position');
      return res.json();
    },
    refetchInterval: 5000, // Refresh every 5 seconds
  });

  // Handle track changes
  useEffect(() => {
    if (!position || !audioRef.current) return;

    // If track changed, restart stream
    if (trackIdRef.current !== position.trackId) {
      trackIdRef.current = position.trackId;
      startTimeRef.current = Date.now();
      
      // Use secure streaming for track changes
      (async () => {
        try {
          // First fetch a secure token
          const tokenResponse = await fetch(`/api/music/secure-token/${position.trackId}`);
          
          if (tokenResponse.ok) {
            const { token } = await tokenResponse.json();
            // Start secure stream
            audioRef.current!.src = `/api/music/secure-stream/${token}`;
          } else {
            // Fall back to regular stream if secure streaming isn't available
            audioRef.current!.src = `/api/music/stream?ts=${Date.now()}`;
          }
          
          if (isPlaying) {
            audioRef.current!.play().catch(console.error);
          }
        } catch (error) {
          console.error('Secure streaming error, falling back to regular stream:', error);
          // Fall back to regular stream
          audioRef.current!.src = `/api/music/stream?ts=${Date.now()}`;
          if (isPlaying) {
            audioRef.current!.play().catch(console.error);
          }
        }
      })();
    }
  }, [position?.trackId, isPlaying]);

  // Update current time display
  useEffect(() => {
    if (!position || !isPlaying) return;

    const interval = setInterval(() => {
      const elapsed = (Date.now() - startTimeRef.current) / 1000;
      const newTime = position.position + elapsed;
      setCurrentTime(Math.min(newTime, position.duration));
    }, 100);

    return () => clearInterval(interval);
  }, [position, isPlaying]);

  // Handle play/pause
  const togglePlay = async () => {
    if (!audioRef.current) return;

    try {
      if (isPlaying) {
        audioRef.current.pause();
      } else {
        // Get fresh position before playing
        const res = await fetch('/api/music/position');
        const pos: Position = await res.json();
        
        // Update tracking
        startTimeRef.current = Date.now();
        trackIdRef.current = pos.trackId;
        
        // Use secure streaming instead of direct streaming
        try {
          // First fetch a secure token
          const tokenResponse = await fetch(`/api/music/secure-token/${pos.trackId}`);
          
          if (tokenResponse.ok) {
            const { token } = await tokenResponse.json();
            // Start secure stream
            audioRef.current.src = `/api/music/secure-stream/${token}`;
          } else {
            // Fall back to regular stream if secure streaming isn't available
            audioRef.current.src = `/api/music/stream?ts=${Date.now()}`;
          }
          
          await audioRef.current.play();
        } catch (error) {
          console.error('Secure streaming error, falling back to regular stream:', error);
          // Fall back to regular stream
          audioRef.current.src = `/api/music/stream?ts=${Date.now()}`;
          await audioRef.current.play();
        }
      }
      setIsPlaying(!isPlaying);
    } catch (error) {
      console.error('Playback error:', error);
    }
  };

  // Format time as mm:ss
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="audio-player">
      <audio ref={audioRef} />
      
      <div className="controls">
        <button onClick={togglePlay}>
          {isPlaying ? 'Pause' : 'Play'}
        </button>
        
        <div className="time-display">
          {formatTime(currentTime)} / {formatTime(position?.duration || 0)}
        </div>
        
        <div className="track-info">
          {position?.title || 'No track playing'}
        </div>
      </div>
    </div>
  );
} 