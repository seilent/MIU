// Type definitions for environment variables
interface EnvConfig {
  discordClientId: string;
  url: string;
  apiUrl: string;
  enableAnalytics: boolean;
  defaultTheme: string;
  enableThemeSwitcher: boolean;
}

const isDevelopment = process.env.NODE_ENV === 'development';

// Environment variable manager
export const env: EnvConfig = {
  discordClientId: process.env.NEXT_PUBLIC_DISCORD_CLIENT_ID || '',
  url: process.env.NEXT_PUBLIC_URL || 'https://miu.gacha.boo',
  // Use consistent API URL for both development and production
  apiUrl: process.env.NEXT_PUBLIC_API_URL || 'https://miu.gacha.boo/backend',
  enableAnalytics: process.env.NEXT_PUBLIC_ENABLE_ANALYTICS === 'true',
  defaultTheme: process.env.NEXT_PUBLIC_DEFAULT_THEME || 'dark',
  enableThemeSwitcher: process.env.NEXT_PUBLIC_ENABLE_THEME_SWITCHER !== 'false' // enabled by default
};

// Check for presence of required environment variables
export function validateEnv() {
  const requiredVars = ['discordClientId', 'url'] as const;
  const missingVars = requiredVars.filter(key => !env[key]);

  if (missingVars.length > 0) {
    console.warn(`Missing required environment variables: ${missingVars.join(', ')}`);
  }
}

// Warn about missing environment variables
validateEnv();

// Return environment variables
export default env;
