// Use ES module syntax
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Get API base URL from environment
const API_BASE_URL = process.env.API_URL || 'http://localhost:3000';

async function main() {
  try {
    console.log('Starting thumbnail URL update...');
    
    // Count tracks before update
    const trackCount = await prisma.track.count();
    console.log(`Found ${trackCount} tracks in database`);
    
    // Find tracks with hardcoded URLs
    const hardcodedTracks = await prisma.track.findMany({
      where: {
        thumbnail: {
          contains: 'http://localhost:3000'
        }
      }
    });
    
    console.log(`Found ${hardcodedTracks.length} tracks with hardcoded localhost URLs`);
    
    // Update all tracks to use the API_BASE_URL
    const updatedCount = await prisma.track.updateMany({
      where: {
        thumbnail: {
          contains: 'http://localhost:3000'
        }
      },
      data: {
        thumbnail: {
          set: undefined // This will be replaced in the next step
        }
      }
    });
    
    console.log(`Reset ${updatedCount.count} tracks with hardcoded URLs`);
    
    // Now update each track individually with the correct URL
    let successCount = 0;
    for (const track of hardcodedTracks) {
      try {
        await prisma.track.update({
          where: { youtubeId: track.youtubeId },
          data: {
            thumbnail: `${API_BASE_URL}/api/albumart/${track.youtubeId}`
          }
        });
        successCount++;
      } catch (error) {
        console.error(`Failed to update track ${track.youtubeId}:`, error);
      }
    }
    
    console.log(`Successfully updated ${successCount} tracks with new API_BASE_URL`);
    
    // Option to purge all thumbnails and reset them
    const shouldPurgeAll = process.argv.includes('--purge-all');
    
    if (shouldPurgeAll) {
      console.log('Purging ALL thumbnail URLs...');
      
      // Get all tracks
      const allTracks = await prisma.track.findMany({
        select: { youtubeId: true }
      });
      
      console.log(`Updating all ${allTracks.length} tracks with new API_BASE_URL`);
      
      // Update each track with the correct URL format
      let purgeSuccessCount = 0;
      for (const track of allTracks) {
        try {
          await prisma.track.update({
            where: { youtubeId: track.youtubeId },
            data: {
              thumbnail: `${API_BASE_URL}/api/albumart/${track.youtubeId}`
            }
          });
          purgeSuccessCount++;
          
          // Log progress every 100 tracks
          if (purgeSuccessCount % 100 === 0) {
            console.log(`Progress: ${purgeSuccessCount}/${allTracks.length} tracks updated`);
          }
        } catch (error) {
          console.error(`Failed to update track ${track.youtubeId}:`, error);
        }
      }
      
      console.log(`Successfully updated ${purgeSuccessCount} tracks with new API_BASE_URL`);
    }
    
    console.log('Thumbnail URL update completed!');
  } catch (error) {
    console.error('Error updating thumbnail URLs:', error);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
}); 