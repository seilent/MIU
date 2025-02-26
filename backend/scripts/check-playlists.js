import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkPlaylists() {
  try {
    // Get all playlists
    const playlists = await prisma.defaultPlaylist.findMany({
      include: {
        tracks: {
          include: { track: true }
        }
      }
    });
    
    console.log('All Playlists:', JSON.stringify(playlists, null, 2));
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

checkPlaylists(); 