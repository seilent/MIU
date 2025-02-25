import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { createServer } from './server.js';
import logger from './utils/logger.js';
import getEnv from './utils/env.js';

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

async function startServer() {
  try {
    const { app, server } = await createServer();
    
    server.listen(PORT, () => {
      logger.info(`Server is running on port ${PORT}`);
    });
    
    // Handle graceful shutdown
    process.on('SIGTERM', () => {
      logger.info('SIGTERM signal received: closing HTTP server');
      server.close(() => {
        logger.info('HTTP server closed');
        process.exit(0);
      });
    });
    
    process.on('SIGINT', () => {
      logger.info('SIGINT signal received: closing HTTP server');
      server.close(() => {
        logger.info('HTTP server closed');
        process.exit(0);
      });
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
