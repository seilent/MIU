import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import ffmpeg from 'ffmpeg-static';
import { platform } from 'os';
import { fileURLToPath } from 'url';

if (!ffmpeg) {
  console.error('FFmpeg binary not found');
  process.exit(1);
}

// Configure paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKEND_DIR = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(BACKEND_DIR, 'cache');
const AUDIO_CACHE_DIR = path.join(CACHE_DIR, 'audio');

interface VolumeInfo {
  meanVolume: number;
  maxVolume: number;
}

async function getVolumeInfo(filePath: string): Promise<VolumeInfo> {
  return new Promise((resolve, reject) => {
    let stderrData = '';
    const nullDevice = platform() === 'win32' ? 'NUL' : '/dev/null';

    const process = spawn(ffmpeg!, [
      '-hide_banner',
      '-i', filePath,
      '-af', 'volumedetect',
      '-f', 'null',
      nullDevice
    ]);

    process.stderr?.on('data', (data: Buffer) => {
      stderrData += data.toString();
    });

    process.on('error', (error) => {
      console.error('FFmpeg volume detection error:', error);
      reject(error);
    });

    process.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`FFmpeg volume detection exited with code ${code}`));
        return;
      }

      const meanMatch = stderrData.match(/mean_volume:\s*(-?\d+(\.\d+)?) dB/);
      const maxMatch = stderrData.match(/max_volume:\s*(-?\d+(\.\d+)?) dB/);
      
      if (!meanMatch || !maxMatch) {
        console.error('FFmpeg stderr:', stderrData);
        reject(new Error('Could not parse volume info'));
        return;
      }

      resolve({
        meanVolume: parseFloat(meanMatch[1]),
        maxVolume: parseFloat(maxMatch[1])
      });
    });
  });
}

async function processFile(filePath: string): Promise<void> {
  const fileName = path.basename(filePath);
  console.log(`\nProcessing ${fileName}...`);

  try {
    // Check volume
    const volumeInfo = await getVolumeInfo(filePath);
    console.log(`  Mean volume: ${volumeInfo.meanVolume.toFixed(1)} dB`);
    console.log(`  Max volume: ${volumeInfo.maxVolume.toFixed(1)} dB`);

    // Determine if we need to adjust volume
    if (volumeInfo.meanVolume >= -14 && volumeInfo.meanVolume <= -13) {
      console.log('  ✓ Volume is within target range (-14 dB to -13 dB)');
      return;
    }

    // File needs normalization, delete it
    if (volumeInfo.meanVolume > -13) {
      console.log(`  ! Volume is too loud (${volumeInfo.meanVolume.toFixed(1)} dB), deleting file`);
    } else {
      console.log(`  ! Volume is too quiet (${volumeInfo.meanVolume.toFixed(1)} dB), deleting file`);
    }

    fs.unlinkSync(filePath);
    console.log('  ✓ File deleted from cache');
  } catch (error) {
    console.error(`  ✗ Error processing ${fileName}:`, error);
  }
}

async function main() {
  try {
    // Get all .m4a files in the audio cache directory
    const files = fs.readdirSync(AUDIO_CACHE_DIR)
      .filter(file => file.endsWith('.m4a'))
      .map(file => path.join(AUDIO_CACHE_DIR, file));

    console.log(`Found ${files.length} audio files to check`);

    // Process files sequentially to avoid overloading the system
    for (const file of files) {
      await processFile(file);
    }

    console.log('\nVolume check complete!');
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

// Run the script
main(); 