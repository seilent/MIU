import YoutubeMusicApi from 'youtube-music-api';
import { prisma } from '../db.js';
import fs from 'fs';
import path from 'path';
import type { SearchResult } from './types.js';
import { google } from 'googleapis';
import { getYoutubeInfo, youtube, processImage } from './youtube.js';
import fetch from 'node-fetch';
import execa from 'execa';
import sharp from 'sharp';

// API base URL for thumbnails
const API_BASE_URL = process.env.API_BASE_URL;

// Cache directory configuration
const CACHE_DIR = process.env.CACHE_DIR || path.join(process.cwd(), 'cache');
const THUMBNAIL_CACHE_DIR = path.join(CACHE_DIR, 'albumart');

// Initialize YouTube Music API
const api = new YoutubeMusicApi();
let apiInitialized = false;

// Helper function to ensure API is initialized
async function ensureApiInitialized() {
  if (!apiInitialized) {
    await api.initalize(); // Note: the library has a typo in the method name
    apiInitialized = true;
  }
}

/**
 * Get the URL for a thumbnail based on the YouTube ID
 * Checks if the thumbnail exists in the cache directory first
 * @param youtubeId The YouTube ID to get the thumbnail URL for
 * @returns The URL to the thumbnail
 */
export function getThumbnailUrl(youtubeId: string): string {
  if (!youtubeId) return '';
  
  // Check if the thumbnail exists in the cache
  const cachePath = path.join(THUMBNAIL_CACHE_DIR, `${youtubeId}.jpg`);
  
  // If we have a thumbnail in cache, use the API endpoint
  return `${API_BASE_URL}/api/albumart/${youtubeId}`;
}

/**
 * Download and cache a thumbnail for a given video ID
 * @param youtubeId The YouTube video ID to cache thumbnail for
 * @param thumbnailUrl The URL of the thumbnail to download
 */
export async function downloadAndCacheThumbnail(youtubeId: string, thumbnailUrl: string): Promise<void> {
  // Check if we already have a cached thumbnail for this video
  const cachePath = path.join(THUMBNAIL_CACHE_DIR, `${youtubeId}.jpg`);
  
  // Check if the cache directory exists, if not create it
  const cacheDir = path.dirname(cachePath);
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
  
  // If cached thumbnail exists and is < 2 weeks old, skip download
  if (fs.existsSync(cachePath)) {
    const stats = fs.statSync(cachePath);
    const fileAge = Date.now() - stats.mtimeMs;
    const twoWeeks = 14 * 24 * 60 * 60 * 1000;
    
    if (fileAge < twoWeeks) {
      console.log(`Using cached thumbnail for ${youtubeId}`);
      return;
    }
  }
  
  try {
    console.log(`Downloading thumbnail for ${youtubeId}`);
    
    // Download the image
    const response = await fetch(thumbnailUrl);
    if (!response.ok) {
      throw new Error(`Failed to download thumbnail: ${response.statusText}`);
    }
    
    const buffer = await response.arrayBuffer();
    const imageBuffer = Buffer.from(buffer);
    
    // Process the image using the processImage function from youtube.ts
    const processedImage = await processImage(imageBuffer);
    
    // Write the processed image directly to the cache path
    fs.writeFileSync(cachePath, processedImage);
    
    console.log(`Thumbnail downloaded and processed for ${youtubeId}`);
    
    // Update the ThumbnailCache database entry
    const metadata = await sharp(processedImage).metadata();
    
    await prisma.thumbnailCache.upsert({
      where: { youtubeId },
      update: {
        filePath: cachePath,
        width: metadata.width || 0,
        height: metadata.height || 0,
        updatedAt: new Date()
      },
      create: {
        youtubeId,
        filePath: cachePath,
        width: metadata.width || 0,
        height: metadata.height || 0
      }
    });
    
  } catch (error) {
    console.error(`Error downloading thumbnail for ${youtubeId}:`, error);
    
    // If download fails, try to use a fallback thumbnail from YouTube directly
    try {
      const fallbackUrl = `https://i.ytimg.com/vi/${youtubeId}/maxresdefault.jpg`;
      console.log(`Trying fallback thumbnail URL: ${fallbackUrl}`);
      
      const response = await fetch(fallbackUrl);
      if (response.ok) {
        const buffer = await response.arrayBuffer();
        const imageBuffer = Buffer.from(buffer);
        
        // Try to process it
        try {
          const processedImage = await processImage(imageBuffer);
          fs.writeFileSync(cachePath, processedImage);
        } catch (processError) {
          // If processing fails, just use the original image
          fs.writeFileSync(cachePath, imageBuffer);
        }
        
        console.log(`Used fallback thumbnail for ${youtubeId}`);
        
        // Update the database even with fallback
        const metadata = await sharp(fs.readFileSync(cachePath)).metadata();
        
        await prisma.thumbnailCache.upsert({
          where: { youtubeId },
          update: {
            filePath: cachePath,
            width: metadata.width || 0,
            height: metadata.height || 0,
            updatedAt: new Date()
          },
          create: {
            youtubeId,
            filePath: cachePath,
            width: metadata.width || 0,
            height: metadata.height || 0
          }
        });
      } else {
        throw new Error(`Fallback thumbnail not available: ${response.statusText}`);
      }
    } catch (fallbackError) {
      console.error(`Failed to use fallback thumbnail for ${youtubeId}:`, fallbackError);
    }
  }
}

