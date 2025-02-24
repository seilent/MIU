import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  try {
    console.log('Checking for hardcoded URLs in the database...');
    
    // Check Track table
    const hardcodedTracks = await prisma.track.findMany({
      where: {
        OR: [
          { thumbnail: { contains: 'localhost' } },
          { thumbnail: { contains: 'sv-miu.gacha.boo' } },
          { thumbnail: { contains: 'http://' } },
          { thumbnail: { contains: 'https://' } }
        ]
      },
      select: {
        youtubeId: true,
        title: true,
        thumbnail: true
      }
    });
    
    console.log(`\n=== Tracks with hardcoded URLs: ${hardcodedTracks.length} ===`);
    hardcodedTracks.forEach(track => {
      console.log(`- ${track.youtubeId} (${track.title}): ${track.thumbnail}`);
    });
    
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
      
      const hardcodedPlaylistTracks = tracks.filter(pt => 
        pt.track.thumbnail.includes('localhost') || 
        pt.track.thumbnail.includes('sv-miu.gacha.boo') ||
        (pt.track.thumbnail.includes('http://') && !pt.track.thumbnail.includes('/api/albumart/')) ||
        (pt.track.thumbnail.includes('https://') && !pt.track.thumbnail.includes('/api/albumart/'))
      );
      
      if (hardcodedPlaylistTracks.length > 0) {
        console.log(`\nPlaylist "${playlist.name}" has ${hardcodedPlaylistTracks.length} tracks with hardcoded URLs:`);
        hardcodedPlaylistTracks.forEach(pt => {
          console.log(`- ${pt.track.youtubeId} (${pt.track.title}): ${pt.track.thumbnail}`);
        });
      }
    }
    
    // Check for any other tables that might have URL fields
    // This is a more generic approach to find potential hardcoded URLs
    
    console.log('\n=== Summary ===');
    console.log(`Total tracks with hardcoded URLs: ${hardcodedTracks.length}`);
    
    if (hardcodedTracks.length === 0) {
      console.log('No hardcoded URLs found in the database!');
    } else {
      console.log('To fix these issues, run the update-thumbnails.ts script with --purge-all flag');
    }
    
  } catch (error) {
    console.error('Error checking for hardcoded URLs:', error);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
}); 