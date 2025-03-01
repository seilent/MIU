'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuthStore } from '@/lib/store/authStore';
import { useRouter } from 'next/navigation';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { ArrowPathIcon } from '@heroicons/react/24/outline';
import Image from 'next/image';
import { HistoryTrack } from '@/lib/types';
import env from '@/utils/env';
import { toast } from 'react-hot-toast';
import SSEManager from '@/lib/sse/SSEManager';

export default function HistoryPage() {
  const { token } = useAuthStore();
  const [history, setHistory] = useState<HistoryTrack[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Add function to transform thumbnail URL
  const getThumbnailUrl = (youtubeId: string): string => {
    return `${env.apiUrl}/api/albumart/${youtubeId}?square=1`;
  };

  // Use SSE for history updates
  useEffect(() => {
    if (!token) return;

    // Get initial history
    fetch(`${env.apiUrl}/api/music/history`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-Internal-Request': 'true'
      }
    })
      .then(res => res.json())
      .then(data => setHistory(Array.isArray(data) ? data : []))
      .catch(error => console.error('Error fetching history:', error));

    const sseManager = SSEManager.getInstance();

    sseManager.addEventListener('history', (data) => {
      setHistory(Array.isArray(data.tracks) ? data.tracks : []);
    });

    // Connect with token
    sseManager.connect(token);

    return () => {
      sseManager.disconnect();
    };
  }, [token]);

  const handleAddToQueue = async (track: HistoryTrack) => {
    if (!token) return;

    try {
      const response = await fetch(`${env.apiUrl}/api/music/queue`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'X-Internal-Request': 'true'
        },
        body: JSON.stringify({ youtubeId: track.youtubeId })
      });

      if (!response.ok) {
        throw new Error('Failed to add track to queue');
      }

      setError(null);
    } catch (err) {
      // Failed to add track to queue
      toast.error('Failed to add track to queue');
    }
  };

  const handleRefresh = () => {
    // This function is no longer used with SSE
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleString();
  };

  const formatDuration = (seconds: number) => {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <LoadingSpinner size="lg" className="text-theme-accent" />
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-bold text-white">History</h1>
        <button
          onClick={handleRefresh}
          className="p-2 rounded-full hover:bg-white/10 transition-colors text-white/80 hover:text-white"
        >
          <ArrowPathIcon className="h-5 w-5" />
        </button>
      </div>

      {error && (
        <div className="bg-red-900/20 border border-red-500/30 rounded-lg p-4 mb-8 text-sm text-red-400">
          {error}
        </div>
      )}

      <div className="space-y-3">
        {history.length > 0 ? (
          history.map((track) => (
            <div
              key={`${track.id}-${track.playedAt}`}
              className="flex items-center space-x-4 bg-white/5 rounded-lg p-4 
                       hover:bg-white/10 transition-all duration-200 
                       border border-white/5 hover:border-white/10
                       relative group"
            >
              <div className="relative h-16 w-16 flex-shrink-0">
                <img
                  src={track.thumbnail.startsWith('http') && !track.thumbnail.includes('/api/albumart/') 
                    ? track.thumbnail 
                    : getThumbnailUrl(track.youtubeId)}
                  alt={track.title}
                  className="h-16 w-16 rounded-md object-cover filter-thumbnail"
                />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-white font-medium truncate">{track.title}</h3>
                {track.artist && (
                  <p className="text-white/60 text-sm truncate">{track.artist}</p>
                )}
                <div className="flex items-center space-x-2 text-white/40 text-sm">
                  <span>{formatDuration(track.duration)}</span>
                  <span className="text-white/20">•</span>
                  <span>{formatDate(track.playedAt)}</span>
                </div>
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
              {/* Add to Queue button - only visible on hover */}
              <div className="absolute right-4 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-all duration-200">
                <button
                  onClick={() => handleAddToQueue(track)}
                  className="px-4 py-2 bg-white/10 hover:bg-white/20 text-white/90 hover:text-white rounded-md 
                           transition-all duration-200 border border-white/10 hover:border-white/20
                           font-medium text-sm backdrop-blur-sm"
                >
                  Add to Queue
                </button>
              </div>
            </div>
          ))
        ) : (
          <div className="text-center py-12 text-white/40 bg-white/5 rounded-lg border border-white/5">
            No history available
          </div>
        )}
      </div>
    </div>
  );
}
