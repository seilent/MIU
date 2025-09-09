import { Express, Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import { errorHandler } from '../middleware/error.js';
import logger from '../utils/logger.js';

export function configureErrorHandling(app: Express): void {
  // Error handling wrapper
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
      res.write('event: error\\ndata: ' + JSON.stringify({ error: err.message }) + '\\n\\n');
      res.end();
    } else {
      next(err);
    }
  });
}