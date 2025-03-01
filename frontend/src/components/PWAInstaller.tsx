'use client';

import { useEffect, useState } from 'react';

export default function PWAInstaller() {
  const [installPrompt, setInstallPrompt] = useState<any>(null);
  const [isInstalled, setIsInstalled] = useState(false);

  // Register service worker
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      // Force update the service worker and clear cache on development
      // This ensures we don't have stale cache during development
      if (process.env.NODE_ENV === 'development') {
        // First try to unregister any existing service workers
        navigator.serviceWorker.getRegistrations().then(registrations => {
          for (const registration of registrations) {
            registration.unregister().then(() => {
              console.log('Service Worker unregistered for development');
            });
          }
          
          // Clear all caches
          caches.keys().then(cacheNames => {
            cacheNames.forEach(cacheName => {
              caches.delete(cacheName).then(() => {
                console.log(`Cache ${cacheName} deleted for development`);
              });
            });
          });
        });
      }
      
      // Register the service worker
      navigator.serviceWorker
        .register('/sw.js')
        .then(registration => {
          console.log('Service Worker registered with scope:', registration.scope);
          
          // Update the service worker if a new version is available
          registration.update();
        })
        .catch(error => {
          console.error('Service Worker registration failed:', error);
        });
    }
  }, []);

  // Listen for beforeinstallprompt event to enable install button
  useEffect(() => {
    const handleBeforeInstallPrompt = (event: Event) => {
      // Prevent Chrome 76+ from automatically showing the prompt
      event.preventDefault();
      // Stash the event so it can be triggered later
      setInstallPrompt(event);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);

    // Check if app is already installed
    const checkIsInstalled = () => {
      // For iOS, we check if the display-mode is standalone
      if (window.matchMedia('(display-mode: standalone)').matches) {
        setIsInstalled(true);
      }
      // For iOS Safari - standalone property is on window, not navigator
      if ('standalone' in window.navigator && (window.navigator as any).standalone === true) {
        setIsInstalled(true);
      }
    };

    checkIsInstalled();

    // Listen for appinstalled event
    window.addEventListener('appinstalled', () => {
      setIsInstalled(true);
      setInstallPrompt(null);
      console.log('PWA was installed');
    });

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    };
  }, []);

  return null; // This component doesn't render anything visually
} 