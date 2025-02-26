import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function activatePlaylist() {
  try {
    // Activate the playlist
    await prisma.defaultPlaylist.update({
      where: { id: 'cm7ky40d60000jpsujbkfetac' },
      data: { 
        active: true,
        mode: 'POOL' // Set to POOL mode for better variety
      }
    });
    
    console.log('Playlist activated successfully');
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

activatePlaylist(); 