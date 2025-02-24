import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class EnvironmentManager {
  private static instance: EnvironmentManager | null = null;
  private initialized = false;

  private constructor() {
    this.loadEnv();
  }

  private loadEnv() {
    if (this.initialized) return;

    // First load the base .env file
    const baseEnvPath = path.resolve(__dirname, '../../..', '.env');
    console.log('Loading base environment variables from:', baseEnvPath);
    dotenv.config({ path: baseEnvPath });

    // Then load .env.local which overrides base values
    const localEnvPath = path.resolve(__dirname, '../../..', '.env.local');
    console.log('Loading local environment variables from:', localEnvPath);
    const localResult = dotenv.config({ path: localEnvPath });
    
    if (localResult.error) {
      console.log('No .env.local found, using base environment only');
    }

    // Validate required variables
    const requiredVars = [
      'DISCORD_CLIENT_ID',
      'DISCORD_CLIENT_SECRET',
      'JWT_SECRET'
    ];

    const missingVars = requiredVars.filter(name => !process.env[name]);
    
    if (missingVars.length > 0) {
      throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
    }

    this.initialized = true;

    // Log environment status in development
    if (process.env.NODE_ENV === 'development') {
      console.log('Environment Configuration:', {
        NODE_ENV: process.env.NODE_ENV,
        DISCORD_CLIENT_ID: '**present**',
        DISCORD_CLIENT_SECRET: '**present**',
        JWT_SECRET: '**present**',
        FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:3300'
      });
    }
  }

  public getString(name: string, defaultValue?: string): string {
    const value = process.env[name];
    if (value === undefined) {
      if (defaultValue === undefined) {
        throw new Error(`Environment variable ${name} is not defined`);
      }
      return defaultValue;
    }
    return value;
  }

  public getNumber(name: string, defaultValue?: number): number {
    const value = process.env[name];
    if (value === undefined) {
      if (defaultValue === undefined) {
        throw new Error(`Environment variable ${name} is not defined`);
      }
      return defaultValue;
    }
    const num = Number(value);
    if (isNaN(num)) {
      throw new Error(`Environment variable ${name} is not a number`);
    }
    return num;
  }

  public getBoolean(name: string, defaultValue?: boolean): boolean {
    const value = process.env[name];
    if (value === undefined) {
      if (defaultValue === undefined) {
        throw new Error(`Environment variable ${name} is not defined`);
      }
      return defaultValue;
    }
    return value.toLowerCase() === 'true';
  }

  public static getInstance(): EnvironmentManager {
    if (!EnvironmentManager.instance) {
      EnvironmentManager.instance = new EnvironmentManager();
    }
    return EnvironmentManager.instance;
  }
}

// Create env manager instance lazily
let envManagerInstance: EnvironmentManager | null = null;

export function getEnv(): EnvironmentManager {
  if (!envManagerInstance) {
    envManagerInstance = EnvironmentManager.getInstance();
  }
  return envManagerInstance;
}

export default getEnv;

// Get the root directory (MIU folder)
export function getRootDir(): string {
  const currentDir = process.cwd();
  // If we're already in the root directory (has cache folder)
  if (currentDir.endsWith('MIU')) {
    return currentDir;
  }
  // If we're in the backend directory
  if (currentDir.endsWith('backend')) {
    return path.resolve(currentDir, '..');
  }
  // Default to current directory
  return currentDir;
} 