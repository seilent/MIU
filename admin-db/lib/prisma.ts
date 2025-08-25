import { PrismaClient } from '@prisma/client'

// PrismaClient is only compatible with Node.js environments
if (typeof window !== 'undefined') {
  throw new Error('PrismaClient cannot be used in browser environments')
}

// Node.js environment - use global for caching
const globalWithPrisma = global as typeof globalThis & {
  prisma?: PrismaClient
}

const prisma = globalWithPrisma.prisma || new PrismaClient()

if (process.env.NODE_ENV !== 'production') {
  globalWithPrisma.prisma = prisma
}

export default prisma
