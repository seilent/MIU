import { TrackInfo } from './youtube.js';
import { isTrackBanned, isChannelBlocked } from './banManager.js';
import { autoBanInstrumental } from './banManager.js';
import logger from './logger.js';

/**
 * Centralized Music Filter Manager
 * Determines whether music should be played based on various criteria including
 * content filtering, duration limits, channel blocking, and quality standards
 */

export interface FilterCriteria {
  minDuration?: number;
  maxDuration?: number;
  allowInstrumental?: boolean;
  allowRemixes?: boolean;
  allowCovers?: boolean;
  allowLive?: boolean;
  minViewCount?: number;
  maxViewCount?: number;
  channelWhitelist?: string[];
  channelBlacklist?: string[];
  contentRating?: 'any' | 'family' | 'mature';
  languages?: string[];
}

export interface FilterResult {
  allowed: boolean;
  reason?: string;
  severity?: 'info' | 'warning' | 'blocked';
  autoActions?: string[];
}

export interface ContentAnalysis {
  isInstrumental: boolean;
  isRemix: boolean;
  isCover: boolean;
  isLive: boolean;
  isKaraoke: boolean;
  isNightcore: boolean;
  isLoFi: boolean;
  hasExplicitContent: boolean;
  estimatedLanguage?: string;
  musicGenre?: string[];
}

export class MusicFilterManager {
  private static readonly DEFAULT_CRITERIA: FilterCriteria = {
    minDuration: 30,        // 30 seconds minimum
    maxDuration: 600,       // 10 minutes maximum
    allowInstrumental: false,
    allowRemixes: true,
    allowCovers: true,
    allowLive: true,
    minViewCount: 100,      // At least 100 views
    contentRating: 'any',
    languages: ['en', 'ja', 'ko'] // English, Japanese, Korean
  };

  private static readonly INSTRUMENTAL_KEYWORDS = [
    'instrumental', 'karaoke', 'backing track', 'minus one', 'no vocals',
    'piano version', 'guitar version', 'acoustic version', 'orchestral version'
  ];

  private static readonly REMIX_KEYWORDS = [
    'remix', 'edit', 'rework', 'remaster', 'extended', 'club mix', 'radio edit'
  ];

  private static readonly COVER_KEYWORDS = [
    'cover', 'covered by', 'version by', 'sung by', 'performed by'
  ];

  private static readonly LIVE_KEYWORDS = [
    'live', 'concert', 'performance', 'tour', 'festival', 'unplugged', 'acoustic'
  ];

  private static readonly EXPLICIT_KEYWORDS = [
    'explicit', 'uncensored', 'nsfw', 'mature', '18+', 'adult'
  ];

  private static readonly LOW_QUALITY_KEYWORDS = [
    'nightcore', 'chipmunk', 'slowed', 'reverb', '8d audio', 'bass boosted'
  ];

  /**
   * Main filter function - determines if a track should be played
   */
  async shouldPlayTrack(trackInfo: TrackInfo, criteria: FilterCriteria = {}): Promise<FilterResult> {
    const mergedCriteria = { ...MusicFilterManager.DEFAULT_CRITERIA, ...criteria };
    
    try {
      logger.debug(`Filtering track: ${trackInfo.title} by ${trackInfo.channelTitle}`);

      // 1. Check if track is banned
      const isBanned = await isTrackBanned(trackInfo.youtubeId);
      if (isBanned) {
        return {
          allowed: false,
          reason: 'Track is banned',
          severity: 'blocked'
        };
      }

      // 2. Check if channel is blocked
      const channelBlocked = await isChannelBlocked(trackInfo.channelId, trackInfo.channelTitle);
      if (channelBlocked) {
        return {
          allowed: false,
          reason: `Channel "${trackInfo.channelTitle}" is blocked`,
          severity: 'blocked'
        };
      }

      // 3. Analyze content
      const analysis = this.analyzeContent(trackInfo);

      // 4. Apply duration filters
      const durationCheck = this.checkDuration(trackInfo, mergedCriteria);
      if (!durationCheck.allowed) {
        return durationCheck;
      }

      // 5. Apply content filters
      const contentCheck = await this.checkContentFilters(trackInfo, analysis, mergedCriteria);
      if (!contentCheck.allowed) {
        return contentCheck;
      }

      // 6. Apply quality filters
      const qualityCheck = this.checkQuality(trackInfo, analysis, mergedCriteria);
      if (!qualityCheck.allowed) {
        return qualityCheck;
      }

      // 7. Apply view count filters
      const viewCheck = this.checkViewCount(trackInfo, mergedCriteria);
      if (!viewCheck.allowed) {
        return viewCheck;
      }

      logger.debug(`✓ Track passed all filters: ${trackInfo.title}`);
      return {
        allowed: true,
        reason: 'All filters passed'
      };

    } catch (error) {
      logger.error(`Error filtering track ${trackInfo.youtubeId}:`, error);
      return {
        allowed: false,
        reason: 'Filter error occurred',
        severity: 'warning'
      };
    }
  }

