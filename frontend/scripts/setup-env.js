const fs = require('fs');
const path = require('path');

// Get paths
const rootEnvPath = path.join(__dirname, '../../.env.local');
const frontendEnvPath = path.join(__dirname, '../.env.local');

// Check if root .env.local exists
if (!fs.existsSync(rootEnvPath)) {
  console.error('Error: Root .env.local file not found at', rootEnvPath);
  process.exit(1);
}

// Copy file
try {
  fs.copyFileSync(rootEnvPath, frontendEnvPath);
  console.log('Successfully copied .env.local from root to frontend directory');
} catch (err) {
  console.error('Error copying .env.local file:', err);
  process.exit(1);
} 