import { youtubeKeyManager } from './YouTubeKeyManager.js';

/**
 * Execute a YouTube API call with automatic retry on quota exceeded errors
 * @param operationType The operation type (e.g., 'search.list', 'videos.list')
 * @param apiCall Function that takes an API key and returns a Promise with the API call
 * @returns Result of the API call
 */
export async function executeYoutubeApi<T>(operationType: string, apiCall: (key: string) => Promise<T>): Promise<T> {
  try {
    // Use the youtubeKeyManager instance's executeWithRetry method
    return await youtubeKeyManager.executeWithRetry(operationType, apiCall);
  } catch (error: any) {
    console.error(`YouTube API error for ${operationType}:`, error?.message || 'Unknown error');
    throw error;
  }
} 