/**
 * This file contains the proposed changes to youtube.ts to integrate the yt-dlp-helper.
 * 
 * IMPORTANT: DO NOT APPLY THESE CHANGES DIRECTLY.
 * This file is just to document the proposed changes for review.
 */

// 1. Add import at the top of youtube.ts
import { handleYtDlpError } from '../scripts/yt-dlp-helper.js';

// 2. Modify the downloadYoutubeAudio function in youtube.ts as follows:
export async function downloadYoutubeAudio(youtubeId: string, isMusicUrl: boolean = false): Promise<string> {
  // Create a unique temp path to avoid conflicts with parallel downloads
  let uniqueTempPath = '';
  
  try {
    await ensureCacheDirectories();
    
    // Define paths
    const cacheDir = path.join(process.cwd(), 'cache', 'audio');
    const tempDir = path.join(process.cwd(), 'cache', 'temp');
    const finalPath = path.join(cacheDir, `${youtubeId}.m4a`);
    const tempPath = path.join(tempDir, `${youtubeId}.m4a`);
    
    // Check if file already exists in cache
    try {
      const stats = await fs.promises.stat(finalPath);
      if (stats.size > 0) {
        console.log(`✓ [${youtubeId}] Using cached audio`);
        return finalPath;
      }
    } catch (error) {
      // File doesn't exist, continue with download
    }
    
    // Set the unique temp path
    uniqueTempPath = `${tempPath}.${Date.now()}`;
    
    // Clean up any existing temp files
    try {
      await fs.promises.unlink(tempPath);
    } catch (error) {
      // Ignore errors if file doesn't exist
    }
    try {
      await fs.promises.unlink(`${tempPath}.part`);
    } catch (error) {
      // Ignore errors if file doesn't exist
    }

    // Add retry logic for download
    let retries = 3;
    let lastError: Error | null = null;
    let backoffDelay = 1000;

    // Check if cookies file exists
    const cookiesPath = path.join(process.cwd(), 'youtube_cookies.txt');
    let cookiesExist = false;
    try {
      await fs.promises.access(cookiesPath, fs.constants.R_OK);
      cookiesExist = true;
      console.log(`✓ [${youtubeId}] Using cookies for authentication`);
    } catch (error) {
      console.log(`⚠️ [${youtubeId}] No cookies file found, proceeding without authentication`);
    }

    while (retries > 0) {
      try {
        // Construct YouTube URL - use music.youtube.com directly if it's a music URL
        const youtubeUrl = isMusicUrl 
          ? `https://music.youtube.com/watch?v=${youtubeId}`
          : `https://www.youtube.com/watch?v=${youtubeId}`;
        
        console.log(`⬇️ [${youtubeId}] Starting download from ${isMusicUrl ? 'YouTube Music' : 'YouTube'}`);

        // Download with yt-dlp using unique temp path
        const options: any = {
          output: uniqueTempPath,
          extractAudio: true,
          audioFormat: 'm4a',
          format: 'bestaudio',  // Get the best audio regardless of format ID
          noCheckCertificate: true,
          noWarnings: true,
          quiet: true,
          ffmpegLocation: ffmpeg || undefined,
          formatSort: 'proto:m3u8,abr',  // Prioritize m3u8 protocol and sort by audio bitrate
          noPlaylist: true
        };

        // Add cookies if available
        if (cookiesExist) {
          options.cookies = cookiesPath;
        }

        await ytDlp(youtubeUrl, options);

        // yt-dlp might add an extra .m4a extension, so check both paths
        let actualFilePath = uniqueTempPath;
        try {
          await fs.promises.access(uniqueTempPath, fs.constants.R_OK);
        } catch (error) {
          // Try with extra .m4a extension
          const altPath = `${uniqueTempPath}.m4a`;
          try {
            await fs.promises.access(altPath, fs.constants.R_OK);
            actualFilePath = altPath;
            console.log(`✓ [${youtubeId}] Found file with extra extension: ${altPath}`);
          } catch (e) {
            throw new Error(`Downloaded file not found at ${uniqueTempPath} or ${altPath}`);
          }
        }

        // Verify the downloaded file exists and is not empty
        const stats = await fs.promises.stat(actualFilePath);
        if (stats.size === 0) {
          throw new Error('Downloaded file is empty');
        }

        // Move temp file to final location
        await fs.promises.rename(actualFilePath, finalPath);
        console.log(`✅ [${youtubeId}] Download complete`);
        return finalPath;
      } catch (error: any) {
        lastError = error;
        const errorMessage = error?.stderr || error?.message || 'Unknown error';
        
        // Extract just the yt-dlp error message if present
        const ytdlpError = errorMessage.match(/ERROR: \[youtube\].*?: (.*?)(\n|$)/)?.[1];
        
        // Check if video is unavailable - no need to retry in this case
        if (errorMessage.includes('Video unavailable') || 
            errorMessage.includes('This video is not available') ||
            errorMessage.includes('This video has been removed')) {
          console.log(`❌ [${youtubeId}] Video unavailable`);
          throw new Error(`Video unavailable: ${youtubeId}`);
        }
        
        console.log(`⚠️ [${youtubeId}] Attempt ${4 - retries}/3 failed: ${ytdlpError || errorMessage}`);
        
        // ADDED: Check if this is a "Requested format is not available" error and try to update yt-dlp
        if (retries > 0) {
          // Try to update yt-dlp if format error is detected
          const updated = await handleYtDlpError(error);
          
          if (updated) {
            console.log(`✓ [${youtubeId}] yt-dlp was updated, retrying download...`);
            retries--; // Decrement retries counter even if update was successful
            continue;  // Skip the backoff delay and retry immediately
          }
          
          // If not updated, proceed with normal backoff
          retries--;
          
          // Clean up failed attempt
          try {
            await fs.promises.unlink(uniqueTempPath);
          } catch (e) {
            // Ignore cleanup errors
          }
          
          // Exponential backoff
          await new Promise(resolve => setTimeout(resolve, backoffDelay));
          backoffDelay *= 2; // Double the delay for next retry
        } else {
          retries--;
        }
      }
    }

    console.log(`❌ [${youtubeId}] Download failed after 3 attempts`);
    throw lastError || new Error('Download failed after retries');
  } finally {
    // Always clean up temp files and remove from active downloads
    try {
      await fs.promises.unlink(uniqueTempPath);
    } catch (error) {
      // Ignore cleanup errors
    }
    try {
      await fs.promises.unlink(`${uniqueTempPath}.m4a`);
    } catch (error) {
      // Ignore cleanup errors
    }
    activeDownloads.delete(youtubeId);
  }
}

