import { PrismaClient, RequestStatus } from '@prisma/client';

const prisma = new PrismaClient();

async function cleanupStates() {
  try {
    // Reset any PLAYING or PENDING states to EXPIRED
    const playingResult = await prisma.trackState.updateMany({
      where: {
        status: {
          in: [RequestStatus.PLAYING, RequestStatus.PENDING]
        }
      },
      data: {
        status: RequestStatus.EXPIRED,
        lastUpdated: new Date()
      }
    });

    // Reset any QUEUED states that are older than 10 minutes
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const queuedResult = await prisma.trackState.updateMany({
      where: {
        status: RequestStatus.QUEUED,
        queuedAt: {
          lt: tenMinutesAgo
        }
      },
      data: {
        status: RequestStatus.EXPIRED,
        lastUpdated: new Date()
      }
    });

    // Reset completed tracks that are causing cooldown issues
    const completedResult = await prisma.trackState.updateMany({
      where: {
        status: RequestStatus.COMPLETED,
        playedAt: {
          gte: new Date(Date.now() - 5 * 60 * 60 * 1000) // Last 5 hours
        }
      },
      data: {
        status: RequestStatus.EXPIRED,
        lastUpdated: new Date(),
        playedAt: new Date(0) // Set to epoch to clear cooldown
      }
    });

    console.log('✨ Cleanup Results:');
    console.log(`- Reset ${playingResult.count} PLAYING/PENDING states to EXPIRED`);
    console.log(`- Reset ${queuedResult.count} old QUEUED states to EXPIRED`);
    console.log(`- Reset ${completedResult.count} recent COMPLETED states to clear cooldowns`);

    process.exit(0);
  } catch (error) {
    console.error('Error cleaning up states:', error);
    process.exit(1);
  }
}

cleanupStates(); 