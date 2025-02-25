import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../db';

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        roles: string[];
      };
      internal?: boolean;
    }
  }
}

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
) {
  // Check both cookies and Authorization header for token
  const cookieToken = req.cookies.token;
  const authHeader = req.headers.authorization;
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const token = bearerToken || cookieToken;

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as {
      id: string;
      roles: string[];
    };

    // Allow system tokens to bypass database check
    if (decoded.id === 'system' && decoded.roles.includes('system')) {
      req.user = {
        id: 'system',
        roles: ['system']
      };
      return next();
    }

    // Get user from database to ensure they still exist and have the same roles
    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      include: { roles: true },
    });

    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    // Attach user info to request
    req.user = {
      id: user.id,
      roles: user.roles.map(role => role.name),
    };

    next();
  } catch (error) {
    console.error('Auth middleware error - authentication failed');
    return res.status(401).json({ error: 'Invalid token' });
  }
}

export function requireRole(role: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!req.user.roles.includes(role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    next();
  };
}

export function requireAnyRole(roles: string[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void | Response> => {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    if (!roles.some(role => req.user!.roles.includes(role))) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    return next();
  };
}

export function internalMiddleware(req: Request, _res: Response, next: NextFunction) {
  // Mark request as internal if X-Internal-Request header is present
  req.internal = req.headers['x-internal-request'] === 'true';
  next();
} 