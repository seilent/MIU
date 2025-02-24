import jwt, { SignOptions } from 'jsonwebtoken';
import { prisma } from '../db';

export interface TokenPayload {
  userId: string;
  roles: string[];
}

export async function generateToken(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { roles: true }
  });

  if (!user) {
    throw new Error('User not found');
  }

  const payload: TokenPayload = {
    userId: user.id,
    roles: user.roles.map((role: { name: string }) => role.name)
  };

  const options: SignOptions = {
    expiresIn: process.env.JWT_EXPIRY ? parseInt(process.env.JWT_EXPIRY) : '7d'
  };

  return jwt.sign(payload, process.env.JWT_SECRET || 'default_secret', options);
}

export async function verifyToken(token: string): Promise<TokenPayload | null> {
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || 'default_secret') as TokenPayload;
    
    // Check if user still exists and has the same roles
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      include: { roles: true }
    });

    if (!user) {
      return null;
    }

    const currentRoles = user.roles.map((role: { name: string }) => role.name);
    
    // If roles have changed, token is invalid
    if (JSON.stringify(currentRoles.sort()) !== JSON.stringify(payload.roles.sort())) {
      return null;
    }

    return payload;
  } catch (error) {
    return null;
  }
}

export function hasRole(payload: TokenPayload, role: string): boolean {
  return payload.roles.includes(role);
}

export function hasAnyRole(payload: TokenPayload, roles: string[]): boolean {
  return roles.some((role: string) => payload.roles.includes(role));
} 