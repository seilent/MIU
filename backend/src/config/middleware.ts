import { Express } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import bodyParser from 'body-parser';
import session from 'express-session';
import getEnv from '../utils/env.js';
import logger from '../utils/logger.js';

const env = getEnv();

export function configureCORS(app: Express): void {
  const corsOrigins = env.getString('CORS_ORIGIN', 'http://localhost:3300')
    .split(',')
    .map(origin => origin.trim());
  
  const isProduction = env.getString('NODE_ENV', 'development') === 'production';
  
  logger.info('Configured CORS origins:', corsOrigins);

  // Configure trusted proxies
  const trustedProxies = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
  app.set('trust proxy', trustedProxies);
  
  // CORS configuration
  app.use(cors({
    origin: (origin, callback) => {
      if (!origin || corsOrigins.includes(origin)) {
        callback(null, true);
      } else {
        logger.warn('CORS blocked request from:', origin);
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type', 
      'Authorization', 
      'X-Requested-With', 
      'Accept', 
      'Accept-Version', 
      'Content-Length', 
      'Content-MD5', 
      'Date', 
      'X-Api-Version', 
      'Origin', 
      'X-Internal-Request', 
      'Last-Event-ID'
    ],
    exposedHeaders: [
      'Set-Cookie', 
      'Authorization', 
      'Content-Type', 
      'Content-Length', 
      'X-Initial-Position', 
      'X-Playback-Start', 
      'X-Track-Id', 
      'X-Track-Duration'
    ],
    maxAge: 86400 // 24 hours
  }));
}

export function configureBasicMiddleware(app: Express): void {
  app.use(cookieParser());
  app.use(bodyParser.json());
}

export function configureSession(app: Express): void {
  const isProduction = env.getString('NODE_ENV', 'development') === 'production';
  
  app.use(session({
    secret: env.getString('JWT_SECRET'),
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
      secure: true,
      maxAge: 1000 * 60 * 60 * 24 * 365, // 365 days
      sameSite: 'lax',
      path: '/',
      httpOnly: true,
      domain: isProduction ? '.gacha.boo' : undefined
    },
    name: 'miu.session'
  }));
}

export function configureURLRewriting(app: Express): void {
  // Remove /backend prefix from API routes
  app.use((req, res, next) => {
    if (req.url.startsWith('/backend/api/')) {
      // Special handling for presence endpoints
      if (req.url.startsWith('/backend/api/discord/presence')) {
        req.url = req.url.replace('/backend/api/discord/presence', '/api/presence/heartbeat');
      } else {
        req.url = req.url.replace('/backend', '');
      }
    }
    next();
  });
}