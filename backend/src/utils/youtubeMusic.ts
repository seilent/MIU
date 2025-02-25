import YoutubeMusicApi from 'youtube-music-api';
import { prisma } from '../db.js';
import fs from 'fs';
import path from 'path';
import type { SearchResult } from './types.js';

// API base URL for thumbnails
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3001';

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