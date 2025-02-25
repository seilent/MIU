import YoutubeMusicApi from 'youtube-music-api';
import { prisma } from '../db.js';
import fs from 'fs';
import path from 'path';
import type { SearchResult } from './types.js';
import { google } from 'googleapis';
import { getYoutubeInfo, youtube } from './youtube.js';
import fetch from 'node-fetch';
import execa from 'execa';

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

// Helper function to download and cache thumbnails
async function downloadAndCacheThumbnail(videoId: string, url: string): Promise<void> {
  try {
    const thumbnailPath = path.join(THUMBNAIL_CACHE_DIR, `${videoId}.jpg`);
    
    // Check if thumbnail already exists
    if (fs.existsSync(thumbnailPath)) {
      return;
    }
    
    // Download thumbnail
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch thumbnail: ${response.status} ${response.statusText}`);
    }
    
    const buffer = await response.arrayBuffer();
    fs.writeFileSync(thumbnailPath, Buffer.from(buffer));
    console.log(`Downloaded thumbnail for ${videoId}`);
  } catch (error) {
    console.error(`Failed to download thumbnail for ${videoId}:`, error);
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
          thumbnail: `${API_BASE_URL}/api/albumart/${videoId}`,
          updatedAt: new Date()
        },
        create: {
          youtubeId: videoId,
          title,
          duration,
          thumbnail: `${API_BASE_URL}/api/albumart/${videoId}`
        }
      });

      return {
        youtubeId: videoId,
        title,
        thumbnail: `${API_BASE_URL}/api/albumart/${videoId}`,
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
    console.log('\n=== Starting YouTube Music ID resolution ===');
    
    // First try oEmbed to check if the video is directly available
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${musicId}&format=json`;
    const response = await fetch(oembedUrl);
    
    if (response.ok) {
      // Get oEmbed data for potential fallback search
      const oembedData = await response.json();
      const channelId = oembedData.author_url?.split('/channel/')?.[1];
      
      // Try verifying video availability first
      try {
        // First verify with yt-dlp that the video is actually available
        const ytdlpPath = path.join(process.cwd(), 'node_modules/yt-dlp-exec/bin/yt-dlp');
        await execa(ytdlpPath, [
          musicId,
          '--no-download',
          '--no-warnings',
          '--quiet'
        ]);
        
        // Only if yt-dlp check passes, try getting video info
        try {
          const info = await getYoutubeInfo(musicId);
          if (info) {
            // Update track entry to mark it as a music URL
            await prisma.track.update({
              where: { youtubeId: musicId },
              data: { isMusicUrl: true }
            });
            
            console.log('✓ Original video is available');
            return musicId;
          }
        } catch (infoError) {
          console.log('✗ Failed to get video info');
        }
      } catch (error) {
        // If video is not available but we have oEmbed data, try finding alternative video
        if (oembedData.title && channelId) {
          const alternativeId = await findAlternativeVideoId(oembedData.title, channelId);
          if (alternativeId) {
            // Create/update the original track entry with resolved ID
            await prisma.track.upsert({
              where: { youtubeId: musicId },
              update: {
                isMusicUrl: true,
                resolvedYtId: alternativeId,
                isActive: true
              },
              create: {
                youtubeId: musicId,
                title: oembedData.title,
                isMusicUrl: true,
                resolvedYtId: alternativeId,
                duration: 0, // Will be updated when playing
                thumbnail: oembedData.thumbnail_url || '',
                isActive: true
              }
            });
            return alternativeId;
          }
        }
      }
    }
    
    // Continue with existing fallback logic...
    const musicUrl = `https://music.youtube.com/watch?v=${musicId}`;
    const musicResponse = await fetch(musicUrl);
    
    if (!musicResponse.ok) return null;

    const html = await musicResponse.text();
    
    // Extract title for potential search
    const titleMatch = html.match(/"title":"([^"]+)"/);
    if (!titleMatch) return null;
    
    const title = titleMatch[1];
    
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
        
        // Create/update the original track entry with resolved ID
        await prisma.track.upsert({
          where: { youtubeId: musicId },
          update: {
            isMusicUrl: true,
            resolvedYtId: extractedVideoId,
            isActive: true
          },
          create: {
            youtubeId: musicId,
            title,
            isMusicUrl: true,
            resolvedYtId: extractedVideoId,
            duration: 0,
            thumbnail: '',
            isActive: true
          }
        });
        
        console.log('✓ Found alternative video from music page');
        return extractedVideoId;
      } catch (error) {
        // Continue to YouTube search if verification fails
      }
    }
    
    // If we couldn't extract a valid ID, search for the track on regular YouTube
    try {
      const youtubeApi = google.youtube('v3');
      const apiKey = await youtube.keyManager().getCurrentKey();
      const searchResponse = await youtubeApi.search.list({
        key: apiKey,
        part: ['snippet'],
        q: title,
        type: ['video'],
        maxResults: 5
      });

      const videos = searchResponse.data.items;
      if (!videos || videos.length === 0) return null;

      // Get the first result's video ID
      const regularYoutubeId = videos[0].id?.videoId;
      if (!regularYoutubeId) return null;

      // Verify the found video is available
      try {
        const ytdlpPath = path.join(process.cwd(), 'node_modules/yt-dlp-exec/bin/yt-dlp');
        await execa(ytdlpPath, [
          regularYoutubeId,
          '--no-download',
          '--no-warnings',
          '--quiet'
        ]);
        
        // Create/update the original track entry with resolved ID
        await prisma.track.upsert({
          where: { youtubeId: musicId },
          update: {
            isMusicUrl: true,
            resolvedYtId: regularYoutubeId,
            isActive: true
          },
          create: {
            youtubeId: musicId,
            title,
            isMusicUrl: true,
            resolvedYtId: regularYoutubeId,
            duration: 0,
            thumbnail: '',
            isActive: true
          }
        });
        
        console.log('✓ Found alternative video from search');
        return regularYoutubeId;
      } catch (error) {
        return null;
      }
    } catch (error) {
      return null;
    }

  } catch (error) {
    console.error('Error during YouTube Music ID resolution:', error);
    return null;
  }
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