/**
 * Search YouTube Music for tracks
 * @param query Search query
 * @returns Array of search results
 */
export async function searchYoutubeMusic(query: string): Promise<SearchResult[]> {
  try {
    console.log('Querying YouTube Music API for:', query);
    
    // Ensure API is initialized
    await ensureApiInitialized();
    
    // Construct search query
    let searchQuery = query;
    if (!/[一-龯ぁ-んァ-ン]/.test(query)) {
      // If query doesn't contain Japanese characters, add J-pop keywords
      searchQuery = `${query} jpop`;
    }

    // Search YouTube Music
    const searchResults = await api.search(searchQuery, 'song');
    
    if (!searchResults || !searchResults.content || searchResults.content.length === 0) {
      console.log('No results from YouTube Music API');
      return [];
    }

    // Define blocked keywords for filtering
    const blockedKeywords = [
      'cover', 'カバー', // Cover in English and Japanese
      '歌ってみた', 'うたってみた', // "Tried to sing" in Japanese
      'vocaloid', 'ボーカロイド', 'ボカロ', // Vocaloid in English and Japanese
      'hatsune', 'miku', '初音ミク', // Hatsune Miku
      'live', 'ライブ', 'concert', 'コンサート', // Live performances
      'remix', 'リミックス', // Remixes
      'acoustic', 'アコースティック', // Acoustic versions
      'instrumental', 'インストゥルメンタル', // Instrumental versions
      'karaoke', 'カラオケ', // Karaoke versions
      'nightcore', // Nightcore versions
      'kagamine', 'rin', 'len', '鏡音リン', '鏡音レン', // Kagamine Rin/Len
      'luka', 'megurine', '巡音ルカ', // Megurine Luka
      'kaito', 'kaiko', 'meiko', 'gumi', 'gackpo', 'ia', // Other vocaloids
      'utau', 'utauloid', 'utaite', // UTAU and utaite
      'nico', 'niconico', 'ニコニコ', // NicoNico (often has covers)
    ];

    // Process results
    const filteredContent = searchResults.content.filter((item: any) => {
      if (!item.videoId) return false;
      
      const title = (item.name || '').toLowerCase();
      const artist = (item.artist?.name || '').toLowerCase();
      const album = (item.album?.name || '').toLowerCase();
      
      // Check if any blocked keyword is in the title, artist, or album
      return !blockedKeywords.some(keyword => 
        title.includes(keyword) || 
        artist.includes(keyword) || 
        album.includes(keyword)
      );
    });
    
    console.log(`Found ${searchResults.content.length} results, ${filteredContent.length} after filtering`);

    // Process results
    const results = await Promise.all(filteredContent.map(async (item: any) => {
      if (!item.videoId) return null;

      const videoId = item.videoId;
      const title = item.name || '';
      // Convert duration from seconds to our format
      const duration = item.duration?.totalSeconds || 0;
      
      // Get the best thumbnail
      const thumbnails = item.thumbnails || [];
      const bestThumbnail = thumbnails.length > 0 ? thumbnails[thumbnails.length - 1].url : '';

      // Skip if duration is 0 or title is empty
      if (duration === 0 || !title) return null;

      // Try to download and cache the thumbnail
      try {
        if (bestThumbnail) {
          await downloadAndCacheThumbnail(videoId, bestThumbnail);
        }
      } catch (error) {
        console.error(`Failed to download thumbnail for ${videoId}:`, error);
      }

      // Create track entry
      await prisma.track.upsert({
        where: { youtubeId: videoId },
        update: {
          title,
          duration,
          updatedAt: new Date()
        },
        create: {
          youtubeId: videoId,
          title,
          duration
        }
      });

      return {
        youtubeId: videoId,
        title,
        thumbnail: getThumbnailUrl(videoId), // Use the helper function
        duration
      };
    }));

    const validResults = results.filter((result): result is NonNullable<typeof result> => result !== null);
    return validResults;
  } catch (error) {
    console.error('YouTube Music search failed:', error);
    return [];
  }
}

