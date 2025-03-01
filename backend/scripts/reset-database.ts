import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import * as dotenv from 'dotenv';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');

// Load environment variables
const envPath = path.join(rootDir, '.env');
const devEnvPath = path.join(rootDir, '.env.development');

if (fs.existsSync(devEnvPath)) {
  console.log('Loading development environment variables...');
  dotenv.config({ path: devEnvPath });
} else if (fs.existsSync(envPath)) {
  console.log('Loading production environment variables...');
  dotenv.config({ path: envPath });
} else {
  console.error('No .env file found!');
  process.exit(1);
}

async function resetDatabase() {
  console.log('Starting database reset...');
  
  try {
    // Drop the database schema
    console.log('Dropping database schema...');
    const prisma = new PrismaClient();
    
    // Get all table names from the database
    const tableNames = await prisma.$queryRaw<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public'
    `;
    
    // Disable foreign key checks and truncate all tables
    await prisma.$executeRaw`SET session_replication_role = 'replica';`;
    
    for (const { tablename } of tableNames) {
      if (tablename !== '_prisma_migrations') {
        await prisma.$executeRawUnsafe(`TRUNCATE TABLE "public"."${tablename}" CASCADE;`);
        console.log(`Truncated table: ${tablename}`);
      }
    }
    
    // Re-enable foreign key checks
    await prisma.$executeRaw`SET session_replication_role = 'origin';`;
    
    await prisma.$disconnect();
    
    // Run migrations to recreate the schema
    console.log('Reapplying migrations...');
    execSync('npx prisma migrate deploy', { 
      cwd: rootDir,
      stdio: 'inherit'
    });
    
    // Clear cache directories
    console.log('Clearing cache directories...');
    try {
      execSync('mkdir -p cache/albumart cache/thumbnails cache/audio', { 
        cwd: rootDir,
        stdio: 'inherit'
      });
      execSync('rm -rf cache/albumart/* cache/thumbnails/* cache/audio/*', { 
        cwd: rootDir,
        stdio: 'inherit'
      });
    } catch (error) {
      console.warn('Warning: Could not clear cache directories. They may not exist or may be empty.');
    }
    
    console.log('Database reset completed successfully!');
  } catch (error) {
    console.error('Error resetting database:', error);
    process.exit(1);
  }
}

resetDatabase(); 