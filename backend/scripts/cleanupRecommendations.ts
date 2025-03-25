5VxFoRLlUzA5VxFoRLlUzAimport { cleanupExcessRecommendations } from '../src/utils/youtube';
import { prisma } from '../src/db';

async function main() {
  try {
    console.log('Starting YouTube recommendations cleanup...');
    
    // Default to 5 recommendations per seed track, but allow override via command line argument
    const maxPerSeed = process.argv[2] ? parseInt(process.argv[2], 10) : 5;
    
    if (isNaN(maxPerSeed) || maxPerSeed < 1) {
      console.error('Invalid maxPerSeed value. Please provide a positive integer.');
      process.exit(1);
    }
    
    console.log(`Keeping maximum of ${maxPerSeed} recommendations per seed track`);
    
    // Run the cleanup
    const removedCount = await cleanupExcessRecommendations(maxPerSeed);
    
    console.log(`Cleanup complete! Removed ${removedCount} excess recommendations.`);
  } catch (error) {
    console.error('Error during cleanup:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main(); 