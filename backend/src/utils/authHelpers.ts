import { Request, Response } from 'express';
import { prisma } from '../prisma.js';
import { ApiErrors } from './apiResponse.js';

/**
 * Centralized authentication and authorization utilities
 */

export interface AuthenticatedRequest extends Request {
  user?: any; // Simplified to avoid type conflicts with existing auth middleware
}

/**
 * Check if user is authenticated
 */
export function requireAuth(req: AuthenticatedRequest, res: Response): boolean {
  if (!req.user) {
    ApiErrors.unauthorized(res);
    return false;
  }
  return true;
}

/**
 * Check if user has admin role
 */
export async function requireAdminRole(req: AuthenticatedRequest, res: Response): Promise<boolean> {
  if (!requireAuth(req, res)) {
    return false;
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      include: { roles: true }
    });

    if (!user || !user.roles.some(role => role.name === 'admin')) {
      ApiErrors.forbidden(res);
      return false;
    }

    return true;
  } catch (error) {
    ApiErrors.serverError(res, 'Failed to check user permissions');
    return false;
  }
}

/**
 * Check if user has specific role
 */
export async function requireRole(req: AuthenticatedRequest, res: Response, roleName: string): Promise<boolean> {
  if (!requireAuth(req, res)) {
    return false;
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      include: { roles: true }
    });

    if (!user || !user.roles.some(role => role.name === roleName)) {
      ApiErrors.forbidden(res);
      return false;
    }

    return true;
  } catch (error) {
    ApiErrors.serverError(res, 'Failed to check user permissions');
    return false;
  }
}