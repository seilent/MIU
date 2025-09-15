import { Response } from 'express';
import logger from './logger.js';

/**
 * Centralized API response utilities
 */

export function sendError(res: Response, statusCode: number, message: string, details?: any) {
  logger.error(`API Error ${statusCode}: ${message}`, details);
  return res.status(statusCode).json({ error: message });
}

export function sendSuccess(res: Response, data: any, statusCode: number = 200) {
  return res.status(statusCode).json(data);
}

// Common error responses
export const ApiErrors = {
  unauthorized: (res: Response) => sendError(res, 401, 'Authentication required'),
  forbidden: (res: Response) => sendError(res, 403, 'Access forbidden'),
  notFound: (res: Response, resource: string = 'Resource') => sendError(res, 404, `${resource} not found`),
  serverError: (res: Response, message: string = 'Internal server error') => sendError(res, 500, message),
  badRequest: (res: Response, message: string) => sendError(res, 400, message),
  
  // Music-specific errors
  noTrackPlaying: (res: Response) => sendError(res, 404, 'No track currently playing'),
  audioNotFound: (res: Response) => sendError(res, 404, 'Audio not found'),
  discordNotAvailable: (res: Response) => sendError(res, 500, 'Discord client not available'),
  playerNotAvailable: (res: Response) => sendError(res, 500, 'Player not available'),
  streamFailed: (res: Response) => sendError(res, 500, 'Stream failed'),
  positionFailed: (res: Response) => sendError(res, 500, 'Failed to get position'),
} as const;