// ES module script
import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

// Load environment variables from .env.development
const envPath = path.resolve(process.cwd(), '.env.development');
dotenv.config({ path: envPath });

const prisma = new PrismaClient();
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';

// Function to check if a URL is hardcoded (not using the API_BASE_URL pattern)
function isHardcodedUrl(url) {
  // If the URL doesn't contain the API_BASE_URL, it's hardcoded
  if (!url.includes(`${API_BASE_URL}/api/albumart/`)) {
    // Check for common patterns that indicate hardcoded URLs
    return (
      url.includes('localhost') ||
      url.includes('sv-miu.gacha.boo') ||
      url.includes('miu.gacha.boo') ||
      (url.includes('http://') && !url.includes(`${API_BASE_URL}/api/albumart/`)) ||
      (url.includes('https://') && !url.includes(`${API_BASE_URL}/api/albumart/`))
    );
  }
  return false;
}

async function main() {
  try {
    console.log('Checking for hardcoded URLs in the database...');
    console.log(`Using API_BASE_URL: ${API_BASE_URL}`);
    
    // Get all tracks
    const allTracks = await prisma.track.findMany({
      select: {
        youtubeId: true,
        title: true,
        thumbnail: true
      }
    });
    
    // Filter tracks with hardcoded URLs
    const tracksWithHardcodedUrls = allTracks.filter(track => isHardcodedUrl(track.thumbnail));
    
    console.log(`Found ${tracksWithHardcodedUrls.length} tracks with hardcoded URLs out of ${allTracks.length} total tracks:`);
    tracksWithHardcodedUrls.forEach(track => {
      console.log(`- ${track.title} (${track.youtubeId}): ${track.thumbnail}`);
    });
    
    // Check default playlists with hardcoded URLs
    const playlistsWithTracks = await prisma.defaultPlaylist.findMany({
      include: {
        tracks: {
          include: {
            track: true
          }
        }
      }
    });
    
    // Filter playlist tracks with hardcoded URLs
    const playlistTracksWithHardcodedUrls = [];
    
    for (const playlist of playlistsWithTracks) {
      for (const playlistTrack of playlist.tracks) {
        const thumbnail = playlistTrack.track.thumbnail;
        if (isHardcodedUrl(thumbnail)) {
          playlistTracksWithHardcodedUrls.push({
            playlist,
            playlistTrack,
            track: playlistTrack.track
          });
        }
      }
    }
    
    console.log(`\nFound ${playlistTracksWithHardcodedUrls.length} default playlist tracks with hardcoded URLs:`);
    playlistTracksWithHardcodedUrls.forEach(item => {
      console.log(`- Playlist: ${item.playlist.name}, Track: ${item.track.title} (${item.track.youtubeId}): ${item.track.thumbnail}`);
    });
    
    console.log('\nSummary:');
    console.log(`- ${tracksWithHardcodedUrls.length} tracks with hardcoded URLs`);
    console.log(`- ${playlistTracksWithHardcodedUrls.length} default playlist tracks with hardcoded URLs`);
    
    if (tracksWithHardcodedUrls.length > 0 || playlistTracksWithHardcodedUrls.length > 0) {
      console.log('\nTo fix these issues, run the update-thumbnails.js script with the --purge-all flag.');
    } else {
      console.log('\nNo hardcoded URLs found in the database.');
    }
    
  } catch (error) {
    console.error('Error checking for hardcoded URLs:', error);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
}); 