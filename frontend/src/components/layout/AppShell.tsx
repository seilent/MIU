'use client';

import { useState, createContext, useContext, useRef, useEffect } from 'react';
import { ArrowPathRoundedSquareIcon, ClockIcon } from '@heroicons/react/24/outline';
import { useAuthStore } from '@/lib/store/authStore';
import { useAuth } from '@/providers/AuthProvider';
import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Toaster, toast } from 'react-hot-toast';
import env from '@/utils/env';
import { useTheme } from '@/providers/ThemeProvider';
import { BackgroundLayout } from './BackgroundLayout';

interface ViewContextType {
  showHistory: boolean;
  setShowHistory: (show: boolean) => void;
  toggleView: () => void;
}

export const ViewContext = createContext<ViewContextType>({
  showHistory: false,
  setShowHistory: () => {},
  toggleView: () => {}
});

export const useView = () => useContext(ViewContext);

interface AppShellProps {
  children: React.ReactNode;
}

interface SearchResult {
  youtubeId: string;
  title: string;
  thumbnail: string;
  duration: number;
}

export function AppShell({ children }: AppShellProps) {
  const { user } = useAuthStore();
  const { logout } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const { token } = useAuthStore();
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const [loadingItems, setLoadingItems] = useState<Set<string>>(new Set());
  const [showUserMenu, setShowUserMenu] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const { colors } = useTheme();
  const [isUrlLoading, setIsUrlLoading] = useState(false);
  const [urlRequestStatus, setUrlRequestStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const urlRequestTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const isLoginPage = pathname === '/login';

  // Close search results when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (searchRef.current && !searchRef.current.contains(event.target as Node)) {
        setShowResults(false);
      }
      if (userMenuRef.current && !userMenuRef.current.contains(event.target as Node)) {
        setShowUserMenu(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const isYouTubeUrl = (url: string) => {
    return url.match(/^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be|music\.youtube\.com)\/.+$/i);
  };

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;

    // Redirect guests to login page
    if (!user) {
      router.push('/login');
      return;
    }

    try {
      if (isYouTubeUrl(query)) {
        // Handle YouTube URL - add directly to queue
        setIsUrlLoading(true);
        setUrlRequestStatus('idle');

        const response = await fetch(`${env.apiUrl}/api/music/queue`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'X-Internal-Request': 'true'
          },
          body: JSON.stringify({ url: query.trim() })
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || 'Failed to add to queue');
        }

        const track = await response.json();
        
        // Show success state
        setUrlRequestStatus('success');
        toast.success(`Added "${track.title}" to queue`);

        // Clear input and reset state after delay
        if (urlRequestTimeoutRef.current) {
          clearTimeout(urlRequestTimeoutRef.current);
        }
        urlRequestTimeoutRef.current = setTimeout(() => {
          setQuery('');
          setUrlRequestStatus('idle');
          setShowResults(false);
        }, 1500);

        return;
      }

      // For search queries, fetch results
      setIsSearching(true);
      setSearchResults([]); // Clear previous results while searching
      
      const response = await fetch(`${env.apiUrl}/api/music/search?q=${encodeURIComponent(query.trim())}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-Internal-Request': 'true'
        }
      });

      if (!response.ok) {
        throw new Error('Failed to search');
      }

      const data = await response.json();
      
      // Validate and transform the results
      const validResults = (Array.isArray(data) ? data : [])
        .filter((result): result is SearchResult => {
          return result && 
                 typeof result.youtubeId === 'string' && 
                 typeof result.title === 'string' &&
                 typeof result.thumbnail === 'string' &&
                 typeof result.duration === 'number';
        });

      setSearchResults(validResults);
      setShowResults(true);
    } catch (error) {
      // Show error state for URL requests
      if (isYouTubeUrl(query)) {
        setUrlRequestStatus('error');
        if (urlRequestTimeoutRef.current) {
          clearTimeout(urlRequestTimeoutRef.current);
        }
        urlRequestTimeoutRef.current = setTimeout(() => {
          setUrlRequestStatus('idle');
        }, 1500);
      }
      toast.error('Failed to search or queue item');
    } finally {
      setIsSearching(false);
      setIsUrlLoading(false);
    }
  };

  const handleAddToQueue = async (youtubeId: string) => {
    try {
      // Add to loading state
      setLoadingItems(prev => new Set(prev).add(youtubeId));
      
      const response = await fetch(`${env.apiUrl}/api/music/queue`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Internal-Request': 'true'
        },
        body: JSON.stringify({ url: `https://youtube.com/watch?v=${youtubeId}` })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to add to queue');
      }

      const track = await response.json();
      
      // Show success message
      toast.success(`Added "${track.title}" to queue`);

      // Clear search and close dropdown
      setQuery('');
      setShowResults(false);
    } catch (error) {
      // Failed to add to queue
      toast.error('Failed to add to queue');
    } finally {
      // Remove from loading state
      setLoadingItems(prev => {
        const next = new Set(prev);
        next.delete(youtubeId);
        return next;
      });
    }
  };

  const toggleView = () => {
    setShowHistory(!showHistory);
  };

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (urlRequestTimeoutRef.current) {
        clearTimeout(urlRequestTimeoutRef.current);
      }
    };
  }, []);

  return (
    <ViewContext.Provider value={{ showHistory, setShowHistory, toggleView }}>
      <BackgroundLayout>
        <div className="flex min-h-screen flex-col">
          <div className="relative z-[200]">
            <div className="fixed top-4 right-4">
              <Toaster
                position="top-right"
                toastOptions={{
                  className: 'border rounded-lg',
                  style: {
                    background: `rgba(var(--color-background-rgb), 0.85)`,
                    color: '#ffffff',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    backdropFilter: 'blur(12px)',
                    WebkitBackdropFilter: 'blur(12px)',
                  },
                  duration: 3000,
                }}
              />
            </div>
          </div>

          {/* Header - hidden on login page */}
          {!isLoginPage && (
            <header 
              className="absolute inset-x-0 top-0 z-[100] bg-theme-primary/30"
              style={{
                backdropFilter: 'blur(12px)',
                WebkitBackdropFilter: 'blur(12px)'
              }}
            >
              <nav className="flex items-center justify-between p-6 lg:px-8" aria-label="Global">
                <div className="flex items-center gap-x-4">
                  <Link href="/" className="flex items-center gap-x-2">
                    <span className="text-xl font-bold text-theme-accent">MIU</span>
                  </Link>
                </div>

                {/* Search bar */}
                <div className="flex-1 max-w-xl mx-4 relative" ref={searchRef}>
                  <form onSubmit={handleSearch} className="flex-1">
                    <input
                      type="text"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      onFocus={() => {
                        if (!user) {
                          router.push('/login');
                          return;
                        }
                        if (searchResults.length > 0) setShowResults(true);
                      }}
                      onClick={() => {
                        if (!user) {
                          router.push('/login');
                        }
                      }}
                      placeholder={user ? "Search for songs or paste YouTube URL..." : "Login to request / search songs"}
                      className={`w-full px-4 py-2 rounded-lg bg-black/20 border 
                               text-theme-accent placeholder:text-theme-accent/40 focus:outline-none 
                               transition-all duration-200 text-sm
                               ${isUrlLoading ? 'pr-10' : ''}
                               ${!user ? 'cursor-pointer opacity-75 hover:opacity-100' : ''}
                               ${urlRequestStatus === 'success' ? 'border-green-500/30 focus:border-green-500/50 focus:ring-1 focus:ring-green-500/20' :
                                 urlRequestStatus === 'error' ? 'border-red-500/30 focus:border-red-500/50 focus:ring-1 focus:ring-red-500/20' :
                                 'border-theme-accent/10 focus:border-theme-accent/30 focus:bg-black/30 focus:ring-1 focus:ring-theme-accent/20'}`}
                      style={{
                        backdropFilter: 'blur(4px)',
                        WebkitBackdropFilter: 'blur(4px)'
                      }}
                      disabled={isUrlLoading || !user}
                    />
                    {isUrlLoading && (
                      <div className="absolute right-3 top-1/2 -translate-y-1/2">
                        <LoadingSpinner size="sm" className="text-theme-accent" />
                      </div>
                    )}
                    {!isUrlLoading && urlRequestStatus === 'success' && (
                      <div className="absolute right-3 top-1/2 -translate-y-1/2 text-green-500">
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                          <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                        </svg>
                      </div>
                    )}
                    {!isUrlLoading && urlRequestStatus === 'error' && (
                      <div className="absolute right-3 top-1/2 -translate-y-1/2 text-red-500">
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                          <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                        </svg>
                      </div>
                    )}
                  </form>

                  {/* Search Results Dropdown */}
                  {showResults && (
                    <div 
                      className="absolute w-full mt-2 rounded-lg shadow-lg overflow-hidden z-50 border border-white/10 p-2"
                      style={{ 
                        backgroundColor: `rgba(${colors.backgroundRgb}, 0.85)`,
                        backdropFilter: 'blur(12px)',
                        WebkitBackdropFilter: 'blur(12px)'
                      }}
                    >
                      {isSearching ? (
                        <div className="flex items-center justify-center p-4 bg-white/5 border border-white/5 rounded-lg"
                             style={{ backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}>
                          <LoadingSpinner size="sm" className="text-theme-accent" />
                        </div>
                      ) : searchResults.length > 0 ? (
                        <div className="max-h-96 overflow-y-auto space-y-2">
                          {searchResults.map((result) => (
                            <button
                              key={result.youtubeId}
                              onClick={() => handleAddToQueue(result.youtubeId)}
                              disabled={loadingItems.has(result.youtubeId)}
                              className="w-full flex items-center space-x-4 bg-white/5 rounded-lg p-4 
                                       hover:bg-white/10 transition-all duration-200 
                                       border border-white/5 hover:border-white/10
                                       relative group disabled:opacity-50 disabled:cursor-wait text-white"
                            >
                              <div className="relative h-16 w-16 flex-shrink-0">
                                <img
                                  src={result.thumbnail}
                                  alt={result.title}
                                  className="h-full w-full object-cover rounded-md"
                                />
                                <div className="absolute bottom-0 right-0 bg-theme-accent/80 text-xs px-1.5 py-0.5 rounded text-white/90">
                                  {Math.floor(result.duration / 60)}:{String(result.duration % 60).padStart(2, '0')}
                                </div>
                                {loadingItems.has(result.youtubeId) && (
                                  <div className="absolute inset-0 bg-black/50 rounded-md flex items-center justify-center">
                                    <LoadingSpinner size="sm" className="text-theme-accent" />
                                  </div>
                                )}
                              </div>
                              <div className="flex-1 text-left min-w-0">
                                <div className="text-white font-medium truncate">
                                  {result.title}
                                </div>
                              </div>
                            </button>
                          ))}
                        </div>
                      ) : (
                        <div className="text-center py-6 text-white/60 text-sm bg-white/5 rounded-lg border border-white/5">
                          {query.trim() && !isYouTubeUrl(query) ? 'No results found' : ''}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* User menu */}
                <div className="flex items-center gap-x-4">
                  {user ? (
                    <div className="relative" ref={userMenuRef}>
                      <button
                        onClick={() => setShowUserMenu(!showUserMenu)}
                        className="flex items-center justify-center rounded-full overflow-hidden hover:ring-2 hover:ring-theme-accent/30 transition-all"
                      >
                        {user.avatar ? (
                          <img
                            src={`https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`}
                            alt={user.username}
                            className="h-8 w-8 rounded-full"
                          />
                        ) : (
                          <div className="h-8 w-8 bg-theme-accent/20 rounded-full flex items-center justify-center text-theme-accent">
                            {user.username.charAt(0).toUpperCase()}
                          </div>
                        )}
                      </button>
                      
                      {/* Dropdown menu */}
                      {showUserMenu && (
                        <div 
                          className="absolute right-0 mt-2 w-48 rounded-lg border border-theme-accent/10 shadow-lg overflow-hidden z-50"
                          style={{ 
                            backgroundColor: `rgba(${colors.backgroundRgb}, 0.85)`,
                            backdropFilter: 'blur(12px)',
                            WebkitBackdropFilter: 'blur(12px)'
                          }}
                        >
                          <div className="p-3 border-b border-theme-accent/10">
                            <div className="font-medium text-white">{user.username}</div>
                          </div>
                          <button
                            onClick={logout}
                            className="w-full text-left px-4 py-3 text-white hover:bg-white/10 transition-colors flex items-center gap-2"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                            </svg>
                            Logout
                          </button>
                        </div>
                      )}
                    </div>
                  ) : (
                    <button
                      onClick={() => router.push('/login')}
                      className="flex items-center gap-2 px-4 py-2 rounded-lg bg-theme-accent/20 hover:bg-theme-accent/30 
                                text-theme-accent border border-theme-accent/20 hover:border-theme-accent/30
                                transition-all duration-200 text-sm font-medium"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" />
                      </svg>
                      Login
                    </button>
                  )}
                </div>
              </nav>
            </header>
          )}

          {/* Main content - no padding on login page */}
          <main className={`flex-grow ${isLoginPage ? '' : 'pt-20'} pb-8`}>
            {children}
          </main>
        </div>
      </BackgroundLayout>
    </ViewContext.Provider>
  );
}
