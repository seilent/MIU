/**
 * This is an example showing how to integrate the yt-dlp-helper into the youtube.ts file.
 * This doesn't modify the actual codebase, but demonstrates the changes that would be made.
 */

// Example of how the downloadYoutubeAudio function in youtube.ts would be modified:

import { handleYtDlpError } from './yt-dlp-helper';

// ... existing imports in youtube.ts ...

async function downloadYoutubeAudio(
  videoId: string, 
  cookies: string | null = null,
  outputPath: string | null = null
): Promise<string> {
  let attempts = 0;
  const maxAttempts = 3;
  
  while (attempts < maxAttempts) {
    try {
      // ... existing code for download setup ...
      
      const result = await execaCommand(cmd);
      return outputPath;
    } catch (error) {
      attempts++;
      
      // Log the error
      console.error(`❌ [DOWNLOAD] Failed for ${videoId}: ${error.message}`);
      
      // Check if it's a format error and try to update yt-dlp
      if (attempts < maxAttempts) {
        const updated = await handleYtDlpError(error);
        
        if (updated) {
          // If yt-dlp was updated, retry immediately
          continue;
        }
        
        // If not a format error or update failed, wait before retry
        console.log(`Attempt ${attempts} failed for ${videoId}: ${error.message}`);
        await sleep(1000);
      } else {
        throw error;
      }
    }
  }
  
  throw new Error(`Failed to download audio for ${videoId} after ${maxAttempts} attempts`);
}

/**
 * This example shows how you would integrate a check in the application startup
 * to ensure yt-dlp is working before the server fully starts.
 */

import { checkYtDlpWorking } from './yt-dlp-helper';

async function startServer() {
  // Check if yt-dlp is working at startup
  console.log('Checking if yt-dlp is working...');
  const ytDlpWorking = await checkYtDlpWorking();
  
  if (!ytDlpWorking) {
    console.error('yt-dlp is not working correctly. Please check installation.');
    process.exit(1);
  }
  
  console.log('yt-dlp is working correctly, starting server...');
  // ... rest of server startup code ...
} 