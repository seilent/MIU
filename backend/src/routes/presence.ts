import { Router, Request, Response } from 'express';
import { prisma } from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import type { User, Prisma } from '@prisma/client';
import logger from '../utils/logger.js';
import { getPlayer } from '../discord/player.js';

interface WebPresenceWithUser {
  userId: string;
  lastSeen: Date;
  user: {
    username: string;
    avatar: string | null;
  };
}

const router = Router();

// Apply auth middleware to all routes
router.use(authMiddleware);

/**
 * @swagger
 * /api/presence/heartbeat:
 *   post:
 *     summary: Update user's web presence heartbeat
 *     tags: [Presence]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Heartbeat updated successfully
 *       401:
 *         description: Unauthorized
 */
router.post('/heartbeat', async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const keepPlaying = req.headers['x-keep-playing'] === 'true';
    const player = getPlayer();

    // Check if this is a new presence or update
    const existingPresence = await prisma.webPresence.findUnique({
      where: { userId },
      include: { user: true }
    });

    // Update or create web presence record
    await prisma.webPresence.upsert({
      where: { userId },
      create: {
        userId,
        lastSeen: new Date()
      },
      update: {
        lastSeen: new Date()
      }
    });

    // Only log new web user joins or state changes
    if (!existingPresence) {
      logger.info(`🌐 Web user joined: ${existingPresence?.user?.username || userId}`);
    }

    // Update player web presence
    if (keepPlaying && player.hasCurrentTrack()) {
      player.setWebPresence(true);
    } else {
      player.setWebPresence(false);
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Error updating web presence:', error);
    res.status(500).json({ error: 'Failed to update web presence' });
  }
});

/**
 * @swagger
 * /api/presence/active:
 *   get:
 *     summary: Get list of currently active web users
 *     tags: [Presence]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of active users
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   userId:
 *                     type: string
 *                   username:
 *                     type: string
 *                   avatar:
 *                     type: string
 *                   lastSeen:
 *                     type: string
 *                     format: date-time
 */
router.get('/active', async (_req: Request, res: Response) => {
  try {
    // Get users seen in the last 5 minutes
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    
    // First get previously active users
    const previouslyActive = await prisma.webPresence.findMany({
      include: {
        user: {
          select: {
            username: true,
            avatar: true
          }
        }
      }
    }) as WebPresenceWithUser[];

    // Then get currently active users
    const activeUsers = await prisma.webPresence.findMany({
      where: {
        lastSeen: {
          gte: fiveMinutesAgo
        }
      },
      include: {
        user: {
          select: {
            username: true,
            avatar: true
          }
        }
      }
    }) as WebPresenceWithUser[];

    // Log users who have become inactive
    const nowInactive = previouslyActive.filter(
      (prev: WebPresenceWithUser) => !activeUsers.find((active: WebPresenceWithUser) => active.userId === prev.userId)
    );
    
    for (const inactive of nowInactive) {
      logger.info(`🌐 Web user left: ${inactive.user.username || inactive.userId}`);
      // Clean up inactive presence records
      await prisma.webPresence.delete({
        where: { userId: inactive.userId }
      });
    }

    res.json(activeUsers.map((presence: WebPresenceWithUser) => ({
      userId: presence.userId,
      username: presence.user.username,
      avatar: presence.user.avatar,
      lastSeen: presence.lastSeen
    })));
  } catch (error) {
    console.error('Error getting active users:', error);
    res.status(500).json({ error: 'Failed to get active users' });
  }
});

export default router; 