import { youtube_v3 } from 'googleapis';
import { prisma } from '../db.js';

// Shared blocked keywords for all content types
export const BLOCKED_KEYWORDS = [
  // Covers and user-generated content
  'うたってみた',
  'vocaloid', 'ボーカロイド', 'ボカロ',
  'hatsune', 'miku', '初音ミク',
  'live', 'ライブ', 'concert', 'コンサート',
  'remix', 'リミックス',
  'acoustic', 'アコースティック',
  'instrumental', 'インストゥルメンタル',
  'karaoke', 'カラオケ',
  'nightcore',
  'kagamine', 'rin', 'len', '鏡音リン', '鏡音レン',
  'luka', 'megurine', '巡音ルカ',
  'kaito', 'kaiko', 'meiko', 'gumi', 'gackpo', 'ia',
  'utau', 'utauloid', 'utaite',
  'nico', 'niconico', 'ニコニコ',
  'short', 'shorts', 'ショート', 'tiktok', 'tik tok', 'reels',
  'mv reaction', 'reaction', 'リアクション',
  'tutorial', 'lesson', 'how to', 'music theory',
  'guitar', 'drum', 'piano', 'tabs', 'off vocal',
  'ギター', 'ドラム', 'ピアノ', 'オフボーカル',
  
  // VOCALOID characters - Kanji names
  '初音ミク', '鏡音リン', '鏡音レン', '巡音ルカ', 'KAITO', 'MEIKO',
  '神威がくぽ', 'GUMI', 'Lily', '氷山キヨテル', '歌愛ユキ',
  '猫村いろは', 'SF-A2 開発コード miki', 'VY1', 'VY2', '蒼姫ラピス',
  '結月ゆかり', '兎眠りおん', 'MAYU', 'ZOLA PROJECT', '心華',
  'CYBER DIVA', 'CYBER SONGMAN', 'Fukase', '音街ウナ',
  '鏡音リン・レン V4X', '初音ミク V4X', '巡音ルカ V4X',
  
  // VOCALOID characters - Romaji names
  'Hatsune Miku', 'Kagamine Rin', 'Kagamine Len', 'Megurine Luka',
  'Kaito', 'Meiko', 'Kamui Gakupo', 'Gumi', 'Lily', 'Hiyama Kiyoteru',
  'Kaai Yuki', 'Nekomura Iroha', 'SF-A2 Kaihatsu Kōdo Miki',
  'Aoki Lapis', 'Yuzuki Yukari', 'Tone Rion', 'Mayu', 'Zola Project',
  'Xin Hua', 'Cyber Diva', 'Cyber Songman', 'Fukase', 'Otomachi Una',
  'Kagamine Rin & Len V4X', 'Hatsune Miku V4X', 'Megurine Luka V4X',
  
  // UTAU characters - Kanji names
  '重音テト', '桃音モモ', '欲音ルコ', '波音リツ', '健音テイ',
  '春歌ナナ', '櫻歌ミコ', 'デフォ子', '穂歌ソラ', '蒼音タヤ',
  '緋惺', '戯歌ラカン', '薪宮風季', '夢音ミライ', '和音マコ',
  '響震路', '神音ロン', '朝音ボウ', '夜音オウ', '闇音レンリ',
  '月代はくぽ', '白鐘ヒヨリ', '緋音アオ', '闇音フク', '朱音イナリ',
  '紫音リア', '蒼音カズ', '緑音ユウ', '橙音レン', '黄音ミツ',
  '藍音ソラ', '桜音ハル', '鈴音リン', '鈴音レン', '鈴音ミク',
  '鈴音ルカ', '鈴音カイト', '鈴音メイコ',
  
  // UTAU characters - Romaji names
  'Kasane Teto', 'Momone Momo', 'Yokune Ruko', 'Namine Ritsu', 'Sukone Tei',
  'Haruka Nana', 'Sakura Miko', 'Defoko', 'Hokaze Sora', 'Aone Taya',
  'Hikarisyuyo', 'Geika Rakan', 'Makimiya Fuki', 'Yumene Mirai', 'Waon Mako',
  'Hibiki Shinji', 'Kamene Ron', 'Asane Bou', 'Yorune Ou', 'Yamine Renri',
  'Tsukishiro Hakupo', 'Shirogane Hiyori', 'Hine Ao', 'Yamine Fuku', 'Akane Inari',
  'Shion Ria', 'Aone Kazu', 'Midone Yuu', 'Daione Ren', 'Kione Mitsu',
  'Aine Sora', 'Sakurane Haru', 'Suzune Rin', 'Suzune Len', 'Suzune Miku',
  'Suzune Luka', 'Suzune Kaito', 'Suzune Meiko'
];

