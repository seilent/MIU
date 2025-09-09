import { Express, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import getEnv from '../utils/env.js';
import logger from '../utils/logger.js';

const env = getEnv();

// Import routers
import { healthRouter } from '../routes/health.js';
import { authRouter } from '../routes/auth.js';
import { musicRouter } from '../routes/music.js';
import { adminRouter } from '../routes/admin.js';
import historyRouter from '../routes/history.js';
import presenceRouter from '../routes/presence.js';
import { albumArtRouter } from '../routes/albumart.js';

// Import tRPC and Swagger
import { createTRPCRouter } from '../trpc.js';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from '../swagger.js';

export function configureAPIRoutes(app: Express): void {
  // Health check routes
  app.use('/api/health', healthRouter);

  // API Routes
  app.use('/api/auth', authRouter);
  app.use('/api/music', authMiddleware, musicRouter);
  app.use('/api/admin', authMiddleware, adminRouter);
  app.use('/api/history', authMiddleware, historyRouter);
  app.use('/api/presence', authMiddleware, presenceRouter);
  app.use('/api/albumart', albumArtRouter);

  // tRPC
  app.use('/trpc', createTRPCRouter);
}

export function configureAPIDocumentation(app: Express): void {
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
}