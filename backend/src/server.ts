import express, { Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import swaggerUi from 'swagger-ui-express';
import { createTRPCRouter } from './trpc.js';
import { authRouter } from './routes/auth.js';
import { musicRouter, setupWebSocketAudio } from './routes/music.js';
import { adminRouter } from './routes/admin.js';
import { healthRouter } from './routes/health.js';
import historyRouter from './routes/history.js';
import presenceRouter from './routes/presence.js';
import { errorHandler } from './middleware/error.js';
import { authMiddleware, internalMiddleware } from './middleware/auth.js';
import { apiLimiter, authLimiter, searchLimiter } from './middleware/rateLimit.js';
import logger from './utils/logger.js';
import { swaggerSpec } from './swagger.js';
import cors from 'cors';
import { albumArtRouter } from './routes/albumart.js';
import { initializeDiscordClient } from './discord/client.js';
import getEnv from './utils/env.js';
import http from 'http';

const env = getEnv();

export async function createServer() {
  const app = express();
  const server = http.createServer(app);

  // Initialize Discord client
  try {
    await initializeDiscordClient();
    logger.info('Discord client initialized successfully');
  } catch (error) {
    logger.error('Failed to initialize Discord client:', error);
  }

  // Set up WebSocket server for audio streaming
  const wss = setupWebSocketAudio(server);
  logger.info('WebSocket server for audio streaming initialized');

  // CORS configuration
  const corsOrigins = env.getString('CORS_ORIGIN', 'http://localhost:3300').split(',').map(origin => origin.trim());
  const isProduction = env.getString('NODE_ENV', 'development') === 'production';
  logger.info('Configured CORS origins:', corsOrigins);

  // Configure trusted proxies for secure cookies and rate limiting
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
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Accept-Version', 'Content-Length', 'Content-MD5', 'Date', 'X-Api-Version', 'Origin', 'X-Internal-Request'],
    exposedHeaders: ['Set-Cookie', 'Authorization'],
    maxAge: 86400 // 24 hours
  }));

  // Basic middleware
  app.use(express.json());
  app.use(cookieParser(env.getString('JWT_SECRET')));

  // Session configuration - after CORS but before routes
  app.use(session({
    secret: env.getString('JWT_SECRET'),
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
      secure: true,
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
      sameSite: 'lax', // Changed from 'none' since we're using same-origin
      path: '/',
      httpOnly: true,
      domain: isProduction ? '.gacha.boo' : undefined
    },
    name: 'miu.session'
  }));

  // Add internal request middleware
  app.use(internalMiddleware);

  // Health check routes (before rate limiting)
  app.use('/api/health', healthRouter);

  // Rate limiting middleware
  app.use('/api', apiLimiter);
  app.use('/api/music/search', searchLimiter);

  // API Routes with /api prefix
  app.use('/api/auth', authRouter);
  app.use('/api/music', authMiddleware as express.RequestHandler, musicRouter);
  app.use('/api/admin', authMiddleware as express.RequestHandler, adminRouter);
  app.use('/api/history', authMiddleware as express.RequestHandler, historyRouter);
  app.use('/api/presence', presenceRouter);
  app.use('/api/albumart', albumArtRouter);

  // API Documentation
  if (env.getString('NODE_ENV', 'development') !== 'production') {
    const swaggerUiOptions = {
      explorer: true,
      customSiteTitle: 'MIU API Documentation'
    };

    app.use('/api-docs', swaggerUi.serve);
    app.use('/api-docs', swaggerUi.setup(swaggerSpec, swaggerUiOptions));

    app.get('/api-docs.json', (_req: Request, res: Response) => {
      res.setHeader('Content-Type', 'application/json');
      res.json(swaggerSpec);
    });

    logger.info('API documentation available at /api-docs');
  }

  // tRPC
  app.use('/trpc', createTRPCRouter);

  // Error handling
  const errorHandlerWrapper: ErrorRequestHandler = (err, req, res, next) => {
    try {
      errorHandler(err, req, res, next);
    } catch (error) {
      logger.error('Error in error handler:', error);
      next(error);
    }
  };
  app.use(errorHandlerWrapper);

  // Log server startup
  logger.info('Server created and configured');

  return { app, server };
}
