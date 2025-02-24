'use client';

import { useEffect } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';

import { useAuth } from '@/providers/AuthProvider';
import { useAuthStore } from '@/lib/store/authStore';
import { usePlayerStore } from '@/lib/store/playerStore';

import { LoadingSpinner } from '@/components/ui/LoadingSpinner';

type LoginPageProps = {
  // Add props if needed in the future
};

export default function LoginPage({}: LoginPageProps) {
  const router = useRouter();
  const { login } = useAuth();
  const { token, isLoading, error } = useAuthStore();
  const currentTrack = usePlayerStore((state) => state.currentTrack);

  useEffect(() => {
    if (!isLoading && token) {
      router.replace('/');
      return;
    }
  }, [token, isLoading, router]);

  if (isLoading) {
    return (
      <div className="h-screen flex items-center justify-center bg-theme-background" role="status" aria-label="Loading">
        <LoadingSpinner size="lg" className="text-theme-accent" />
      </div>
    );
  }

  // Don't render login page if authenticated
  if (token) {
    return null;
  }

  const defaultTitle = "休み";
  const imageUrl = currentTrack?.thumbnail ?? "/images/DEFAULT.jpg";
  const imageAlt = currentTrack?.title ?? defaultTitle;

  return (
    <main className="h-screen flex flex-col items-center justify-between bg-theme-background p-8">
      {/* Top section */}
      <div className="w-full flex-1 flex items-end justify-center pb-4">
        <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold text-theme-accent">MIU</h1>
      </div>

      {/* Middle section - Image and title */}
      <div className="w-full flex-[2] flex flex-col items-center justify-center gap-6">
        <div className="relative w-[16rem] h-[16rem] sm:w-[20rem] sm:h-[20rem] md:w-[24rem] md:h-[24rem] lg:w-[28rem] lg:h-[28rem]">
          <Image
            src={imageUrl}
            alt={imageAlt}
            width={448}
            height={448}
            className="object-cover rounded-lg shadow-xl ring-1 ring-theme-accent/50"
            priority
            unoptimized
          />
        </div>

        <div className="text-center">
          <h2 className="text-xl sm:text-2xl lg:text-3xl font-bold text-theme-accent">
            {currentTrack?.title ?? defaultTitle}
          </h2>
        </div>
      </div>

      {/* Bottom section - Error and Login button */}
      <div className="w-full flex-1 flex flex-col items-center justify-start pt-4">
        {error && (
          <div 
            className="bg-red-500/10 border border-red-500/20 rounded-lg p-4 text-sm text-red-500 mb-4 max-w-md"
            role="alert"
            aria-live="polite"
          >
            {error}
          </div>
        )}

        <button
          onClick={login}
          className="inline-flex items-center px-6 py-3 rounded-lg bg-[#5865F2] hover:bg-[#4752C4] transition-colors text-white font-semibold text-lg"
          aria-label="Login with Discord"
        >
          <svg
            className="w-5 h-5 mr-2"
            fill="currentColor"
            viewBox="0 0 24 24"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515a.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0a12.64 12.64 0 0 0-.617-1.25a.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057a19.9 19.9 0 0 0 5.993 3.03a.078.078 0 0 0 .084-.028a14.09 14.09 0 0 0 1.226-1.994a.076.076 0 0 0-.041-.106a13.107 13.107 0 0 1-1.872-.892a.077.077 0 0 1-.008-.128a10.2 10.2 0 0 0 .372-.292a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127a12.299 12.299 0 0 1-1.873.892a.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028a19.839 19.839 0 0 0 6.002-3.03a.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419c0-1.333.956-2.419 2.157-2.419c1.21 0 2.176 1.096 2.157 2.42c0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419c0-1.333.955-2.419 2.157-2.419c1.21 0 2.176 1.096 2.157 2.42c0 1.333-.946 2.418-2.157 2.418z" />
          </svg>
          Login with Discord
        </button>
      </div>
    </main>
  );
} 