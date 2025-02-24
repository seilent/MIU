// Duration limits
export const MAX_DURATION = 60 * 10; // 10 minutes in seconds

// API configuration
export const API_BASE_URL = process.env.API_URL || 'https://miu.gacha.boo';

// Cache configuration
export const CACHE_DIR = process.env.CACHE_DIR || './cache';
export const AUDIO_CACHE_DIR = `${CACHE_DIR}/audio`;
export const THUMBNAIL_CACHE_DIR = `${CACHE_DIR}/thumbnails`;

// Queue configuration
export const MAX_QUEUE_SIZE = 50;
export const MAX_HISTORY_SIZE = 100;

// Rate limiting
export const RATE_LIMIT = {
  SEARCH: {
    WINDOW_MS: 60 * 1000, // 1 minute
    MAX_REQUESTS: 30,     // 30 requests per minute
  },
  QUEUE: {
    WINDOW_MS: 60 * 1000, // 1 minute
    MAX_REQUESTS: 20,     // 20 requests per minute
  },
  STATE: {
    WINDOW_MS: 1000,      // 1 second
    MAX_REQUESTS: 50,     // 50 requests per second
  }
}; 