/**
 * Search for alternative video ID using title and channel info
 * @param title The title from oEmbed
 * @param channelId The channel ID from oEmbed
 * @returns The alternative video ID if found, null otherwise
 */
async function findAlternativeVideoId(title: string, channelId: string): Promise<string | null> {
  try {
    console.log(`\nSearching for alternative video from channel: ${channelId}`);
    
    const youtubeApi = google.youtube('v3');
    const apiKey = await youtube.keyManager().getCurrentKey();
    
    // Search for videos with the exact title from the same channel
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

    // Get the first result from the same channel that's available
    for (const video of videos) {
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
        
        // Get video info from YouTube API to create track entry
        const info = await getYoutubeInfo(videoId);
        if (!info) continue;

        // Get best quality thumbnail URL
        const thumbnails = video.snippet?.thumbnails || {};
        const bestThumbnail = thumbnails.maxres?.url || 
                            thumbnails.high?.url || 
                            thumbnails.medium?.url || 
                            thumbnails.default?.url;

        if (bestThumbnail) {
          await downloadAndCacheThumbnail(videoId, bestThumbnail);
        }

        // Create track entry for the alternative video
        await prisma.track.upsert({
          where: { youtubeId: videoId },
          update: {
            title: info.title,
            duration: info.duration,
            thumbnail: `${API_BASE_URL}/api/albumart/${videoId}`,
            updatedAt: new Date()
          },
          create: {
            youtubeId: videoId,
            title: info.title,
            duration: info.duration,
            thumbnail: `${API_BASE_URL}/api/albumart/${videoId}`
          }
        });
        
        console.log(`✓ Found alternative video: ${foundTitle}`);
        return videoId;
      } catch (error) {
        continue;
      }
    }

    console.log('✗ No available alternative video found');
    return null;
  } catch (error) {
    console.error('Error searching for alternative video:', error);
    return null;
  }
} 