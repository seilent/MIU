import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { RequestStatus } from '@prisma/client';
import type { Request as PrismaRequest, Track, User } from '@prisma/client';

const router = Router();

// Apply auth middleware to all routes
router.use(authMiddleware);

/**
 * @swagger
 * /api/history:
 *   get:
 *     summary: Get track history
 *     tags: [History]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Number of tracks to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Number of tracks to skip
 *       - in: query
 *         name: userId
 *         schema:
 *           type: string
 *         description: Filter by user ID
 *     responses:
 *       200:
 *         description: Track history retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 tracks:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       youtubeId:
 *                         type: string
 *                       title:
 *                         type: string
 *                       artist:
 *                         type: string
 *                       thumbnail:
 *                         type: string
 *                       duration:
 *                         type: integer
 *                       requestedBy:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: string
 *                           username:
 *                             type: string
 *                           avatar:
 *                             type: string
 *                       requestedAt:
 *                         type: string
 *                         format: date-time
 *                       playedAt:
 *                         type: string
 *                         format: date-time
 *                 total:
 *                   type: integer
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const offset = parseInt(req.query.offset as string) || 0;
    const userId = req.query.userId as string;

    // Build where clause
    const where = {
      status: RequestStatus.COMPLETED,
      ...(userId ? { userId } : {}),
    };

    // Get tracks and total count
    const [tracks, total] = await Promise.all([
      prisma.request.findMany({
        where,
        orderBy: {
          playedAt: 'desc',
        },
        include: {
          user: true,
          track: true,
        },
        take: limit,
        skip: offset,
      }),
      prisma.request.count({ where }),
    ]);

    // Transform data for response
    const formattedTracks = tracks.map((request: PrismaRequest & { 
      user: User;
      track: Track;
    }) => ({
      youtubeId: request.track.youtubeId,
      title: request.track.title,
      thumbnail: request.track.thumbnail,
      duration: request.track.duration,
      requestedBy: {
        id: request.user.id,
        username: request.user.username,
        avatar: request.user.avatar,
      },
      requestedAt: request.requestedAt,
      playedAt: request.playedAt,
    }));

    res.json({
      tracks: formattedTracks,
      total,
    });
  } catch (error) {
    next(error);
  }
});

export default router; 