// 3. Add a function to initialize the app and check if yt-dlp is working
// Add this somewhere in your application startup code

import { checkYtDlpWorking } from '../scripts/yt-dlp-helper.js';

async function initializeApp() {
  // Other initialization tasks...
  
  // Check if yt-dlp is working
  console.log('Checking if yt-dlp is working...');
  const ytDlpWorking = await checkYtDlpWorking();
  
  if (!ytDlpWorking) {
    console.warn('yt-dlp is not working correctly. Attempting to update...');
    try {
      // Run the update script directly
      const { spawn } = require('child_process');
      const process = spawn('npx', ['tsx', path.join(__dirname, '../scripts/update-yt-dlp.ts'), '--force']);
      
      process.stdout.on('data', (data) => {
        console.log(`[yt-dlp-update] ${data.toString().trim()}`);
      });
      
      process.stderr.on('data', (data) => {
        console.error(`[yt-dlp-update] ${data.toString().trim()}`);
      });
      
      await new Promise<void>((resolve, reject) => {
        process.on('close', (code) => {
          if (code === 0) {
            console.log('yt-dlp updated successfully.');
            resolve();
          } else {
            console.error(`yt-dlp update failed with code ${code}.`);
            reject(new Error(`Update failed with code ${code}`));
          }
        });
      });
    } catch (error) {
      console.error('Failed to update yt-dlp:', error);
      console.warn('Continuing startup, but some YouTube downloads may fail.');
    }
  } else {
    console.log('yt-dlp is working correctly.');
  }
  
  // Continue with rest of initialization...
} 