/**
 * Check if a string likely contains Japanese text
 * @param text Text to check
 * @returns True if the text likely contains Japanese
 */
function containsJapanese(text: string): boolean {
  if (!text) return false;
  
  // Japanese character ranges:
  // Hiragana: \u3040-\u309F
  // Katakana: \u30A0-\u30FF
  // Kanji: \u4E00-\u9FAF
  // Half-width katakana: \uFF65-\uFF9F
  const japaneseRegex = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF\uFF65-\uFF9F]/;
  
  // Check if the text contains Japanese characters
  return japaneseRegex.test(text);
}

/**
 * Check if a track is likely Japanese based on title, artist, and album
 * @param track Track to check
 * @returns True if the track is likely Japanese
 */
function isLikelyJapanese(track: any): boolean {
  const title = track.name || '';
  const artist = track.artist?.name || '';
  const album = track.album?.name || '';
  
  // Check if any field contains Japanese characters
  if (containsJapanese(title) || containsJapanese(artist) || containsJapanese(album)) {
    return true;
  }
  
  // List of common Japanese artists/keywords that might not use Japanese characters
  const japaneseKeywords = [
    'jpop', 'j-pop', 'jrock', 'j-rock', 
    'anime', 'ost', 'soundtrack',
    'tokyo', 'japan', 'japanese',
    'utada', 'hikaru', 'yonezu', 'kenshi', 
    'radwimps', 'yorushika', 'yoasobi', 'lisa', 'ado',
    'eve', 'reol', 'zutomayo', 'vaundy', 'tuyu', 'tsuyu',
    'aimer', 'minami', 'mafumafu', 'kenshi', 'fujii', 'kana',
    'daoko', 'aimyon', 'miku', 'hatsune', 'vocaloid',
    'babymetal', 'kyary', 'pamyu', 'perfume', 'akb48',
    'nogizaka', 'keyakizaka', 'sakurazaka', 'hinatazaka'
  ];
  
  // Check if any field contains Japanese keywords
  const allText = `${title} ${artist} ${album}`.toLowerCase();
  return japaneseKeywords.some(keyword => allText.includes(keyword));
}

/**
 * Get recommendations from YouTube Music based on a seed track
 * @param seedTrackId YouTube video ID of the seed track
 * @returns Array of recommended track IDs
 */
