import { Request, Response, NextFunction } from 'express';

export class HTTPError extends Error {
  statusCode: number;
  headers?: Record<string, string>;

  constructor(statusCode: number, message: string, headers?: Record<string, string>) {
    super(message);
    this.statusCode = statusCode;
    this.headers = headers;
    this.name = 'HTTPError';
  }
}

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
): Response {
  console.error('Error:', err);

  if (err instanceof HTTPError) {
    return res.status(err.statusCode).json({
      error: err.message || 'An error occurred'
    });
  }

  // Handle Prisma errors
  if (err.name === 'PrismaClientKnownRequestError') {
    return res.status(400).json({
      error: 'Invalid request'
    });
  }

  if (err.name === 'PrismaClientValidationError') {
    return res.status(400).json({
      error: 'Validation error'
    });
  }

  // Handle JWT errors
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({
      error: 'Invalid token'
    });
  }

  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({
      error: 'Token expired'
    });
  }

  // Default error
  return res.status(500).json({
    error: process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message
  });
} 