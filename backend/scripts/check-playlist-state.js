import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkPlaylistState() {
  try {
    // Check active playlists
    const activePlaylists = await prisma.defaultPlaylist.findMany({
      where: { active: true },
      include: {
        tracks: {
          include: { track: true }
        }
      }
    });
    
    console.log('Active Playlists:', JSON.stringify(activePlaylists, null, 2));

    // Check requests in the last hour
    const recentRequests = await prisma.request.findMany({
      where: {
        requestedAt: {
          gte: new Date(Date.now() - 60 * 60 * 1000) // Last hour
        }
      },
      include: {
        track: true,
        user: true
      },
      orderBy: {
        requestedAt: 'desc'
      }
    });

    console.log('Recent Requests:', JSON.stringify(recentRequests, null, 2));

    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

checkPlaylistState(); 