export async function getYoutubeMusicRecommendations(seedTrackId: string): Promise<Array<{ youtubeId: string }>> {
  try {
    // Ensure API is initialized
    await ensureApiInitialized();
    
    // First try to get the watch playlist (radio)
    try {
      // YouTube Music uses "RDAMVM" prefix for radio/mix playlists based on a video
      const response = await api.getPlaylist(`RDAMVM${seedTrackId}`);
      
      if (response && response.content && response.content.length > 0) {
        // Filter out the seed track and extract video IDs
        const recommendations = response.content
          .filter((track: any) => track.videoId && track.videoId !== seedTrackId)
          // Filter out covers, vocaloid, and live performances
          .filter((track: any) => {
            const title = (track.name || '').toLowerCase();
            const artist = (track.artist?.name || '').toLowerCase();
            const album = (track.album?.name || '').toLowerCase();
            
            // Blocked keywords in title, artist, or album
            const blockedKeywords = [
              'cover', 'カバー', // Cover in English and Japanese
              '歌ってみた', 'うたってみた', // "Tried to sing" in Japanese
              'live', 'ライブ', 'concert', 'コンサート', // Live performances
              'remix', 'リミックス', // Remixes
              'acoustic', 'アコースティック', // Acoustic versions
              'instrumental', 'インストゥルメンタル', // Instrumental versions
              'karaoke', 'カラオケ', // Karaoke versions
              'nightcore', // Nightcore versions
            ];
            
            // Check if any blocked keyword is in the title, artist, or album
            return !blockedKeywords.some(keyword => 
              title.includes(keyword) || 
              artist.includes(keyword) || 
              album.includes(keyword)
            );
          })
          // Filter for Japanese songs only
          .filter(isLikelyJapanese)
          .map((track: any) => ({ youtubeId: track.videoId }));
        
        return recommendations;
      }
    } catch (error) {
      console.log(`Failed to get radio playlist for ${seedTrackId}, trying alternative method`);
    }
    
    // If radio playlist fails, try to search for similar songs
    try {
      // Get track details to use as search query
      const trackDetails = await prisma.track.findUnique({
        where: { youtubeId: seedTrackId },
        select: { title: true }
      });
      
      if (trackDetails) {
        // Clean up the title for better search results
        const searchQuery = trackDetails.title
          .replace(/【.*?】|\[.*?\]|feat\.|ft\./gi, '') // Remove brackets and featuring
          .replace(/\(.*?\)/g, '')                     // Remove parentheses
          .trim();
        
        // Add "Japanese" to the search query to bias towards Japanese results
        const enhancedQuery = `${searchQuery} Japanese`;
        
        // Search for similar songs
        const searchResults = await api.search(enhancedQuery, 'song');
        
        if (searchResults && searchResults.content && searchResults.content.length > 0) {
          // Filter out the seed track and extract video IDs
          const recommendations = searchResults.content
            .filter((track: any) => track.videoId && track.videoId !== seedTrackId)
            // Filter out covers, vocaloid, and live performances
            .filter((track: any) => {
              const title = (track.name || '').toLowerCase();
              const artist = (track.artist?.name || '').toLowerCase();
              const album = (track.album?.name || '').toLowerCase();
              
              // Blocked keywords in title, artist, or album
              const blockedKeywords = [
                'cover', 'カバー', // Cover in English and Japanese
                '歌ってみた', 'うたってみた', // "Tried to sing" in Japanese
                'live', 'ライブ', 'concert', 'コンサート', // Live performances
                'remix', 'リミックス', // Remixes
                'acoustic', 'アコースティック', // Acoustic versions
                'instrumental', 'インストゥルメンタル', // Instrumental versions
                'karaoke', 'カラオケ', // Karaoke versions
                'nightcore', // Nightcore versions
              ];
              
              // Check if any blocked keyword is in the title, artist, or album
              return !blockedKeywords.some(keyword => 
                title.includes(keyword) || 
                artist.includes(keyword) || 
                album.includes(keyword)
              );
            })
            // Filter for Japanese songs only
            .filter(isLikelyJapanese)
            .slice(0, 10) // Limit to 10 results
            .map((track: any) => ({ youtubeId: track.videoId }));
          
          console.log(`Found ${searchResults.content.length} search results, ${recommendations.length} after filtering`);
          return recommendations;
        }
      }
    } catch (searchError) {
      console.error('Failed to search for similar songs:', searchError);
    }
    
    console.log('No recommendations from YouTube Music API');
    return [];
  } catch (error) {
    console.error('YouTube Music recommendations failed:', error);
    return [];
  }
}

// Function to check if a URL is a YouTube Music URL
export function isYoutubeMusicUrl(url: string): boolean {
  return url.includes('music.youtube.com');
}

