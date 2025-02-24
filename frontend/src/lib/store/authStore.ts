import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface User {
  id: string;
  username: string;
  discriminator: string;
  avatar: string | null;
  roles: string[];
}

interface AuthState {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  error: string | null;
  setUser: (user: User | null) => void;
  setToken: (token: string | null) => void;
  setLoading: (isLoading: boolean) => void;
  setError: (error: string | null) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      isLoading: false,
      error: null,
      setUser: (user) => {
        set({ user });
      },
      setToken: (token) => {
        // Set token in store
        set({ token });
        
        // Also set token in cookie for API requests
        if (token) {
          try {
            // Get the domain from the current URL
            const domain = window.location.hostname;
            const isSecure = window.location.protocol === 'https:';
            
            // Clear any existing cookies first to avoid duplicates
            document.cookie = `auth_token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
            if (domain) {
              document.cookie = `auth_token=; path=/; domain=${domain}; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
            }
            
            // Set the cookie with the appropriate domain and security settings
            const cookieValue = `auth_token=${token}; path=/; max-age=2592000; domain=${domain}; ${isSecure ? 'secure; ' : ''}SameSite=Lax`;
            document.cookie = cookieValue;
          } catch (err) {
            console.error('Auth Store: Failed to set cookie:', err);
          }
        } else {
          // Clear cookies
          document.cookie = 'auth_token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
          const domain = window.location.hostname;
          if (domain) {
            document.cookie = `auth_token=; path=/; domain=${domain}; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
          }
        }
      },
      setLoading: (isLoading) => set({ isLoading }),
      setError: (error) => {
        set({ error });
      },
      logout: () => {
        // Clear store state
        set({ user: null, token: null, error: null });
        // Clear cookie
        document.cookie = 'auth_token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
        // Clear localStorage
        try {
          localStorage.removeItem('auth-storage');
        } catch (err) {
          console.error('Auth Store: Failed to clear localStorage:', err);
        }
      },
    }),
    {
      name: 'auth-storage',
      partialize: (state) => ({ 
        token: state.token,
        user: state.user
      }),
      version: 1,
      onRehydrateStorage: () => (state) => {
        if (state?.token) {
          try {
            // Get the domain from the current URL
            const domain = window.location.hostname;
            const isSecure = window.location.protocol === 'https:';
            
            // Clear any existing cookies first to avoid duplicates
            document.cookie = `auth_token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
            if (domain) {
              document.cookie = `auth_token=; path=/; domain=${domain}; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
            }
            
            // Ensure cookie is set after rehydration
            const cookieValue = `auth_token=${state.token}; path=/; max-age=2592000; domain=${domain}; ${isSecure ? 'secure; ' : ''}SameSite=Lax`;
            document.cookie = cookieValue;
          } catch (err) {
            console.error('Auth Store: Failed to restore cookie:', err);
          }
        }
      }
    }
  )
); 