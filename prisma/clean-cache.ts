import { prisma } from '../src/backend/db';

async function cleanCache() {
  try {
    // Delete all cache entries using raw SQL
    await prisma.$transaction([
      prisma.$executeRaw`TRUNCATE TABLE "AudioCache" CASCADE`,
      prisma.$executeRaw`TRUNCATE TABLE "ThumbnailCache" CASCADE`,
      prisma.$executeRaw`TRUNCATE TABLE "Request" CASCADE`,
      prisma.$executeRaw`TRUNCATE TABLE "UserTrackStats" CASCADE`,
      prisma.$executeRaw`TRUNCATE TABLE "Track" CASCADE`
    ]);

    console.log('Successfully cleaned cache');
  } catch (error) {
    console.error('Error cleaning cache:', error);
  } finally {
    await prisma.$disconnect();
  }
}

cleanCache(); 