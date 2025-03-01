/**
 * Utility for controlling the service worker cache
 */

/**
 * Clears all service worker caches
 * @returns Promise that resolves when the cache is cleared
 */
export const clearServiceWorkerCache = async (): Promise<boolean> => {
  if (!navigator.serviceWorker || !navigator.serviceWorker.controller) {
    console.log('No active service worker found');
    return false;
  }

  return new Promise((resolve) => {
    const messageChannel = new MessageChannel();
    
    messageChannel.port1.onmessage = (event) => {
      if (event.data && event.data.success) {
        console.log('Successfully cleared service worker cache');
        resolve(true);
      } else {
        console.error('Failed to clear service worker cache');
        resolve(false);
      }
    };

    if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage(
        { type: 'CLEAR_CACHE' },
        [messageChannel.port2]
      );
    } else {
      console.error('Service worker controller not available');
      resolve(false);
    }
  });
};

/**
 * Forces the service worker to update and activate
 */
export const updateServiceWorker = async (): Promise<void> => {
  if ('serviceWorker' in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    
    for (const registration of registrations) {
      await registration.update();
      console.log('Service worker updated');
    }
  }
};

/**
 * Completely unregisters all service workers
 * This is useful during development to ensure no caching
 */
export const unregisterServiceWorkers = async (): Promise<void> => {
  if ('serviceWorker' in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    
    for (const registration of registrations) {
      await registration.unregister();
      console.log('Service worker unregistered');
    }
  }
}; 