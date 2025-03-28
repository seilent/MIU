const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Basic configuration
  poweredByHeader: false,
  
  // Development server configuration
  devIndicators: {
    buildActivity: true
  },

  // Trust headers from reverse proxy
  skipMiddlewareUrlNormalize: true,
  skipTrailingSlashRedirect: true,

  webpack(config) {
    config.module.rules.push({
      test: /\.svg$/,
      use: ['@svgr/webpack']
    });
    return config;
  },

  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'miu.gacha.boo',
        pathname: '/backend/api/albumart/**',
      },
      {
        protocol: 'https',
        hostname: 'i.ytimg.com',
        pathname: '/vi/**',
      },
      {
        protocol: 'https',
        hostname: 'cdn.discordapp.com',
        pathname: '/avatars/**',
      },
      {
        protocol: 'http',
        hostname: 'localhost',
        port: '3000',
        pathname: '/api/albumart/**',
      }
    ],
  },

  // Environment variables that should be available at build time
  env: {
    NEXT_PUBLIC_DISCORD_CLIENT_ID: process.env.NEXT_PUBLIC_DISCORD_CLIENT_ID,
    NEXT_PUBLIC_URL: process.env.NEXT_PUBLIC_URL,
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
    NEXT_PUBLIC_ENABLE_ANALYTICS: process.env.NEXT_PUBLIC_ENABLE_ANALYTICS,
    NEXT_PUBLIC_DEFAULT_THEME: process.env.NEXT_PUBLIC_DEFAULT_THEME,
    NEXT_PUBLIC_ENABLE_THEME_SWITCHER: process.env.NEXT_PUBLIC_ENABLE_THEME_SWITCHER
  },

    // Handle API proxying
  async rewrites() {
    // Use the same API URL for both development and production
    const apiUrl = process.env.API_URL;
    const fullApiUrl = apiUrl.startsWith('http') ? apiUrl : `https://${apiUrl}`;
    
    return [
      // API proxy for both development and production
      {
        source: '/api/:path*',
        destination: `${fullApiUrl}/api/:path*`,
        basePath: false,
      },
      // Maintain backward compatibility for /backend/api paths
      {
        source: '/backend/api/:path*',
        destination: `${fullApiUrl}/api/:path*`,
        basePath: false,
      }
    ];
  },

  // Add headers configuration for CORS
  async headers() {
    return [
      // Single CORS configuration for all API routes
      {
        source: '/(api|backend/api)/:path*',
        headers: [
          { key: 'Access-Control-Allow-Credentials', value: 'true' },
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Access-Control-Allow-Methods', value: 'GET,POST,PUT,DELETE,OPTIONS' },
          { key: 'Access-Control-Allow-Headers', value: 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization, X-Internal-Request' }
        ]
      }
    ];
  }
};

module.exports = nextConfig;
