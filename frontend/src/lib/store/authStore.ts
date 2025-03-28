import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { getCookie, setCookie, deleteCookie } from '../utils/cookies';

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
      setToken: (token: string | null) => {
        set({ token });
        if (token) {
          // Also set token in cookie for API requests
          try {
            // Use more secure defaults and don't explicitly set maxAge
            // since the utility now defaults to 365 days
            setCookie('auth_token', token, { 
              sameSite: 'Lax',
              secure: window.location.protocol === 'https:'
            });
          } catch (err) {
            console.error('Failed to set auth cookie:', err);
          }
        } else {
          // Clear cookies
          deleteCookie('auth_token');
        }
      },
      setLoading: (isLoading) => set({ isLoading }),
      setError: (error) => {
        set({ error });
      },
      logout: () => {
        set({ user: null, token: null });
        // Clear cookie
        deleteCookie('auth_token');
      },
    }),
    {
      name: 'auth-storage',
      partialize: (state) => ({ 
        token: state.token,
        user: state.user
      }),
      version: 1,
      onRehydrateStorage: () => (state, error) => {
        if (state?.token) {
          try {
            const token = getCookie('auth_token');
            if (token) {
              // We need to access the store's set function
              const { setToken } = useAuthStore.getState();
              setToken(token);
            }
          } catch (err) {
            // Failed to restore cookie
          }
        }
      }
    }
  )
); 