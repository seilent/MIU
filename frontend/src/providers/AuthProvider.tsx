'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useAuthStore } from '@/lib/store/authStore';
import env, { validateEnv } from '../utils/env';

interface AuthContextType {
  login: () => void;
  logout: () => void;
  error: string | null;
}

const AuthContext = createContext<AuthContextType>({
  login: () => {},
  logout: () => {},
  error: null,
});

export const useAuth = () => useContext(AuthContext);

interface AuthProviderProps {
  children: React.ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const { token } = useAuthStore();
  const [error, setError] = useState<string | null>(null);
  const [isInitializing, setIsInitializing] = useState(true);
  const router = useRouter();
  const pathname = usePathname();
  const {
    setToken,
    setUser,
    setError: setAuthError,
    logout: clearAuth
  } = useAuthStore();

  // Function to fetch user data
  const fetchUserData = async (authToken: string) => {
    try {
      // Use the configured API URL
      const apiUrl = `${env.apiUrl}/api/auth/me`;
      
      const response = await fetch(apiUrl, {
        headers: {
          'Authorization': `Bearer ${authToken}`,
          'X-Internal-Request': 'true'
        },
      });

      if (!response.ok) {
        // Failed to fetch user data
        setUser(null);
        setToken(null);
        return;
      }

      const data = await response.json();
      if (!data.user) {
        throw new Error('Invalid user data');
      }

      setUser(data.user);
      return data.user;
    } catch (error) {
      // Error fetching user data
      setUser(null);
      setToken(null);
      return null;
    }
  };

  useEffect(() => {
    const initializeAuth = async () => {
      try {
        validateEnv();
        setIsInitializing(true);

        // Improved cookie parsing that handles multiple cookies with the same name
        const getCookieValue = (name: string): string | null => {
          const cookies = document.cookie.split(';');
          const tokenCookies = cookies
            .map(cookie => cookie.trim())
            .filter(cookie => cookie.startsWith(`${name}=`))
            .map(cookie => cookie.substring(name.length + 1));
          
          // Return the most recent cookie (last one)
          return tokenCookies.length > 0 ? tokenCookies[tokenCookies.length - 1] : null;
        };
        
        // Try both cookie names
        const httpOnlyToken = getCookieValue('token');
        const clientToken = getCookieValue('auth_token');
        
        const authToken = httpOnlyToken || clientToken;

        if (authToken) {
          // Set the token in the store
          setToken(authToken);
          
          // Fetch user data
          await fetchUserData(authToken);
        } else {
          // Try to get token from localStorage directly
          try {
            const storedAuth = localStorage.getItem('auth-storage');
            if (storedAuth) {
              const parsedAuth = JSON.parse(storedAuth);
              if (parsedAuth.state && parsedAuth.state.token) {
                setToken(parsedAuth.state.token);
                await fetchUserData(parsedAuth.state.token);
              }
            }
          } catch (err) {
            // Failed to read from localStorage
          }
        }
      } catch (err) {
        // Environment validation failed
        setError('Application configuration error');
      } finally {
        setIsInitializing(false);
      }
    };

    initializeAuth();
  }, [setToken, setUser]);

  // Handle OAuth redirect and token exchange
  useEffect(() => {
    // Skip this effect since the callback is now handled by the Next.js route handler
    // The route handler will set the cookies, which will be picked up by the initial useEffect
    return;
  }, [pathname, router, setError, setToken, setAuthError]);

  // Check token validity and protect routes
  useEffect(() => {
    if (isInitializing) return;

    const checkAuth = async () => {
      // Skip auth check for public routes and static assets
      const isPublicRoute = 
        pathname === '/login' || 
        pathname === '/auth/callback' ||
        pathname.startsWith('/_next/') ||
        pathname.startsWith('/api/') ||
        pathname.startsWith('/static/') ||
        pathname.startsWith('/images/');

      if (isPublicRoute) {
        // If we're on login page and already have a token, redirect to home
        if (pathname === '/login' && token) {
          router.replace('/');
        }
        return;
      }

      // If no token and on protected route, redirect to login
      if (!token) {
        setAuthError(null);
        router.replace('/login');
        return;
      }

      // Only validate token if we have one
      try {
        await fetchUserData(token);
      } catch (error) {
        // Token validation error
        setUser(null);
        setToken(null);
        setError(error instanceof Error ? error.message : 'Authentication failed');
        setAuthError(null);
        router.replace('/login');
      }
    };

    // Add a delay to ensure token is properly set
    const timeoutId = setTimeout(checkAuth, 1000);
    return () => clearTimeout(timeoutId);
  }, [token, pathname, router, setError, setAuthError, isInitializing, fetchUserData]);

  const login = () => {
    try {
      validateEnv();
      
      const clientId = env.discordClientId;
      
      // Use the configured URL
      const redirectUriBase = `${env.url}/auth/callback`;
      const redirectUri = encodeURIComponent(redirectUriBase);
      const scope = encodeURIComponent('identify');
      
      // Clear any existing cookies to ensure a fresh login attempt
      document.cookie = 'token=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;';
      document.cookie = 'auth_token=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;';
      
      // Redirect to Discord OAuth
      window.location.href = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=${scope}`;
    } catch (err) {
      // Login failed
      setError('Failed to initialize login process');
    }
  };

  const logout = () => {
    // Get the domain from the current URL
    const domain = window.location.hostname;
    
    // Clear cookies with various domain options to ensure they're removed
    document.cookie = `token=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;`;
    document.cookie = `auth_token=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;`;
    
    // Also try with domain
    document.cookie = `token=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; domain=${domain};`;
    document.cookie = `auth_token=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; domain=${domain};`;
    
    // Also try with .domain (subdomain wildcard)
    if (domain.indexOf('.') !== -1) {
      const rootDomain = domain.substring(domain.indexOf('.'));
      document.cookie = `token=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; domain=${rootDomain};`;
      document.cookie = `auth_token=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; domain=${rootDomain};`;
    }
    
    // Clear localStorage
    try {
      localStorage.removeItem('auth-storage');
    } catch (err) {
      // Failed to clear localStorage
    }
    
    // Clear auth store
    setToken(null);
    setUser(null);
    
    // Redirect to login
    router.push('/login');
  };

  return (
    <AuthContext.Provider value={{ login, logout, error }}>
      {children}
    </AuthContext.Provider>
  );
}

export default AuthProvider;