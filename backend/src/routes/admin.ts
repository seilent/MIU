import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';
import { requireRole } from '../middleware/auth';
import { HTTPError } from '../middleware/error';
import { prisma } from '../db';
import { authMiddleware } from '../middleware/auth';
import { Cache } from '../utils/cache';
import { getPlayer } from '../discord/player.js';
import { refreshYoutubeRecommendationsPool, cleanupExcessRecommendations } from '../utils/youtube.js';

const router = Router();

// Require authentication and admin role for all routes in this router
router.use(authMiddleware as RequestHandler);
router.use(requireRole('admin') as RequestHandler);

interface UserWithRoles {
  id: string;
  username: string;
  roles: Array<{
    name: string;
  }>;
}

interface SettingsObject {
  [key: string]: string;
}

interface StatsResponse {
  uptime: number;
  memoryUsage: NodeJS.MemoryUsage;
  cpuUsage: NodeJS.CpuUsage;
  stats: {
    totalUsers: number;
    totalPlays: number;
    topTracks: Array<{
      title: string;
      artist: string | null;
      plays: number;
    }>;
    topRequesters: Array<{
      username: string;
      requests: number;
    }>;
  };
}

interface GroupByCount {
  _count: number;
  youtubeId: string;
  title: string;
  artist: string | null;
}

interface UserGroupByCount {
  _count: number;
  userId: string;
}

interface RoleData {
  id: string;
  name: string;
  permissions: string[];
}

interface SettingData {
  id: string;
  key: string;
  value: string;
  createdAt: Date;
  updatedAt: Date;
}

interface TrackStats {
  topTracks: Array<{
    youtubeId: string;
    title: string;
    artist: string | null;
    userId: string;
    _count: number;
  }>;
  totalPlays: number;
}

/**
 * @swagger
 * /api/admin/users:
 *   get:
 *     summary: Get all users
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of all users
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/User'
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Requires admin role
 */
router.get('/users', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const users = await prisma.user.findMany({
      include: {
        roles: true
      }
    });

    res.json(users.map((user: any) => ({
      id: user.id,
      username: user.username,
      roles: user.roles.map((role: { name: string }) => role.name)
    })));
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/admin/roles:
 *   get:
 *     summary: Get all roles
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of all roles
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Role'
 */
router.get('/roles', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const roles = await Cache.getRoles();
    res.json(roles);
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/admin/roles:
 *   post:
 *     summary: Create a new role
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: 
 *                 type: string
 *               permissions:
 *                 type: array
 *                 items:
 *                   type: string
 */
router.post('/roles', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, permissions } = req.body;

    if (!name) {
      throw new HTTPError(400, 'Role name is required');
    }

    const role = await prisma.role.create({
      data: {
        name,
        permissions: permissions || []
      }
    });

    await Cache.invalidateRoles();
    res.status(201).json(role);
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/admin/roles/{id}:
 *   put:
 *     summary: Update a role
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 */
router.put('/roles/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { permissions } = req.body;

    const role = await prisma.role.update({
      where: { id },
      data: { permissions }
    });

    await Cache.invalidateRoles();
    res.json(role);
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/admin/roles/{id}:
 *   delete:
 *     summary: Delete a role
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 */
router.delete('/roles/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    await prisma.role.delete({ where: { id } });
    await Cache.invalidateRoles();
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/admin/users/{id}/roles:
 *   put:
 *     summary: Update user roles
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 */
router.put('/users/:id/roles', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { roles } = req.body as { roles: string[] };

    const user = await prisma.user.update({
      where: { id },
      data: {
        roles: {
          set: roles.map(name => ({ name }))
        }
      },
      include: {
        roles: true
      }
    });

    await Cache.invalidateUser(id);
    res.json({
      ...user,
      roles: user.roles.map((role: RoleData) => role.name)
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/admin/settings:
 *   get:
 *     summary: Get bot settings
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 */
router.get('/settings', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const settings = await Cache.getSettings();
    res.json(settings);
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/admin/settings:
 *   put:
 *     summary: Update bot settings
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 */
router.put('/settings', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const settings = req.body as SettingsObject;

    await Promise.all(
      Object.entries(settings).map(([key, value]) =>
        prisma.setting.upsert({
          where: { key },
          update: { value: String(value) },
          create: { key, value: String(value) }
        })
      )
    );

    await Cache.invalidateSettings();
    res.json(settings);
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/admin/stats:
 *   get:
 *     summary: Get server statistics
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 */
router.get('/stats', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const stats = await Cache.getTrackStats() as TrackStats | null;
    if (!stats) {
      throw new HTTPError(500, 'Failed to fetch stats');
    }

    const userIds = stats.topTracks.map(track => track.userId);
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      include: { roles: true }
    });

    const response: StatsResponse = {
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      cpuUsage: process.cpuUsage(),
      stats: {
        totalUsers: await prisma.user.count(),
        totalPlays: stats.totalPlays,
        topTracks: stats.topTracks.map(track => ({
          title: track.title,
          artist: track.artist,
          plays: track._count
        })),
        topRequesters: stats.topTracks.map(track => {
          const user = users.find((u: { id: string; username: string }) => u.id === track.userId);
          return {
            username: user?.username || 'Unknown User',
            requests: track._count
          };
        })
      }
    };

    res.json(response);
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/admin/recommendations/refresh:
 *   post:
 *     summary: Force refresh of YouTube recommendations pool
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Recommendations pool refreshed successfully
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
router.post('/recommendations/refresh', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Call the enhanced recommendation refresh function
    await refreshYoutubeRecommendationsPool();
    
    return res.json({ 
      success: true, 
      message: 'YouTube recommendations pool refresh triggered successfully' 
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/admin/recommendations/test:
 *   post:
 *     summary: Test YouTube recommendations with a specific video ID
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               videoId:
 *                 type: string
 *                 description: YouTube video ID to test recommendations for
 *             required:
 *               - videoId
 *     responses:
 *       200:
 *         description: Recommendations retrieved successfully
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
router.post('/recommendations/test', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Extract videoId from request body
    const { videoId } = req.body;
    
    if (!videoId || typeof videoId !== 'string') {
      throw new HTTPError(400, 'Valid videoId is required');
    }
    
    console.log(`Testing YouTube recommendations for video ID: ${videoId}`);
    
    // Import the YouTube utilities
    const { getYoutubeRecommendations } = await import('../utils/youtube');
    
    // Get recommendations
    const recommendations = await getYoutubeRecommendations(videoId);
    
    return res.json({
      success: true,
      videoId,
      count: recommendations.length,
      recommendations
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @swagger
 * /api/admin/recommendations/cleanup:
 *   post:
 *     summary: Clean up excess YouTube recommendations
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               maxPerSeed:
 *                 type: integer
 *                 description: Maximum number of recommendations to keep per seed track
 *                 default: 5
 *     responses:
 *       200:
 *         description: Excess recommendations cleaned up successfully
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
router.post('/recommendations/cleanup', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const maxPerSeed = req.body.maxPerSeed || 5;
    
    // Call the cleanup function
    const removedCount = await cleanupExcessRecommendations(maxPerSeed);
    
    // Reset the player's recommendation pool
    const player = getPlayer();
    if (typeof player.resetRecommendationsPool === 'function') {
      await player.resetRecommendationsPool();
    }
    
    return res.json({ 
      success: true, 
      message: `YouTube recommendations cleanup complete. Removed ${removedCount} excess recommendations.`,
      removedCount
    });
  } catch (error) {
    next(error);
  }
});

export { router as adminRouter };

 