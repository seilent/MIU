import express from 'express';
import http from 'http';
import logger from './utils/logger.js';
import { initializeDiscordClient } from './discord/client.js';
import { initializeYouTubeAPI } from './utils/youtube.js';

// Configuration modules
import { 
  configureCORS, 
  configureBasicMiddleware, 
  configureSession, 
  configureURLRewriting 
} from './config/middleware.js';
import { configureAPIRoutes, configureAPIDocumentation } from './config/routes.js';
import { configureErrorHandling } from './config/errorHandling.js';
import { setupConnectionTracking } from './config/connections.js';

export async function createServer() {
  const app = express();
  const server = http.createServer(app);
  
  // Setup connection tracking for graceful shutdown
  const serverWithTracking = setupConnectionTracking(server);

  // Initialize external services
  try {
    await initializeDiscordClient();
    logger.info('Discord client initialized successfully');
  } catch (error) {
    logger.error('Failed to initialize Discord client:', error);
    throw error; // This will prevent the server from starting if Discord init fails
  }

  try {
    await initializeYouTubeAPI();
    logger.info('YouTube API initialized successfully');
  } catch (error) {
    logger.error('Failed to initialize YouTube API:', error);
    // Don't throw error here, as the server can still function with some API keys
  }

  // Configure middleware
  configureCORS(app);
  configureBasicMiddleware(app);
  configureSession(app);
  configureURLRewriting(app);

  // Configure routes
  configureAPIRoutes(app);
  configureAPIDocumentation(app);

  // Configure error handling
  configureErrorHandling(app);

  // Log server startup
  logger.info('Server created and configured');

  return { app, server: serverWithTracking };
}
