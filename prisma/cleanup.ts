import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function cleanup() {
  try {
    console.log('Starting database cleanup...');

    // Update all statuses to match the enum values using raw SQL
    await prisma.$executeRaw`UPDATE "Request" SET status = 'PLAYING' WHERE status = 'playing'`;
    await prisma.$executeRaw`UPDATE "Request" SET status = 'QUEUED' WHERE status = 'queued'`;
    await prisma.$executeRaw`UPDATE "Request" SET status = 'COMPLETED' WHERE status = 'completed'`;
    await prisma.$executeRaw`UPDATE "Request" SET status = 'DOWNLOADING' WHERE status = 'downloading'`;
    await prisma.$executeRaw`UPDATE "Request" SET status = 'SKIPPED' WHERE status = 'skipped'`;
    await prisma.$executeRaw`UPDATE "Request" SET status = 'PENDING' WHERE status = 'pending'`;

    console.log('Database cleanup completed successfully');
  } catch (error) {
    console.error('Error during cleanup:', error);
  } finally {
    await prisma.$disconnect();
  }
}

cleanup(); 