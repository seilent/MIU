import { prisma } from '../src/db';

/**
 * This script identifies and removes duplicate YouTube recommendations
 * before applying the unique constraint migration.
 */
async function main() {
  try {
    console.log('Starting duplicate recommendations cleanup...');
    
    // Find all seed track IDs
    const seedTracks = await prisma.$queryRaw<Array<{seedTrackId: string}>>`
      SELECT DISTINCT "seedTrackId" FROM "YoutubeRecommendation"
    `;
    
    console.log(`Found ${seedTracks.length} seed tracks to process`);
    
    let totalDuplicatesRemoved = 0;
    
    // Process each seed track
    for (const { seedTrackId } of seedTracks) {
      // Find duplicate recommendations for this seed track
      const duplicates = await prisma.$queryRaw<Array<{youtubeId: string, count: number}>>`
        SELECT "youtubeId", COUNT(*) as count
        FROM "YoutubeRecommendation"
        WHERE "seedTrackId" = ${seedTrackId}
        GROUP BY "youtubeId"
        HAVING COUNT(*) > 1
      `;
      
      if (duplicates.length > 0) {
        console.log(`Found ${duplicates.length} duplicate recommendation sets for seed track ${seedTrackId}`);
        
        // Process each duplicate set
        for (const { youtubeId, count } of duplicates) {
          // Keep the most recent record and delete the rest
          const records = await prisma.youtubeRecommendation.findMany({
            where: {
              seedTrackId,
              youtubeId
            },
            orderBy: {
              createdAt: 'desc'
            }
          });
          
          // Skip the first (most recent) record
          const recordsToDelete = records.slice(1);
          
          if (recordsToDelete.length > 0) {
            // Delete the duplicate records
            await prisma.youtubeRecommendation.deleteMany({
              where: {
                id: {
                  in: recordsToDelete.map(r => r.id)
                }
              }
            });
            
            console.log(`Removed ${recordsToDelete.length} duplicates for youtubeId ${youtubeId}`);
            totalDuplicatesRemoved += recordsToDelete.length;
          }
        }
      }
    }
    
    console.log(`Cleanup complete! Removed ${totalDuplicatesRemoved} duplicate recommendations.`);
    console.log('You can now safely apply the migration to add the unique constraint.');
  } catch (error) {
    console.error('Error during cleanup:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main(); 