// Function to resolve a YouTube Music ID to a regular YouTube ID
export async function resolveYouTubeMusicId(musicId: string): Promise<string | null> {
  try {
    console.log(`=== Resolving YouTube Music ID: ${musicId} ===`);
    
    // First try oEmbed to check if the video is directly available
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${musicId}&format=json`;
    const response = await fetch(oembedUrl);
    
    if (response.ok) {
      // Get oEmbed data for potential fallback search
      const oembedData = await response.json();
      const channelId = oembedData.author_url?.split('/channel/')?.[1];
      
      if (!channelId) {
        console.log('✗ Could not get channel ID from oEmbed');
        // Don't return null here, continue with fallback logic
      } else {
        // Try verifying video availability and channel match
        let videoAvailable = false;
        try {
          // First verify with yt-dlp that the video is actually available
          const ytdlpPath = path.join(process.cwd(), 'node_modules/yt-dlp-exec/bin/yt-dlp');
          await execa(ytdlpPath, [
            musicId,
            '--no-download',
            '--no-warnings',
            '--quiet'
          ]);
          
          videoAvailable = true;
          
          // If video is available, verify the channel ID matches
          try {
            const youtubeApi = google.youtube('v3');
            let apiKey;
            try {
              apiKey = await youtube.keyManager().getCurrentKey();
            } catch (keyError) {
              console.log('✗ No valid YouTube API keys available for verification');
              // If we can't verify the channel, but the video is available, use it anyway
              console.log('✓ Original video is available (channel verification skipped)');
              return musicId;
            }
            
            const videoResponse = await youtubeApi.videos.list({
              key: apiKey,
              part: ['snippet'],
              id: [musicId]
            });

            const video = videoResponse.data.items?.[0];
            if (video && video.snippet?.channelId === channelId) {
              // Video exists and channel matches
              console.log('✓ Original video is available and channel matches');
              return musicId;
            } else {
              console.log('✗ Video exists but channel does not match');
              // Continue with fallback logic instead of returning null
            }
          } catch (infoError: any) {
            // Check if this is a quota exceeded error
            const reason = infoError?.errors?.[0]?.reason;
            if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
              console.log('✗ API quota exceeded during channel verification');
              // If we can't verify the channel due to quota, but the video is available, use it anyway
              console.log('✓ Original video is available (channel verification skipped due to quota)');
              return musicId;
            } else {
              console.log('✗ Failed to verify channel ID:', infoError);
              // Continue with fallback logic
            }
          }
        } catch (ytdlpError: unknown) {
          const errorMessage = ytdlpError instanceof Error ? ytdlpError.message : 'Unknown error';
          console.log('✗ Video is not available via yt-dlp:', errorMessage);
          // Continue with fallback logic
        }
        
        // If video is not available or channel doesn't match, try finding alternative video
        if (!videoAvailable || oembedData.title) {
          console.log('Looking for alternative videos...');
          const alternativeId = await findAlternativeVideoId(oembedData.title, channelId, musicId);
          if (alternativeId) {
            console.log(`Found alternative ID: ${alternativeId}`);
            return alternativeId;
          }
        }
      }
    }
    
    // Continue with existing fallback logic...
    const musicUrl = `https://music.youtube.com/watch?v=${musicId}`;
    const musicResponse = await fetch(musicUrl);
    
    if (!musicResponse.ok) {
      console.log('✗ Music URL is not accessible');
      // Try search-based fallback even if the Music URL is not accessible
      return await searchBasedFallback(musicId);
    }

    const html = await musicResponse.text();
    
    // Extract title for potential search
    const titleMatch = html.match(/"title":"([^"]+)"/);
    if (!titleMatch) {
      console.log('✗ Could not extract title from music page');
      return await searchBasedFallback(musicId);
    }
    
    const title = titleMatch[1];
    console.log(`Extracted title: "${title}"`);
    
    // Try to extract the actual YouTube video ID from the YouTube Music page
    const videoIdMatch = html.match(/"videoId":"([^"]{11})"/);
    if (videoIdMatch && videoIdMatch[1] !== musicId) {
      const extractedVideoId = videoIdMatch[1];
      
      // Verify this ID works
      try {
        const ytdlpPath = path.join(process.cwd(), 'node_modules/yt-dlp-exec/bin/yt-dlp');
        await execa(ytdlpPath, [
          extractedVideoId,
          '--no-download',
          '--no-warnings',
          '--quiet'
        ]);
        
        console.log('✓ Found alternative video from music page');
        return extractedVideoId;
      } catch (ytdlpError: unknown) {
        const errorMessage = ytdlpError instanceof Error ? ytdlpError.message : 'Unknown error';
        console.log('✗ Alternative video from music page is not available:', errorMessage);
        // Continue to search fallback
      }
    }
    
    return await searchBasedFallback(musicId, title);

  } catch (error) {
    console.error('Error during YouTube Music ID resolution:', error);
    return null;
  }
}

