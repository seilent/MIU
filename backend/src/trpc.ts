import { initTRPC } from '@trpc/server';
import { Request, Response } from 'express';
import * as trpcExpress from '@trpc/server/adapters/express';
import { Session, SessionData } from 'express-session';

// Extend express-session types
declare module 'express-session' {
  interface SessionData {
    user: {
      id: string;
      username: string;
      discriminator: string;
      avatar?: string;
      roles: string[];
    };
  }
}

// Create context type
interface Context {
  req: Request & { session: Session & { user?: SessionData['user'] } };
  res: Response;
}

// Create context for each request
export const createContext = ({
  req,
  res,
}: trpcExpress.CreateExpressContextOptions): Context => ({
  req,
  res,
});

// Initialize tRPC
const t = initTRPC.context<Context>().create();

// Create router and procedure helpers
export const router = t.router;
export const publicProcedure = t.procedure;

// Create middleware for protected routes
const isAuthed = t.middleware(({ ctx, next }) => {
  if (!ctx.req.session?.user) {
    throw new Error('Not authenticated');
  }
  return next({
    ctx: {
      // Add user information to context
      user: ctx.req.session.user,
    },
  });
});

export const protectedProcedure = t.procedure.use(isAuthed);

// Create base router
const appRouter = router({
  // Add procedures here
});

// Export type router type
export type AppRouter = typeof appRouter;

// Create express middleware
export const createTRPCRouter = trpcExpress.createExpressMiddleware({
  router: appRouter,
  createContext,
}); 