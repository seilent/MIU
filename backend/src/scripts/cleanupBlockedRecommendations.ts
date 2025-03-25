import { prisma } from '../db';
import { TrackStatus } from '@prisma/client';

async function cleanupBlockedRecommendations() {
  console.log('Starting cleanup of blocked recommendations...');
  
  // Get all blocked track IDs
  const blockedTracks = await prisma.track.findMany({
    where: {
      status: TrackStatus.BLOCKED
    },
    select: {
      youtubeId: true
    }
  });
  
  const blockedTrackIds = blockedTracks.map(track => track.youtubeId);
  console.log(`Found ${blockedTrackIds.length} blocked tracks`);

  // Delete recommendations where either the seed or the recommendation is blocked
  const deletedRecommendations = await prisma.youtubeRecommendation.deleteMany({
    where: {
      OR: [
        { seedTrackId: { in: blockedTrackIds } },
        { youtubeId: { in: blockedTrackIds } }
      ]
    }
  });

  console.log(`Deleted ${deletedRecommendations.count} recommendations that referenced blocked tracks`);
}

// Run the cleanup
cleanupBlockedRecommendations()
  .catch(console.error)
  .finally(() => prisma.$disconnect()); 