/**
 * Fallback method that searches YouTube for the track
 * @param musicId Original music ID (for logging)
 * @param title Optional title if available
 * @returns Alternative video ID or null
 */
async function searchBasedFallback(musicId: string, title?: string): Promise<string | null> {
  if (!title) {
    console.log('✗ No title available for search fallback');
    return null;
  }
  
  console.log(`Attempting search fallback for "${title}"`);
  
  try {
    const youtubeApi = google.youtube('v3');
    let apiKey;
    
    try {
      apiKey = await youtube.keyManager().getCurrentKey();
    } catch (keyError) {
      console.error('Error getting YouTube API key:', keyError);
      console.log('❌ No valid YouTube API keys available for search');
      return null;
    }
    
    const searchResponse = await youtubeApi.search.list({
      key: apiKey,
      part: ['snippet'],
      q: title,
      type: ['video'],
      maxResults: 5
    });

    const videos = searchResponse.data.items;
    if (!videos || videos.length === 0) {
      console.log('✗ No search results found');
      return null;
    }

    // Get the first result's video ID
    const regularYoutubeId = videos[0].id?.videoId;
    if (!regularYoutubeId) {
      console.log('✗ No video ID in search results');
      return null;
    }

    // Verify the found video is available
    try {
      const ytdlpPath = path.join(process.cwd(), 'node_modules/yt-dlp-exec/bin/yt-dlp');
      await execa(ytdlpPath, [
        regularYoutubeId,
        '--no-download',
        '--no-warnings',
        '--quiet'
      ]);
      
      console.log(`✓ Found alternative video from search: ${regularYoutubeId}`);
      
      // Get the video title from search results to log it
      const videoTitle = videos[0].snippet?.title;
      console.log(`Alternative video title: "${videoTitle}"`);
      
      // Download and cache thumbnail using the ORIGINAL music ID
      await cacheVideoThumbnail(regularYoutubeId, musicId);
      
      return regularYoutubeId;
    } catch (verifyError: unknown) {
      const errorMessage = verifyError instanceof Error ? verifyError.message : 'Unknown error';
      console.log(`✗ Alternative video ${regularYoutubeId} is not available:`, errorMessage);
      
      // Try next video in search results
      const ytdlpPath = path.join(process.cwd(), 'node_modules/yt-dlp-exec/bin/yt-dlp');
      for (let i = 1; i < videos.length; i++) {
        const altVideoId = videos[i].id?.videoId;
        if (!altVideoId) continue;
        
        // Check if this is an instrumental version - skip if it is
        const altTitle = videos[i].snippet?.title || '';
        if (isInstrumentalTrack(altTitle)) {
          console.log(`Skipping instrumental track: ${altTitle}`);
          continue;
        }
        
        try {
          await execa(ytdlpPath, [
            altVideoId,
            '--no-download',
            '--no-warnings',
            '--quiet'
          ]);
          
          console.log(`✓ Found alternative video from search (result #${i+1}): ${altVideoId}`);
          
          // Download and cache thumbnail using the ORIGINAL music ID
          await cacheVideoThumbnail(altVideoId, musicId);
          
          return altVideoId;
        } catch (nextVerifyError) {
          console.log(`✗ Alternative video ${altVideoId} is not available`);
        }
      }
      
      console.log('✗ None of the search results are available');
      return null;
    }
  } catch (searchError: any) {
    // Check if this is a quota exceeded error
    const reason = searchError?.errors?.[0]?.reason;
    if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
      console.log('❌ API quota exceeded during search fallback');
      const currentKey = await youtube.keyManager().getCurrentKey();
      youtube.keyManager().markKeyAsQuotaExceeded(currentKey);
      
      // Try again with a different key if available
      const keyCount = youtube.keyManager().getKeyCount();
      if (keyCount > 1) {
        console.log('Trying again with a different API key...');
        return searchBasedFallback(musicId, title);
      }
    }
    
    console.error('Error during search fallback:', searchError);
    return null;
  }
}

/**
 * Helper function to check if a track is an instrumental version
 * @param title The track title
 * @returns True if the track is likely an instrumental version
 */
