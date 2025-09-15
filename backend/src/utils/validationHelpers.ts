import { MAX_DURATION, MIN_DURATION } from '../config.js';
import logger from './logger.js';

/**
 * Centralized validation utilities
 */

/**
 * Validate YouTube ID format
 */
export function isValidYouTubeId(id: string): boolean {
  if (!id || typeof id !== 'string') return false;
  
  // Standard YouTube video ID is 11 characters
  const youtubeIdRegex = /^[a-zA-Z0-9_-]{11}$/;
  return youtubeIdRegex.test(id);
}

/**
 * Extract YouTube ID from URL
 */
export function extractYoutubeId(url: string): string | null {
  if (!url || typeof url !== 'string') return null;

  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/ // Direct ID
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }

  return null;
}

/**
 * Validate track duration
 */
export function validateTrackDuration(duration: number): { isValid: boolean; reason?: string } {
  if (typeof duration !== 'number' || isNaN(duration)) {
    return { isValid: false, reason: 'Duration must be a valid number' };
  }

  if (duration < MIN_DURATION) {
    return { isValid: false, reason: `Duration too short (minimum: ${MIN_DURATION}s)` };
  }

  if (duration > MAX_DURATION) {
    return { isValid: false, reason: `Duration too long (maximum: ${MAX_DURATION}s)` };
  }

  return { isValid: true };
}

/**
 * Parse duration from various formats
 */
export function parseDuration(duration: string | number): number {
  if (typeof duration === 'number') return duration;
  if (!duration) return 0;

  try {
    // ISO 8601 duration format (PT4M20S)
    if (typeof duration === 'string' && duration.startsWith('PT')) {
      const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
      if (match) {
        const hours = parseInt(match[1]) || 0;
        const minutes = parseInt(match[2]) || 0;
        const seconds = parseInt(match[3]) || 0;
        return hours * 3600 + minutes * 60 + seconds;
      }
    }

    // Simple numeric string
    const numeric = parseFloat(duration.toString());
    if (!isNaN(numeric)) return numeric;

    return 0;
  } catch (error) {
    logger.warn(`Failed to parse duration "${duration}":`, error);
    return 0;
  }
}

/**
 * Validate track title
 */
export function isValidTitle(title: string): { isValid: boolean; reason?: string } {
  if (!title || typeof title !== 'string') {
    return { isValid: false, reason: 'Title is required' };
  }

  if (title.trim().length === 0) {
    return { isValid: false, reason: 'Title cannot be empty' };
  }

  if (title.length > 500) {
    return { isValid: false, reason: 'Title too long (maximum: 500 characters)' };
  }

  return { isValid: true };
}

/**
 * Sanitize track title
 */
export function sanitizeTitle(title: string): string {
  if (!title) return 'Unknown Title';
  
  return title
    .trim()
    .replace(/[\x00-\x1F\x7F]/g, '') // Remove control characters
    .slice(0, 500); // Truncate if too long
}

/**
 * Validate file path exists and is accessible
 */
export function isValidFilePath(filePath: string): boolean {
  try {
    const fs = require('fs');
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Check if channel ID is valid format
 */
export function isValidChannelId(channelId: string): boolean {
  if (!channelId || typeof channelId !== 'string') return false;
  
  // YouTube channel IDs typically start with UC and are 24 characters
  const channelIdRegex = /^UC[a-zA-Z0-9_-]{22}$/;
  return channelIdRegex.test(channelId);
}

/**
 * Sanitize and validate search query
 */
export function sanitizeSearchQuery(query: string): { sanitized: string; isValid: boolean; reason?: string } {
  if (!query || typeof query !== 'string') {
    return { sanitized: '', isValid: false, reason: 'Query is required' };
  }

  const sanitized = query.trim().slice(0, 200); // Limit query length

  if (sanitized.length === 0) {
    return { sanitized: '', isValid: false, reason: 'Query cannot be empty' };
  }

  if (sanitized.length < 2) {
    return { sanitized, isValid: false, reason: 'Query too short (minimum: 2 characters)' };
  }

  return { sanitized, isValid: true };
}