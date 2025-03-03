import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Load environment variables from .env file
const rootEnvPath = path.resolve(process.cwd(), '../../.env');
const localEnvPath = path.resolve(process.cwd(), '../.env');
const envPath = fs.existsSync(rootEnvPath) ? rootEnvPath : localEnvPath;

console.log('Loading environment from:', envPath);
dotenv.config({ path: envPath });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function applyMigration() {
  // Verify DATABASE_URL is set
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL environment variable is not set!');
    console.log('Available environment variables:', Object.keys(process.env).join(', '));
    process.exit(1);
  }
  
  console.log('Using DATABASE_URL:', process.env.DATABASE_URL);
  
  const prisma = new PrismaClient();
  
  try {
    console.log('Applying manual migration to make thumbnail field optional...');
    
    // Read the SQL migration file
    const migrationPath = path.join(__dirname, '../prisma/migrations/manual_make_thumbnail_optional.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');
    
    // Execute the SQL directly
    await prisma.$executeRawUnsafe(sql);
    
    console.log('Migration applied successfully!');
  } catch (error) {
    console.error('Error applying migration:', error);
  } finally {
    await prisma.$disconnect();
  }
}

applyMigration();