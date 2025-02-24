import { Request, Response, NextFunction } from 'express';
import Redis from 'ioredis';
import { HTTPError } from './error';

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        roles: string[];
      };
      internal?: boolean; // Flag for internal requests
    }
  }
}

const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: Number(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD
});

interface RateLimitOptions {
  windowMs: number;  // Time window in milliseconds
  max: number;       // Max requests per window
  keyPrefix?: string;// Redis key prefix
  skipInternal?: boolean; // Whether to skip internal requests
}

// Create a rate limiter factory
function createRateLimiter(options: RateLimitOptions) {
  const { windowMs, max, keyPrefix = 'rl:', skipInternal = false } = options;

  return async function rateLimitMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ) {
    try {
      // Skip rate limiting in development
      if (process.env.NODE_ENV === 'development') {
        return next();
      }

      // Get client IP from X-Forwarded-For if trusted, otherwise use direct IP
      const ip = req.ip;
      if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost' || ip === '::ffff:127.0.0.1') {
        return next();
      }

      // Skip rate limiting for internal requests if specified
      if (skipInternal && req.internal) {
        return next();
      }

      // Generate key based on IP and optional user ID
      const identifier = req.user?.id || ip;
      const key = `${keyPrefix}${identifier}`;

      // Get current count
      const current = await redis.get(key);
      const count = current ? parseInt(current, 10) : 0;

      if (count >= max) {
        // Add retry information to headers
        const retryAfter = Math.ceil(windowMs / 1000);
        res.setHeader('Retry-After', retryAfter.toString());
        res.setHeader('X-RateLimit-Reset', (Date.now() + windowMs).toString());
        res.status(429).json({ error: 'Too many requests' });
        return;
      }

      // Increment count or set new key
      if (count === 0) {
        await redis
          .multi()
          .set(key, 1)
          .pexpire(key, windowMs)
          .exec();
      } else {
        await redis.incr(key);
      }

      // Set rate limit headers
      res.setHeader('X-RateLimit-Limit', max);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, max - count - 1));
      res.setHeader('X-RateLimit-Reset', (Date.now() + windowMs).toString());

      next();
    } catch (error) {
      next(new HTTPError(500, 'Rate limiting error'));
    }
  };
}

// Default API rate limiter
export const apiLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 6000, // 6000 requests per minute (100 per second)
  keyPrefix: 'rl:api:',
  skipInternal: true
});

// Create rate limiters with different configurations
export const searchLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 300, // 300 requests per minute (5 per second)
  keyPrefix: 'rl:search:'
});

export const stateLimiter = createRateLimiter({
  windowMs: 1000, // 1 second
  max: 50, // 50 requests per second (supports up to 50 concurrent users)
  keyPrefix: 'rl:state:',
  skipInternal: true  // Skip rate limiting for internal requests
});

export const queueLimiter = createRateLimiter({
  windowMs: 10 * 1000, // 10 seconds
  max: 100, // 100 requests per 10 seconds (10 per second)
  keyPrefix: 'rl:queue:'
});

export const authLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 600, // 600 requests per minute (10 per second)
  keyPrefix: 'rl:auth:'
});

// Position endpoint gets much higher limits
export const positionLimiter = createRateLimiter({
  windowMs: 5000, // 5 second window
  max: 100, // 100 requests per 5 seconds (20 per second)
  keyPrefix: 'rl:position:'
});
