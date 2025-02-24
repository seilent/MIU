import { PrismaClient } from '@prisma/client';

// Create a singleton instance of PrismaClient
const prisma = new PrismaClient({
  log: ['error', 'warn'],
});

// Ensure the client is properly closed when the app exits
process.on('beforeExit', async () => {
  await prisma.$disconnect();
});

export { prisma }; 