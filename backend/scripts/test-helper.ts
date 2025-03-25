#!/usr/bin/env tsx

import { handleYtDlpError, checkYtDlpWorking } from './yt-dlp-helper';

async function testHelper() {
  console.log('Testing yt-dlp helper module...');
  
  // Test with a format error
  const error = {
    stderr: 'ERROR: [youtube] 9BZY0m6fL54: Requested format is not available. Use --list-formats for a list of available formats',
    message: 'Command failed with exit code 1'
  };
  
  console.log('Testing handleYtDlpError with format error...');
  const updateAttempted = await handleYtDlpError(error);
  console.log(`Update attempted: ${updateAttempted}`);
  
  // Test checking if yt-dlp is working
  console.log('Testing checkYtDlpWorking...');
  const isWorking = await checkYtDlpWorking();
  console.log(`yt-dlp is working: ${isWorking}`);
  
  console.log('Test completed.');
}

testHelper().catch(error => {
  console.error('Test failed:', error);
  process.exit(1);
}); 