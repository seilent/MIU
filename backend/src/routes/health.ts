import { Router } from 'express';
import { prisma } from '../db.js';
import IORedis from 'ioredis';

const router = Router();

// Create Redis client with configuration
const createRedisClient = () => {
  const Redis = IORedis as any;
  return new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: Number(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD
  });
};

interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  services: {
    database: {
      status: 'healthy' | 'unhealthy';
      latency?: number;
    };
    redis: {
      status: 'healthy' | 'unhealthy';
      latency?: number;
    };
  };
  uptime: number;
  memory: NodeJS.MemoryUsage;
}

/**
 * @swagger
 * /health:
 *   get:
 *     summary: Get service health status
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: Health check passed
 *       503:
 *         description: Service unhealthy
 */
router.get('/', async (_req, res) => {
  const status: HealthStatus = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    services: {
      database: { status: 'unhealthy' },
      redis: { status: 'unhealthy' }
    },
    uptime: process.uptime(),
    memory: process.memoryUsage()
  };

  try {
    // Check database
    const dbStart = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    status.services.database = {
      status: 'healthy',
      latency: Date.now() - dbStart
    };
  } catch (error) {
    status.status = 'degraded';
    console.error('Database health check failed:', error);
  }

  try {
    // Check Redis
    const redis = createRedisClient();
    const redisStart = Date.now();
    await redis.ping();
    status.services.redis = {
      status: 'healthy',
      latency: Date.now() - redisStart
    };
    await redis.quit();
  } catch (error) {
    status.status = 'degraded';
    console.error('Redis health check failed:', error);
  }

  // If all services are unhealthy, mark as unhealthy
  if (Object.values(status.services).every(s => s.status === 'unhealthy')) {
    status.status = 'unhealthy';
  }

  res.status(status.status === 'unhealthy' ? 503 : 200).json(status);
});

/**
 * @swagger
 * /health/liveness:
 *   get:
 *     summary: Basic liveness probe
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: Service is alive
 */
router.get('/liveness', (_req, res) => {
  res.status(200).json({
    status: 'alive',
    timestamp: new Date().toISOString()
  });
});

/**
 * @swagger
 * /health/readiness:
 *   get:
 *     summary: Check if service is ready to handle requests
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: Service is ready
 *       503:
 *         description: Service not ready
 */
router.get('/readiness', async (_req, res) => {
  try {
    // Check critical services
    await Promise.all([
      prisma.$queryRaw`SELECT 1`,
      createRedisClient().ping()
    ]);

    res.status(200).json({
      status: 'ready',
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    res.status(503).json({
      status: 'not_ready',
      timestamp: new Date().toISOString(),
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

export const healthRouter = router; 