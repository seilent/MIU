import express, { Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import swaggerUi from 'swagger-ui-express';
import { createTRPCRouter } from './trpc.js';
import { authRouter } from './routes/auth.js';
import { musicRouter } from './routes/music.js';
import { adminRouter } from './routes/admin.js';
import { healthRouter } from './routes/health.js';
import historyRouter from './routes/history.js';
import presenceRouter from './routes/presence.js';
import { errorHandler } from './middleware/error.js';
import { authMiddleware, internalMiddleware } from './middleware/auth.js';
import logger from './utils/logger.js';
import { swaggerSpec } from './swagger.js';
import cors from 'cors';
import { albumArtRouter } from './routes/albumart.js';
import { initializeDiscordClient } from './discord/client.js';
import getEnv from './utils/env.js';
import http from 'http';
import bodyParser from 'body-parser';

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
    throw error; // This will prevent the server from starting if Discord init fails
  }

  // Middleware setup
  app.use(cors({
    origin: env.getString('CORS_ORIGIN', '*'),
    credentials: true
  }));
  app.use(cookieParser());
  app.use(bodyParser.json());

  // CORS configuration
  const corsOrigins = env.getString('CORS_ORIGIN', 'http://localhost:3300').split(',').map(origin => origin.trim());
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
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Accept-Version', 'Content-Length', 'Content-MD5', 'Date', 'X-Api-Version', 'Origin', 'X-Internal-Request', 'Last-Event-ID'],
    exposedHeaders: ['Set-Cookie', 'Authorization', 'Content-Type', 'Content-Length', 'X-Initial-Position', 'X-Playback-Start', 'X-Track-Id', 'X-Track-Duration'],
    maxAge: 86400 // 24 hours
  }));

  // Session configuration
  app.use(session({
    secret: env.getString('JWT_SECRET'),
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
      secure: true,
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
      sameSite: 'lax',
      path: '/',
      httpOnly: true,
      domain: isProduction ? '.gacha.boo' : undefined
    },
    name: 'miu.session'
  }));

  // Remove /backend prefix from API routes
  app.use((req, res, next) => {
    if (req.url.startsWith('/backend/api/')) {
      // Special handling for SSE endpoints
      if (req.url.startsWith('/backend/api/music/state/live')) {
        // Keep the original URL for SSE endpoints
        next();
        return;
      }
      // Special handling for presence endpoints
      if (req.url.startsWith('/backend/api/discord/presence')) {
        req.url = req.url.replace('/backend/api/discord/presence', '/api/presence');
      } else {
        req.url = req.url.replace('/backend', '');
      }
    }
    next();
  });

  // Health check routes
  app.use('/api/health', healthRouter);

  // API Routes
  app.use('/api/auth', authRouter);
  app.use('/api/music', authMiddleware, musicRouter);
  app.use('/api/admin', authMiddleware, adminRouter);
  app.use('/api/history', authMiddleware, historyRouter);
  app.use('/api/presence', authMiddleware, presenceRouter);
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

  // Add error handling for broken SSE connections
  app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    if (err.name === 'UnauthorizedError') {
      res.status(401).json({ error: 'Invalid token' });
    } else if (req.headers.accept === 'text/event-stream') {
      // Handle SSE connection errors gracefully
      if (!res.headersSent) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Connection': 'keep-alive',
          'Cache-Control': 'no-cache',
          'X-Accel-Buffering': 'no'
        });
      }
      res.write('event: error\ndata: ' + JSON.stringify({ error: err.message }) + '\n\n');
      res.end();
    } else {
      next(err);
    }
  });

  // Log server startup
  logger.info('Server created and configured');

  return { app, server };
}
