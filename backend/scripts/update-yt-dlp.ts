#!/usr/bin/env tsx

import { spawn, exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as url from 'url';
import * as util from 'util';

const execPromise = util.promisify(exec);

// Get current file directory in ESM
const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to yt-dlp binary in node_modules
const YT_DLP_PATH = path.resolve(__dirname, '../node_modules/yt-dlp-exec/bin/yt-dlp');

/**
 * Check if the yt-dlp binary exists
 */
function ytDlpExists(): boolean {
  return fs.existsSync(YT_DLP_PATH);
}

/**
 * Get the version of the current yt-dlp binary
 */
async function getYtDlpVersion(): Promise<string> {
  try {
    const { stdout } = await execPromise(`${YT_DLP_PATH} --version`);
    return stdout.trim();
  } catch (error) {
    console.error('Error checking yt-dlp version:', error);
    return 'unknown';
  }
}

/**
 * Update yt-dlp using pip
 */
async function updateYtDlpViaPip(): Promise<boolean> {
  console.log('Updating yt-dlp via pip...');
  
  try {
    const { stdout, stderr } = await execPromise('python3 -m pip install -U yt-dlp');
    console.log('pip install output:', stdout);
    if (stderr) console.error('pip install errors:', stderr);
    return true;
  } catch (error) {
    console.error('Failed to update yt-dlp via pip:', error);
    return false;
  }
}

/**
 * Copy the system yt-dlp to node_modules
 */
async function copyYtDlpToNodeModules(): Promise<boolean> {
  console.log('Copying yt-dlp to node_modules...');
  
  try {
    // Find system yt-dlp path
    const { stdout: whichOutput } = await execPromise('which yt-dlp').catch(() => ({ stdout: '' }));
    
    let sourcePath = whichOutput.trim();
    
    // If which fails, try to find it in Python's path
    if (!sourcePath) {
      const { stdout: pythonOutput } = await execPromise(
        'python3 -c "import sys, os; print(os.path.join(os.path.dirname(sys.executable), \'yt-dlp\'))"'
      );
      sourcePath = pythonOutput.trim();
    }
    
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      console.error('Could not find system yt-dlp binary');
      return false;
    }
    
    // Create the directory if it doesn't exist
    const dirPath = path.dirname(YT_DLP_PATH);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    
    // Copy the file
    fs.copyFileSync(sourcePath, YT_DLP_PATH);
    
    // Make it executable
    fs.chmodSync(YT_DLP_PATH, '755');
    
    console.log(`Copied ${sourcePath} to ${YT_DLP_PATH}`);
    return true;
  } catch (error) {
    console.error('Failed to copy yt-dlp to node_modules:', error);
    return false;
  }
}

/**
 * Test if the updated yt-dlp works with a test video
 */
async function testYtDlp(): Promise<boolean> {
  console.log('Testing yt-dlp with a sample video...');
  
  const testUrl = 'https://www.youtube.com/watch?v=9BZY0m6fL54';
  const testOutput = path.resolve(__dirname, '../test_update.m4a');
  const cookiesPath = path.resolve(__dirname, '../youtube_cookies.txt');
  
  return new Promise((resolve) => {
    const process = spawn(YT_DLP_PATH, [
      testUrl,
      '--output', testOutput,
      '--extract-audio',
      '--audio-format', 'm4a',
      '--format', 'bestaudio',
      '--no-check-certificate',
      '--no-playlist',
      '--cookies', cookiesPath
    ]);
    
    let errorOutput = '';
    
    process.stderr.on('data', (data) => {
      const output = data.toString();
      errorOutput += output;
      if (output.includes('Requested format is not available')) {
        console.error('yt-dlp still cannot download the test video');
      }
    });
    
    process.on('close', (code) => {
      if (code === 0) {
        console.log('Test download successful!');
        // Clean up test file
        if (fs.existsSync(testOutput)) {
          fs.unlinkSync(testOutput);
        }
        resolve(true);
      } else {
        console.error(`Test download failed with code ${code}`);
        console.error('Error output:', errorOutput);
        resolve(false);
      }
    });
  });
}

/**
 * Update yt-dlp and verify it works
 */
async function updateYtDlp(): Promise<boolean> {
  console.log('Starting yt-dlp update process...');
  
  const currentVersion = await getYtDlpVersion();
  console.log(`Current yt-dlp version: ${currentVersion}`);
  
  // Step 1: Update yt-dlp via pip
  const pipUpdateSuccess = await updateYtDlpViaPip();
  if (!pipUpdateSuccess) {
    console.error('Failed to update yt-dlp via pip');
    return false;
  }
  
  // Step 2: Copy the updated binary to node_modules
  const copySuccess = await copyYtDlpToNodeModules();
  if (!copySuccess) {
    console.error('Failed to copy yt-dlp to node_modules');
    return false;
  }
  
  // Step 3: Test the updated binary
  const testSuccess = await testYtDlp();
  if (!testSuccess) {
    console.error('The updated yt-dlp binary failed testing');
    return false;
  }
  
  const newVersion = await getYtDlpVersion();
  console.log(`yt-dlp updated successfully. New version: ${newVersion}`);
  return true;
}

/**
 * Main function to handle checking for errors and updating
 */
async function main(): Promise<void> {
  // Check if yt-dlp exists
  if (!ytDlpExists()) {
    console.error('yt-dlp binary not found in node_modules');
    const updateSuccess = await updateYtDlp();
    if (!updateSuccess) {
      console.error('Failed to install yt-dlp');
      process.exit(1);
    }
    process.exit(0);
  }
  
  // If script is run with --force flag, update regardless of status
  if (process.argv.includes('--force')) {
    console.log('Force update flag detected');
    const updateSuccess = await updateYtDlp();
    if (!updateSuccess) {
      console.error('Force update failed');
      process.exit(1);
    }
    process.exit(0);
  }
  
  // Otherwise, test the current yt-dlp to see if it needs updating
  const testSuccess = await testYtDlp();
  if (!testSuccess) {
    console.log('Current yt-dlp binary failed testing, attempting update');
    const updateSuccess = await updateYtDlp();
    if (!updateSuccess) {
      console.error('Failed to update yt-dlp after test failure');
      process.exit(1);
    }
  } else {
    console.log('Current yt-dlp binary is working correctly, no update needed');
  }
  
  process.exit(0);
}

// Run the main function
main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
}); 