// Chinese-specific keywords that indicate Chinese content
export const CHINESE_KEYWORDS = [
  // Chinese-exclusive particles (never used in Japanese)
  '吗', '嗎', '哪儿', '哪兒', '这儿', '這兒', '那儿', '那兒',
  '么', '咯', '喔', '嘞', '咧', '呗', '啦', '呢', '吧', '嘛',
  
  // Simplified Chinese exclusive characters
  '这', '那', '她', '说', '对', '时', '现', '东', '车',
  
  // Chinese-exclusive platforms and terms
  '网易云', '抖音', '快手', 'qq音乐', '酷狗',
  '哔哩哔哩', 'bilibili', 'b站', '小红书',
  
  // Mainland China specific terms
  '内地', '大陆', '网红',
  
  // Chinese-exclusive show names
  '中国好声音', '我是歌手', '快乐男声', '快乐女声',
  
  // Chinese social media specific
  '微博', '微信', '抖音号', '快手号'
];

// Japanese keywords that indicate Japanese content
export const JAPANESE_KEYWORDS = [
  'jpop', 'j-pop', 'jrock', 'j-rock', 
  'anime', 'japanese', 'japan', 
  'tokyo', 'osaka', 'kyoto',
  'utada', 'hikaru', 'yonezu', 'kenshi', 
  'radwimps', 'yorushika', 'yoasobi', 'lisa', 'ado',
  'eve', 'reol', 'zutomayo', 'vaundy', 'tuyu', 'tsuyu',
  'aimer', 'minami', 'mafumafu', 'kenshi', 'fujii', 'kana',
  'daoko', 'aimyon',
  'babymetal', 'kyary', 'pamyu', 'perfume', 'akb48',
  'nogizaka', 'keyakizaka', 'sakurazaka', 'hinatazaka',
  'jmusic', 'anisong', 'anison',
  'touhou'
];

// Korean-specific keywords that indicate Korean content
export const KOREAN_KEYWORDS = [
  // Korean music terms
  'kpop', 'k-pop', 'krock', 'k-rock',
  
  // Major Korean entertainment companies
  'sm entertainment', 'jyp', 'yg', 'hybe', 'bighit',
  '에스엠', '제이와이피', '와이지', '하이브', '빅히트',
  
  // Korean streaming platforms
  'melon', 'genie', 'bugs', 'flo',
  '멜론', '지니', '벅스', '플로',
  
  // Korean broadcast stations
  'mbc', 'sbs', 'kbs', 'mnet',
  '엠비씨', '에스비에스', '케이비에스', '엠넷',
  
  // Korean show names
  '음악중심', '인기가요', '엠카운트다운', '쇼음악중심',
  
  // Korean social media
  'kakao', 'naver', '카카오', '네이버'
];

// Regular expressions for character detection
const CHINESE_SPECIFIC_REGEX = /[\u2E80-\u2EFF\u3400-\u4DBF\u{20000}-\u{2A6DF}\u{2A700}-\u{2B73F}\u{2B740}-\u{2B81F}\u{2B820}-\u{2CEAF}]/u;
const JAPANESE_REGEX = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF\uFF65-\uFF9F]/;
const JAPANESE_PUNCTUATION_REGEX = /[。、！？…]/;
const KOREAN_REGEX = /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/;

// Function to check if text contains Chinese characters (improved version)
export function containsChineseSpecific(text: string): boolean {
  // Only check for simplified Chinese-exclusive characters
  // These characters are NEVER used in Japanese
  const simplifiedChineseOnly = /[她它这那说对时现东车]/;
  
  // Check for Chinese-exclusive particles
  const chineseParticles = [
    '吗', '嗎', '哪儿', '哪兒', '这儿', '這兒', '那儿', '那兒',
    '么', '咯', '喔', '嘞', '咧', '呗', '啦', '呢', '吧', '嘛'
  ];
  
  const lowerText = text.toLowerCase();
  
  // Count Chinese-exclusive particles
  const particleCount = chineseParticles.filter(particle => 
    lowerText.includes(particle)
  ).length;
  
  // If we find simplified Chinese-only characters or multiple particles, it's Chinese
  if (simplifiedChineseOnly.test(text) || particleCount >= 2) {
    return true;
  }
  
  // Check for Chinese-exclusive platforms and terms
  return CHINESE_KEYWORDS.some(keyword => lowerText.includes(keyword.toLowerCase()));
}