  /**
   * Analyze track content to determine characteristics
   */
  private analyzeContent(trackInfo: TrackInfo): ContentAnalysis {
    const title = trackInfo.title.toLowerCase();
    const description = trackInfo.description?.toLowerCase() || '';
    const tags = trackInfo.tags?.map(tag => tag.toLowerCase()) || [];
    const allText = `${title} ${description} ${tags.join(' ')}`;

    return {
      isInstrumental: this.containsKeywords(allText, MusicFilterManager.INSTRUMENTAL_KEYWORDS),
      isRemix: this.containsKeywords(allText, MusicFilterManager.REMIX_KEYWORDS),
      isCover: this.containsKeywords(allText, MusicFilterManager.COVER_KEYWORDS),
      isLive: this.containsKeywords(allText, MusicFilterManager.LIVE_KEYWORDS),
      isKaraoke: allText.includes('karaoke') || allText.includes('sing along'),
      isNightcore: allText.includes('nightcore'),
      isLoFi: allText.includes('lo-fi') || allText.includes('lofi') || allText.includes('chill'),
      hasExplicitContent: this.containsKeywords(allText, MusicFilterManager.EXPLICIT_KEYWORDS),
      estimatedLanguage: this.estimateLanguage(trackInfo),
      musicGenre: this.extractGenres(trackInfo)
    };
  }

  /**
   * Check track duration against criteria
   */
  private checkDuration(trackInfo: TrackInfo, criteria: FilterCriteria): FilterResult {
    const duration = trackInfo.duration || 0;

    if (criteria.minDuration && duration < criteria.minDuration) {
      return {
        allowed: false,
        reason: `Track too short: ${duration}s (min: ${criteria.minDuration}s)`,
        severity: 'info'
      };
    }

    if (criteria.maxDuration && duration > criteria.maxDuration) {
      return {
        allowed: false,
        reason: `Track too long: ${duration}s (max: ${criteria.maxDuration}s)`,
        severity: 'info'
      };
    }

    return { allowed: true };
  }

