import { spawn } from 'child_process';
import * as path from 'path';
import * as url from 'url';
import * as fs from 'fs';

// Get current file directory in ESM
const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to the update script
const UPDATE_SCRIPT_PATH = path.resolve(__dirname, './update-yt-dlp.ts');

// Flag to prevent multiple simultaneous updates
let isUpdating = false;

/**
 * Handles yt-dlp errors and initiates an update if needed
 * @param error The error object from the download attempt
 * @returns Promise that resolves to true if update was attempted, false otherwise
 */
export async function handleYtDlpError(error: any): Promise<boolean> {
  // Check if the error message indicates a format issue
  const errorStr = error?.stderr || error?.message || '';
  
  if (
    !isUpdating && 
    errorStr.includes('Requested format is not available')
  ) {
    console.log('Detected "Requested format is not available" error, attempting to update yt-dlp...');
    
    isUpdating = true;
    
    return new Promise<boolean>((resolve) => {
      // Make sure the update script exists
      if (!fs.existsSync(UPDATE_SCRIPT_PATH)) {
        console.error(`Update script not found at ${UPDATE_SCRIPT_PATH}`);
        isUpdating = false;
        resolve(false);
        return;
      }
      
      console.log(`Running update script: ${UPDATE_SCRIPT_PATH}`);
      
      // Execute the update script
      const process = spawn('npx', ['tsx', UPDATE_SCRIPT_PATH], {
        stdio: ['ignore', 'pipe', 'pipe']
      });
      
      let stdout = '';
      let stderr = '';
      
      process.stdout.on('data', (data) => {
        const chunk = data.toString();
        stdout += chunk;
        console.log(`[yt-dlp-update] ${chunk.trim()}`);
      });
      
      process.stderr.on('data', (data) => {
        const chunk = data.toString();
        stderr += chunk;
        console.error(`[yt-dlp-update] ${chunk.trim()}`);
      });
      
      process.on('close', (code) => {
        isUpdating = false;
        
        if (code === 0) {
          console.log('yt-dlp update completed successfully');
          resolve(true);
        } else {
          console.error(`yt-dlp update failed with code ${code}`);
          console.error('Error output:', stderr);
          resolve(false);
        }
      });
    });
  }
  
  return false;
}

/**
 * Check if current yt-dlp is working properly
 * @returns Promise that resolves to true if working, false otherwise
 */
export async function checkYtDlpWorking(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const process = spawn('npx', ['tsx', UPDATE_SCRIPT_PATH], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    process.on('close', (code) => {
      resolve(code === 0);
    });
  });
} 