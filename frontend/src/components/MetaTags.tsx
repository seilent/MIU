'use client';

import { usePlayerStore } from '@/lib/store/playerStore';
import { useEffect, useState } from 'react';
import Script from 'next/script';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
const DEFAULT_IMAGE = `${API_BASE_URL}/images/DEFAULT.jpg`;

// Helper function to update meta tags
function updateMetaTags({ title, description, image }: { title: string; description: string; image: string }) {
  // OpenGraph tags 
  // Note: These client-side updates are for when the page is already loaded
  // For initial load or when scraped by bots, the /api/og endpoint handles dynamic metadata server-side
  document.querySelector('meta[property="og:title"]')?.setAttribute('content', title);
  document.querySelector('meta[property="og:description"]')?.setAttribute('content', description);
  document.querySelector('meta[property="og:image"]')?.setAttribute('content', image);
  document.querySelector('meta[property="og:image:width"]')?.setAttribute('content', '1200');
  document.querySelector('meta[property="og:image:height"]')?.setAttribute('content', '630');

  // Twitter tags
  document.querySelector('meta[name="twitter:card"]')?.setAttribute('content', 'summary_large_image');
  document.querySelector('meta[name="twitter:title"]')?.setAttribute('content', title);
  document.querySelector('meta[name="twitter:description"]')?.setAttribute('content', description);
  document.querySelector('meta[name="twitter:image"]')?.setAttribute('content', image);
}

export function MetaTags() {
  const { currentTrack } = usePlayerStore();
  const [mounted, setMounted] = useState(false);

  // Only render after mount to avoid hydration mismatch
  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;

    // If no track is playing, set default meta tags
    if (!currentTrack) {
      document.title = 'MIU';
      updateMetaTags({
        title: 'MIU',
        description: 'Collaborative music player for Discord communities',
        image: DEFAULT_IMAGE
      });
      return;
    }

    // Add timestamp to thumbnail URL to bypass Discord's cache
    const timestamp = Date.now();
    let thumbnailUrl = '';

    // Use the OG image API for thumbnail to ensure proper formatting
    if (APP_URL) {
      thumbnailUrl = `${APP_URL}/api/og?t=${timestamp}`;
    } else if (currentTrack.youtubeId) {
      // Fallback to direct albumart API
      thumbnailUrl = `${API_BASE_URL}/api/albumart/${currentTrack.youtubeId}?t=${timestamp}`;
    }

    document.title = `Now Playing: ${currentTrack.title}`;
    updateMetaTags({
      title: `Now Playing: ${currentTrack.title}`,
      description: `Requested by ${currentTrack.requestedBy.username}`,
      image: thumbnailUrl
    });
  }, [currentTrack, mounted]);

  if (!mounted) return null;

  return (
    <Script id="meta-tags-updater" strategy="afterInteractive">
      {`
        // Helper function to update meta tags
        function setMetaTags({ title, description, image }) {
          // OpenGraph tags
          document.querySelector('meta[property="og:title"]')?.setAttribute('content', title);
          document.querySelector('meta[property="og:description"]')?.setAttribute('content', description);
          document.querySelector('meta[property="og:image"]')?.setAttribute('content', image);
          document.querySelector('meta[property="og:image:width"]')?.setAttribute('content', '1200');
          document.querySelector('meta[property="og:image:height"]')?.setAttribute('content', '630');

          // Twitter tags
          document.querySelector('meta[name="twitter:card"]')?.setAttribute('content', 'summary_large_image');
          document.querySelector('meta[name="twitter:title"]')?.setAttribute('content', title);
          document.querySelector('meta[name="twitter:description"]')?.setAttribute('content', description);
          document.querySelector('meta[name="twitter:image"]')?.setAttribute('content', image);
        }
      `}
    </Script>
  );
} 