/**
 * Check if text contains Japanese characters or keywords
 */
export function containsJapanese(text: string): boolean {
  if (!text) return false;
  
  // If it contains Chinese-specific characters, it's likely not Japanese
  if (containsChineseSpecific(text)) {
    return false;
  }
  
  return JAPANESE_REGEX.test(text) || JAPANESE_PUNCTUATION_REGEX.test(text);
}

/**
 * Check if text contains Korean characters or keywords
 */
export function containsKorean(text: string): boolean {
  if (!text) return false;
  
  const lowerText = text.toLowerCase();
  
  // Check for Hangul characters
  if (KOREAN_REGEX.test(text)) {
    return true;
  }
  
  // Check for Korean keywords
  return KOREAN_KEYWORDS.some(keyword => lowerText.includes(keyword.toLowerCase()));
}

/**
 * Check if a song is likely Japanese based on various text fields
 */
export function isLikelyJapaneseSong(
  title: string,
  channelOrArtist: string,
  tags: string[] = [],
  additionalFields: string[] = []
): boolean {
  const allText = [title, channelOrArtist, ...tags, ...additionalFields]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  // First check for Chinese or Korean content
  if (containsChineseSpecific(allText) || containsKorean(allText)) {
    return false;
  }

  // Check for Japanese characters
  if (containsJapanese(allText)) {
    return true;
  }

  // Check for Japanese keywords
  return JAPANESE_KEYWORDS.some(keyword => allText.includes(keyword.toLowerCase()));
}

/**
 * Filter out blocked content from YouTube search results
 */
export async function filterBlockedContent(items: any[]): Promise<any[]> {
  // Get all blocked channels from database
  const blockedChannels = await prisma.channel.findMany({
    where: { isBlocked: true },
    select: { id: true }
  });
  
  const blockedChannelIds = blockedChannels.map(channel => channel.id);
  
  return items.filter(item => {
    const title = (item.snippet?.title || item.name || item.title || '').toLowerCase();
    const channelId = item.snippet?.channelId || item.channelId || item.channel_id;
    
    // Check if channel is blocked
    if (channelId && blockedChannelIds.includes(channelId)) {
      return false;
    }
    
    // Check for Chinese or Korean content
    if (containsChineseSpecific(title) || containsKorean(title)) {
      return false;
    }
    
    // Check for blocked keywords
    return !BLOCKED_KEYWORDS.some(keyword => title.includes(keyword.toLowerCase()));
  });
}

/**
 * Filter out blocked content from YouTube Music results
 */
export async function filterBlockedMusicContent(items: any[]): Promise<any[]> {
  // Get all blocked channels from database
  const blockedChannels = await prisma.channel.findMany({
    where: { isBlocked: true },
    select: { id: true }
  });
  
  const blockedChannelIds = blockedChannels.map(channel => channel.id);
  
  return items.filter(item => {
    const title = (item.name || item.title || '').toLowerCase();
    const artist = (item.artist?.name || '').toLowerCase();
    const album = (item.album?.name || '').toLowerCase();
    const channelId = item.channelId || item.channel_id;
    
    // Check if channel is blocked
    if (channelId && blockedChannelIds.includes(channelId)) {
      return false;
    }
    
    // Check for Chinese or Korean content in all text fields
    if (containsChineseSpecific(title) || 
        containsChineseSpecific(artist) || 
        containsChineseSpecific(album) ||
        containsKorean(title) ||
        containsKorean(artist) ||
        containsKorean(album)) {
      return false;
    }
    
    // Check for blocked keywords in all text fields
    return !BLOCKED_KEYWORDS.some(keyword => {
      const lowerKeyword = keyword.toLowerCase();
      return title.includes(lowerKeyword) || 
             artist.includes(lowerKeyword) || 
             album.includes(lowerKeyword);
    });
  });
} 