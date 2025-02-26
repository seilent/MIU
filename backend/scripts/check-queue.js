import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkQueue() {
  try {
    // Check current track
    const currentTrack = await prisma.request.findFirst({
      where: { status: 'PLAYING' },
      include: { track: true }
    });
    console.log('Current Track:', JSON.stringify(currentTrack, null, 2));

    // Check queued tracks
    const queuedTracks = await prisma.request.findMany({
      where: { status: 'QUEUED' },
      include: { track: true }
    });
    console.log('Queued Tracks:', JSON.stringify(queuedTracks, null, 2));

    // Check active playlist
    const activePlaylist = await prisma.defaultPlaylist.findFirst({
      where: { active: true },
      include: { tracks: { include: { track: true } } }
    });
    console.log('Active Playlist:', JSON.stringify(activePlaylist, null, 2));

    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

checkQueue(); 