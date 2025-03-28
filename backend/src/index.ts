import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { createServer } from './server.js';
import logger from './utils/logger.js';
import getEnv from './utils/env.js';
import { prisma } from './db.js';
import type { Server } from 'http';

// Load environment variables first, before any other imports
const rootDir = path.resolve(process.cwd(), '..');

// First load base environment
const baseEnvPath = path.join(rootDir, '.env');
console.log('Loading base environment variables from:', baseEnvPath);

if (!fs.existsSync(baseEnvPath)) {
  console.error('Error: .env file not found at', baseEnvPath);
  process.exit(1);
}

// Load base environment variables
dotenv.config({ path: baseEnvPath });

// Then try to load local environment
const localEnvPath = path.join(rootDir, '.env.local');
console.log('Loading local environment variables from:', localEnvPath);

if (fs.existsSync(localEnvPath)) {
  const localResult = dotenv.config({ path: localEnvPath });
  if (localResult.error) {
    console.error('Error loading .env.local:', localResult.error);
  } else {
    console.log('.env.local loaded successfully');
  }
} else {
  console.log('No .env.local found, using base environment only');
}

// Handle variable interpolation
const interpolateEnvVars = (envVars: Record<string, string>) => {
  const interpolated: Record<string, string> = {};
  for (const [key, value] of Object.entries(envVars)) {
    interpolated[key] = value.replace(/\${([^}]+)}/g, (_, varName) => {
      return envVars[varName] || '';
    });
  }
  return interpolated;
};

// Apply interpolation
const interpolatedEnv = interpolateEnvVars(process.env as Record<string, string>);
for (const [key, value] of Object.entries(interpolatedEnv)) {
  process.env[key] = value;
}

console.log('Environment variables loaded successfully');
console.log('Environment configuration:');
console.log('- YouTube API:', process.env.YOUTUBE_API_KEYS || process.env.YOUTUBE_API_KEY ? 'Configured' : 'Not configured');
console.log('- NODE_ENV:', process.env.NODE_ENV);
console.log('- Database:', process.env.DATABASE_URL ? 'Configured' : 'Not configured');

const env = getEnv();
const PORT = env.getNumber('PORT', 3000);

// Declare server as a global variable so we can access it in shutdown handler
let server: Server | undefined;
// Flag to prevent duplicate shutdown processes
let isShuttingDown = false;

// Graceful shutdown function
async function gracefulShutdown(signal: string): Promise<void> {
  // Avoid multiple shutdown calls
  if (isShuttingDown) {
    logger.info(`Additional ${signal} signal received during shutdown, ignoring`);
    return;
  }
  
  isShuttingDown = true;
  logger.info(`${signal} signal received: starting graceful shutdown`);
  
  // Set a timeout to force exit if graceful shutdown takes too long
  const forceExitTimeout = setTimeout(() => {
    logger.error('Graceful shutdown timed out after 10 seconds, forcing exit');
    process.exit(1);
  }, 10000);
  
  try {
    // Close HTTP server (stop accepting new connections)
    if (server) {
      logger.info('Closing HTTP server (no longer accepting requests)');
      
      // First force close all existing connections
      if ((server as any).closeAllConnections) {
        (server as any).closeAllConnections();
      }
      
      await new Promise<void>((resolve, reject) => {
        if (!server) {
          resolve();
          return;
        }
        
        server.close((err) => {
          if (err) {
            logger.error('Error closing HTTP server:', err);
            reject(err);
          } else {
            logger.info('HTTP server closed successfully');
            resolve();
          }
        });
      });
    }
    
    // Close database connections
    logger.info('Closing database connections');
    await prisma.$disconnect();
    logger.info('Database connections closed');
    
    // Clear the force exit timeout as we're exiting cleanly
    clearTimeout(forceExitTimeout);
    
    // Successful shutdown
    logger.info('Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    logger.error('Error during graceful shutdown:', error);
    // Clear the timeout as we're about to exit
    clearTimeout(forceExitTimeout);
    process.exit(1);
  }
}

async function startServer() {
  try {
    const serverInstance = await createServer();
    // Set the global server reference
    server = serverInstance.server;
    
    server.listen(PORT, () => {
      logger.info(`Server is running on port ${PORT}`);
    });
    
    // Handle graceful shutdown for different signals
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    
    // Handle unhandled rejections and exceptions
    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
    });
    
    process.on('uncaughtException', (error) => {
      logger.error('Uncaught Exception:', error);
      gracefulShutdown('UNCAUGHT_EXCEPTION');
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
