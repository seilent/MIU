import { PrismaClient } from '@prisma/client';
import * as path from 'path';
import * as dotenv from 'dotenv';

// Load environment variables from .env.development
const envPath = path.resolve(process.cwd(), '.env.development');
dotenv.config({ path: envPath });

const prisma = new PrismaClient();

async function main() {
  try {
    // Get a sample of tracks
    const tracks = await prisma.track.findMany({
      take: 5
    });
    
    console.log('Sample tracks:');
    tracks.forEach(track => {
      console.log(`- ${track.title} (${track.youtubeId}): ${track.thumbnail}`);
    });
    
    // Get a sample of playlist tracks
    const playlists = await prisma.defaultPlaylist.findMany({
      take: 1,
      include: {
        tracks: {
          take: 5,
          include: {
            track: true
          }
        }
      }
    });
    
    console.log('\nSample playlist tracks:');
    playlists.forEach(playlist => {
      console.log(`Playlist: ${playlist.name}`);
      playlist.tracks.forEach(playlistTrack => {
        console.log(`- ${playlistTrack.track.title} (${playlistTrack.track.youtubeId}): ${playlistTrack.track.thumbnail}`);
      });
    });
    
  } catch (error) {
    console.error('Error checking sample tracks:', error);
  } finally {
    await prisma.$disconnect();
  }
}

main(); 