  /**
   * Check content-based filters
   */
  private async checkContentFilters(
    trackInfo: TrackInfo, 
    analysis: ContentAnalysis, 
    criteria: FilterCriteria
  ): Promise<FilterResult> {
    
    // Check instrumental content
    if (analysis.isInstrumental && !criteria.allowInstrumental) {
      // Auto-ban instrumental tracks
      logger.info(`Auto-banning instrumental track: ${trackInfo.title}`);
      await autoBanInstrumental(trackInfo.youtubeId, trackInfo.title);
      
      return {
        allowed: false,
        reason: 'Instrumental tracks not allowed',
        severity: 'blocked',
        autoActions: ['banned']
      };
    }

    // Check remix content
    if (analysis.isRemix && !criteria.allowRemixes) {
      return {
        allowed: false,
        reason: 'Remix tracks not allowed',
        severity: 'info'
      };
    }

    // Check cover content
    if (analysis.isCover && !criteria.allowCovers) {
      return {
        allowed: false,
        reason: 'Cover tracks not allowed',
        severity: 'info'
      };
    }

    // Check live content
    if (analysis.isLive && !criteria.allowLive) {
      return {
        allowed: false,
        reason: 'Live tracks not allowed',
        severity: 'info'
      };
    }

    // Check explicit content based on rating
    if (analysis.hasExplicitContent && criteria.contentRating === 'family') {
      return {
        allowed: false,
        reason: 'Explicit content not allowed with family rating',
        severity: 'warning'
      };
    }

    // Check language preferences
    if (criteria.languages && criteria.languages.length > 0) {
      if (analysis.estimatedLanguage && !criteria.languages.includes(analysis.estimatedLanguage)) {
        return {
          allowed: false,
          reason: `Language "${analysis.estimatedLanguage}" not in allowed list`,
          severity: 'info'
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Check quality-based filters
   */
  private checkQuality(trackInfo: TrackInfo, analysis: ContentAnalysis, criteria: FilterCriteria): FilterResult {
    const title = trackInfo.title.toLowerCase();
    
    // Check for low-quality audio modifications
    if (this.containsKeywords(title, MusicFilterManager.LOW_QUALITY_KEYWORDS)) {
      return {
        allowed: false,
        reason: 'Low quality audio modification detected',
        severity: 'info'
      };
    }

    // Check for very short titles (often spam)
    if (trackInfo.title.length < 5) {
      return {
        allowed: false,
        reason: 'Title too short (potential spam)',
        severity: 'warning'
      };
    }

    // Check for excessive special characters (often spam)
    // Updated regex to specifically allow Japanese characters since this is a Japanese music player
    // Includes: ASCII letters/numbers, Japanese Hiragana, Katakana, Kanji, and common symbols
    const specialCharRatio = (trackInfo.title.match(/[^\w\s\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF\u3400-\u4DBF\-\(\)\[\]&・]/g) || []).length / trackInfo.title.length;
    if (specialCharRatio > 0.3) {
      return {
        allowed: false,
        reason: 'Excessive special characters in title',
        severity: 'warning'
      };
    }

    return { allowed: true };
  }

  /**
   * Check view count criteria
   */
  private checkViewCount(trackInfo: TrackInfo, criteria: FilterCriteria): FilterResult {
    const viewCount = trackInfo.viewCount || 0;

    if (criteria.minViewCount && viewCount < criteria.minViewCount) {
      return {
        allowed: false,
        reason: `Too few views: ${viewCount} (min: ${criteria.minViewCount})`,
        severity: 'info'
      };
    }

    if (criteria.maxViewCount && viewCount > criteria.maxViewCount) {
      return {
        allowed: false,
        reason: `Too many views: ${viewCount} (max: ${criteria.maxViewCount})`,
        severity: 'info'
      };
    }

    return { allowed: true };
  }

  /**
   * Check if text contains any of the specified keywords
   */
  private containsKeywords(text: string, keywords: string[]): boolean {
    return keywords.some(keyword => text.includes(keyword));
  }

  /**
   * Estimate language of the track
   */
  private estimateLanguage(trackInfo: TrackInfo): string {
    const text = `${trackInfo.title} ${trackInfo.description}`;
    
    // Simple language detection based on character patterns
    if (/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(text)) {
      return 'ja'; // Japanese
    }
    if (/[\uAC00-\uD7AF]/.test(text)) {
      return 'ko'; // Korean
    }
    if (/[\u4E00-\u9FFF]/.test(text)) {
      return 'zh'; // Chinese
    }
    
    return 'en'; // Default to English
  }

  /**
   * Extract potential music genres from track info
   */
  private extractGenres(trackInfo: TrackInfo): string[] {
    const genres: string[] = [];
    const allText = `${trackInfo.title} ${trackInfo.description} ${trackInfo.tags?.join(' ')}`.toLowerCase();
    
    const genreKeywords: Record<string, string[]> = {
      'pop': ['pop', 'popular'],
      'rock': ['rock', 'metal', 'punk'],
      'electronic': ['edm', 'electronic', 'techno', 'house', 'dubstep'],
      'hip-hop': ['hip hop', 'rap', 'hip-hop'],
      'classical': ['classical', 'orchestra', 'symphony'],
      'jazz': ['jazz', 'blues'],
      'country': ['country', 'folk'],
      'reggae': ['reggae', 'ska'],
      'latin': ['latin', 'salsa', 'bachata'],
      'anime': ['anime', 'opening', 'ending', 'ost']
    };

    for (const [genre, keywords] of Object.entries(genreKeywords)) {
      if (keywords.some(keyword => allText.includes(keyword))) {
        genres.push(genre);
      }
    }

    return genres;
  }

  /**
   * Batch filter multiple tracks
   */
  async filterTracks(tracks: TrackInfo[], criteria: FilterCriteria = {}): Promise<{ allowed: TrackInfo[], rejected: Array<{ track: TrackInfo, reason: string }> }> {
    const allowed: TrackInfo[] = [];
    const rejected: Array<{ track: TrackInfo, reason: string }> = [];

    for (const track of tracks) {
      const result = await this.shouldPlayTrack(track, criteria);
      
      if (result.allowed) {
        allowed.push(track);
      } else {
        rejected.push({
          track,
          reason: result.reason || 'Unknown reason'
        });
      }
    }

    logger.info(`Filtered ${tracks.length} tracks: ${allowed.length} allowed, ${rejected.length} rejected`);
    return { allowed, rejected };
  }

  /**
   * Get filter statistics
   */
  getFilterStats(results: FilterResult[]): Record<string, number> {
    const stats: Record<string, number> = {
      total: results.length,
      allowed: 0,
      blocked: 0,
      info: 0,
      warning: 0
    };

    for (const result of results) {
      if (result.allowed) {
        stats.allowed++;
      } else {
        stats.blocked++;
        if (result.severity) {
          stats[result.severity] = (stats[result.severity] || 0) + 1;
        }
      }
    }

    return stats;
  }

  /**
   * Create custom filter criteria
   */
  static createCriteria(overrides: Partial<FilterCriteria>): FilterCriteria {
    return { ...MusicFilterManager.DEFAULT_CRITERIA, ...overrides };
  }

  /**
   * Get preset filter criteria for different scenarios
   */
  static getPresetCriteria(preset: 'strict' | 'moderate' | 'lenient' | 'family'): FilterCriteria {
    const presets: Record<string, FilterCriteria> = {
      strict: {
        minDuration: 60,
        maxDuration: 300,
        allowInstrumental: false,
        allowRemixes: false,
        allowCovers: false,
        allowLive: false,
        minViewCount: 1000,
        contentRating: 'family'
      },
      moderate: {
        minDuration: 30,
        maxDuration: 600,
        allowInstrumental: false,
        allowRemixes: true,
        allowCovers: true,
        allowLive: true,
        minViewCount: 100,
        contentRating: 'any'
      },
      lenient: {
        minDuration: 15,
        maxDuration: 900,
        allowInstrumental: true,
        allowRemixes: true,
        allowCovers: true,
        allowLive: true,
        minViewCount: 10,
        contentRating: 'any'
      },
      family: {
        minDuration: 30,
        maxDuration: 480,
        allowInstrumental: false,
        allowRemixes: true,
        allowCovers: true,
        allowLive: true,
        minViewCount: 500,
        contentRating: 'family'
      }
    };

    return presets[preset] || presets.moderate;
  }
}

/**
 * Singleton instance
 */
let musicFilterManagerInstance: MusicFilterManager | null = null;

export function getMusicFilterManager(): MusicFilterManager {
  if (!musicFilterManagerInstance) {
    musicFilterManagerInstance = new MusicFilterManager();
  }
  return musicFilterManagerInstance;
}