function isInstrumentalTrack(title: string): boolean {
  const instrumentalKeywords = [
    'instrumental', 'インストゥルメンタル', 'インスト',
    'karaoke', 'カラオケ',
    'backing track', 'off vocal', 'オフボーカル',
    'no lyrics', 'no vocal', 'ノーボーカル'
  ];
  
  const lowerTitle = title.toLowerCase();
  return instrumentalKeywords.some(keyword => 
    lowerTitle.includes(keyword.toLowerCase())
  );
}

/**
 * Helper function to download and cache video thumbnail using the original Music ID
 * @param videoId The actual video ID used for fetching the thumbnail
 * @param originalMusicId The original Music ID to use as the cache key
 */
async function cacheVideoThumbnail(videoId: string, originalMusicId: string): Promise<void> {
  try {
    // Get video info from YouTube API to create track entry
    const info = await getYoutubeInfo(videoId);
    if (!info) return;

    // Get best quality thumbnail URL
    const youtubeApi = google.youtube('v3');
    const apiKey = await youtube.keyManager().getCurrentKey();
    
    const videoResponse = await youtubeApi.videos.list({
      key: apiKey,
      part: ['snippet'],
      id: [videoId]
    });

    const video = videoResponse.data.items?.[0];
    if (!video || !video.snippet) return;
    
    const thumbnails = video.snippet.thumbnails || {};
    const bestThumbnail = thumbnails.maxres?.url || 
                          thumbnails.high?.url || 
                          thumbnails.medium?.url || 
                          thumbnails.default?.url;

    if (bestThumbnail) {
      // Download and cache the thumbnail using the ORIGINAL music ID
      await downloadAndCacheThumbnail(originalMusicId, bestThumbnail);
      
      // Create track entry for the original music ID
      await prisma.track.upsert({
        where: { youtubeId: originalMusicId },
        update: {
          title: info.title,
          duration: info.duration,
          resolvedYtId: videoId, // Use resolvedYtId instead of resolvedId
          updatedAt: new Date()
        },
        create: {
          youtubeId: originalMusicId,
          title: info.title,
          duration: info.duration,
          resolvedYtId: videoId // Use resolvedYtId instead of resolvedId
        }
      });
      
      console.log(`✓ Cached thumbnail and created track entry for ${originalMusicId} (resolved to ${videoId})`);
    }
  } catch (error) {
    console.error(`Failed to cache thumbnail for ${originalMusicId}:`, error);
  }
}

/**
 * Search for alternative video ID using title and channel info
 * @param title The title from oEmbed
 * @param channelId The channel ID from oEmbed
 * @param originalMusicId The original YouTube Music ID
 * @returns The alternative video ID if found, null otherwise
 */
