import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

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

// Import the rest of the dependencies after environment variables are loaded
import { createServer } from './server.js';
import { createServer as createHttpServer } from 'http';
import logger from './utils/logger.js';

async function startServer() {
  try {
    // Initialize Express app
    const app = await createServer();
    
    // Create HTTP server
    const server = createHttpServer(app);
    
    // Start server
    const port = process.env.PORT || 3000;
    server.listen(port, () => {
      logger.info(`Server is running on port ${port}`);
      logger.info('Discord bot is online');
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer()
  .catch((err) => {
    logger.error('Unhandled error:', err);
    process.exit(1);
  });
