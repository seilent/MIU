// ES module script
import { PrismaClient } from '@prisma/client';
import * as path from 'path';
import * as dotenv from 'dotenv';

// Load environment variables from .env.development
const envPath = path.resolve(process.cwd(), '.env.development');
dotenv.config({ path: envPath });

const prisma = new PrismaClient();
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';

async function main() {
  try {
    // Count total tracks
    const totalTracks = await prisma.track.count();
    console.log(`Total tracks in database: ${totalTracks}`);
    
    // Check if we should purge all thumbnails
    const shouldPurgeAll = process.argv.includes('--purge-all');
    
    if (shouldPurgeAll) {
      console.log('Purging all thumbnails...');
      
      // Update all tracks
      let updatedCount = 0;
      const batchSize = 100;
      
      for (let i = 0; i < totalTracks; i += batchSize) {
        const tracks = await prisma.track.findMany({
          take: batchSize,
          skip: i,
          select: { youtubeId: true }
        });
        
        for (const track of tracks) {
          await prisma.track.update({
            where: { youtubeId: track.youtubeId },
            data: {
              thumbnail: `${API_BASE_URL}/api/albumart/${track.youtubeId}`
            }
          });
          
          updatedCount++;
          if (updatedCount % 100 === 0) {
            console.log(`Updated ${updatedCount}/${totalTracks} tracks...`);
          }
        }
      }
      
      console.log(`Updated all ${updatedCount} tracks with new thumbnail URLs.`);
      
      // No need to update DefaultPlaylistTrack entries as they reference the Track model
      console.log('\nDefaultPlaylistTrack entries use the thumbnail from the Track model, so they are automatically updated.');
    } else {
      // Only update tracks with hardcoded URLs
      const tracksWithHardcodedUrls = await prisma.track.findMany({
        where: {
          OR: [
            { thumbnail: { contains: 'localhost' } },
            { thumbnail: { contains: 'sv-miu.gacha.boo' } },
            { thumbnail: { contains: 'http://' } },
            { thumbnail: { contains: 'https://' } },
          ]
        },
        select: {
          youtubeId: true,
          title: true,
          thumbnail: true
        }
      });
      
      console.log(`Found ${tracksWithHardcodedUrls.length} tracks with hardcoded URLs.`);
      
      let updatedCount = 0;
      for (const track of tracksWithHardcodedUrls) {
        const newThumbnail = `${API_BASE_URL}/api/albumart/${track.youtubeId}`;
        
        await prisma.track.update({
          where: { youtubeId: track.youtubeId },
          data: { thumbnail: newThumbnail }
        });
        
        console.log(`Updated: ${track.title} (${track.youtubeId})`);
        console.log(`  Old: ${track.thumbnail}`);
        console.log(`  New: ${newThumbnail}`);
        
        updatedCount++;
        if (updatedCount % 10 === 0) {
          console.log(`Updated ${updatedCount}/${tracksWithHardcodedUrls.length} tracks...`);
        }
      }
      
      console.log(`\nSummary:`);
      console.log(`- Updated ${updatedCount} tracks with new thumbnail URLs.`);
      
      if (updatedCount === 0) {
        console.log('No hardcoded URLs found in the database.');
      }
    }
    
  } catch (error) {
    console.error('Error updating thumbnails:', error);
  } finally {
    await prisma.$disconnect();
  }
}

main(); 