async function findAlternativeVideoId(title: string, channelId: string, originalMusicId: string): Promise<string | null> {
  try {
    console.log(`\nSearching for alternative video from channel: ${channelId}`);
    
    const youtubeApi = google.youtube('v3');
    
    // Try to get a valid API key
    let apiKey;
    try {
      apiKey = await youtube.keyManager().getCurrentKey();
    } catch (keyError) {
      console.error('Error getting YouTube API key:', keyError);
      console.log('❌ No valid YouTube API keys available for search');
      
      // Fallback: Try to use the original music ID directly
      console.log('Falling back to using original music ID directly');
      return null;
    }
    
    // Search for videos with the exact title from the same channel
    try {
      const searchResponse = await youtubeApi.search.list({
        key: apiKey,
        part: ['id', 'snippet'],
        q: title,
        type: ['video'],
        channelId: channelId,
        maxResults: 5
      });

      const videos = searchResponse.data.items;
      if (!videos || videos.length === 0) {
        console.log('✗ No videos found from the same channel');
        return null;
      }

      // Filter out instrumental versions first
      const nonInstrumentalVideos = videos.filter(video => {
        const videoTitle = video.snippet?.title || '';
        return !isInstrumentalTrack(videoTitle);
      });
      
      // Use non-instrumental videos if available, otherwise use all videos
      const targetVideos = nonInstrumentalVideos.length > 0 ? nonInstrumentalVideos : videos;
      
      // Get the first result from the same channel that's available
      for (const video of targetVideos) {
        const videoId = video.id?.videoId;
        if (!videoId) continue;

        const foundTitle = video.snippet?.title || '';
        
        // Verify the video is accessible
        try {
          // First verify with yt-dlp that the video is actually available
          const ytdlpPath = path.join(process.cwd(), 'node_modules/yt-dlp-exec/bin/yt-dlp');
          await execa(ytdlpPath, [
            videoId,
            '--no-download',
            '--no-warnings',
            '--quiet'
          ]);
          
          // Get video info from YouTube API
          await cacheVideoThumbnail(videoId, originalMusicId);
          
          console.log(`✓ Found alternative video: ${videoId} (${foundTitle})`);
          return videoId;
        } catch (verifyError) {
          console.log(`✗ Failed to verify video ${videoId}`);
          continue;
        }
      }
    } catch (searchError: any) {
      // Check if this is a quota exceeded error
      const reason = searchError?.errors?.[0]?.reason;
      if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
        console.error('Error searching for alternative video:', searchError);
        youtube.keyManager().markKeyAsQuotaExceeded(apiKey);
        
        // Try again with a different key if available
        const keyCount = youtube.keyManager().getKeyCount();
        if (keyCount > 1) {
          console.log('Trying again with a different API key...');
          return findAlternativeVideoId(title, channelId, originalMusicId);
        } else {
          console.log('❌ All API keys are quota exceeded');
          return null;
        }
      } else {
        console.error('Error searching for videos:', searchError);
        return null;
      }
    }
  } catch (error) {
    console.error('Error finding alternative video:', error);
    return null;
  }
  
  return null;
}

// Function to calculate similarity between two titles
function calculateTitleSimilarity(title1: string, title2: string): number {
  console.log('\nCalculating title similarity:');
  
  // Clean both titles
  const clean1 = cleanTitle(title1);
  const clean2 = cleanTitle(title2);
  
  console.log(`Cleaned title 1: "${clean1}"`);
  console.log(`Cleaned title 2: "${clean2}"`);
  
  // If either title is empty after cleaning, they're not similar
  if (!clean1 || !clean2) {
    console.log('One or both titles are empty after cleaning');
    return 0;
  }
  
  // Direct match after cleaning
  if (clean1 === clean2) {
    console.log('Exact match after cleaning');
    return 1;
  }
  
  // Check if one title contains the other
  if (clean1.includes(clean2) || clean2.includes(clean1)) {
    console.log('One title contains the other');
    return 0.9;
  }
  
  // Split into words and check overlap
  const words1 = clean1.split(/\s+/);
  const words2 = clean2.split(/\s+/);
  
  console.log(`Title 1 words: [${words1.join(', ')}]`);
  console.log(`Title 2 words: [${words2.join(', ')}]`);
  
  // If one title has only one word, require exact match
  if (words1.length === 1 || words2.length === 1) {
    console.log('One title has only one word, requiring exact match');
    return clean1 === clean2 ? 1 : 0;
  }
  
  // Count matching words
  const matchingWords = words1.filter(word => 
    words2.some(w2 => {
      const exactMatch = w2 === word;
      const partialMatch = word.length > 2 && w2.includes(word) || 
                          w2.length > 2 && word.includes(w2);
      if (exactMatch) console.log(`Exact word match: "${word}"`);
      if (partialMatch) console.log(`Partial word match: "${word}" ~ "${w2}"`);
      return exactMatch || partialMatch;
    })
  );
  
  // Calculate similarity score
  const similarityScore = matchingWords.length / Math.max(words1.length, words2.length);
  console.log(`Matching words: [${matchingWords.join(', ')}]`);
  console.log(`Similarity score: ${similarityScore.toFixed(3)} (${matchingWords.length} matches / ${Math.max(words1.length, words2.length)} max words)`);
  
  return similarityScore;
}

// Helper function to clean title for comparison
function cleanTitle(title: string): string {
  return title
    .replace(/[\(\[\{].*?[\)\]\}]/g, '') // Remove content in brackets
    .replace(/official|video|music|audio|lyrics|hd|4k/gi, '') // Remove common video indicators
    .replace(/[^\w\s]/g, '') // Remove special characters
    .replace(/\s+/g, ' ') // Normalize whitespace
    .trim();
} 