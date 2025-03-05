import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  try {
    console.log('Checking for hardcoded URLs in the database...');
    
    // Check Track table
    const hardcodedTracks = await prisma.track.findMany({
      select: {
        youtubeId: true,
        title: true
      }
    });
    
    console.log(`\n=== Tracks in database: ${hardcodedTracks.length} ===`);
    console.log('Note: The thumbnail field has been removed from the Track model.');
    console.log('Thumbnails are now generated dynamically using the getThumbnailUrl function.');
    
    // Check DefaultPlaylist table
    const playlists = await prisma.defaultPlaylist.findMany({
      select: {
        id: true,
        name: true
      }
    });
    
    console.log(`\n=== Checking DefaultPlaylistTrack entries ===`);
    for (const playlist of playlists) {
      const tracks = await prisma.defaultPlaylistTrack.findMany({
        where: {
          playlistId: playlist.id
        },
        include: {
          track: true
        }
      });
      
      console.log(`\nPlaylist "${playlist.name}" has ${tracks.length} tracks.`);
      console.log('Note: The thumbnail field has been removed from the Track model.');
      console.log('Thumbnails are now generated dynamically using the getThumbnailUrl function.');
      
      // No need to check for hardcoded URLs since thumbnails are now generated dynamically
    }
    
    // Check for any other tables that might have URL fields
    // This is a more generic approach to find potential hardcoded URLs
    
    console.log('\n=== Summary ===');
    console.log(`