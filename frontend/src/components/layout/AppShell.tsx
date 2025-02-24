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

    try {
      if (isYouTubeUrl(query)) {
        // Handle YouTube URL - add directly to queue
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

        // Clear input after successful add
        setQuery('');
        setShowResults(false);
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
      console.error('Search/Queue failed:', error);
      setSearchResults([]);
    } finally {
      setIsSearching(false);
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
      console.error('Failed to add to queue:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to add to queue');
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

  return (
    <ViewContext.Provider value={{ showHistory, setShowHistory, toggleView }}>
      <div className="flex min-h-screen flex-col">
        <div className="relative z-[200]">
          <div className="fixed top-4 right-4">
            <Toaster
              position="top-right"
              toastOptions={{
                className: 'backdrop-blur-lg border rounded-lg',
                style: {
                  background: 'var(--color-primary)',
                  color: 'var(--color-accent)',
                  border: '1px solid rgba(var(--color-accent-rgb), 0.1)',
                },
                duration: 3000,
              }}
            />
          </div>
        </div>

        {/* Header - hidden on login page */}
        {!isLoginPage && (
          <header className="absolute inset-x-0 top-0 z-[100] bg-theme-primary/30 backdrop-blur-lg">
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
                      if (searchResults.length > 0) setShowResults(true);
                    }}
                    placeholder="Search for songs or paste YouTube URL..."
                    className="w-full px-4 py-2 rounded-lg bg-black/20 border border-theme-accent/10 
                             text-theme-accent placeholder:text-theme-accent/40 focus:outline-none 
                             focus:border-theme-accent/30 focus:bg-black/30 focus:ring-1 focus:ring-theme-accent/20
                             transition-all duration-200 text-sm backdrop-blur-sm"
                  />
                </form>

                {/* Search Results Dropdown */}
                {showResults && (
                  <div 
                    className="absolute w-full mt-2 rounded-lg shadow-lg overflow-hidden z-50 backdrop-blur-lg border border-white/10 p-2"
                    style={{ backgroundColor: `${colors.background}CC` }} // CC is 80% opacity in hex
                  >
                    {isSearching ? (
                      <div className="flex items-center justify-center p-4 bg-white/5 backdrop-blur-lg border border-white/5 rounded-lg">
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
                {user && (
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
                        className="absolute right-0 mt-2 w-48 backdrop-blur-lg rounded-lg border border-theme-accent/10 shadow-lg overflow-hidden z-50"
                        style={{ backgroundColor: `${colors.background}CC` }}
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
    </ViewContext.Provider>
  );
}
