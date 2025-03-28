import { google } from 'googleapis';

export class YouTubeKeyManager {
  private keys: Array<string>;
  private currentKeyIndex: number;
  private quotaExceededKeys: Map<string, Set<string>>;
  private lastResetTime: number;
  private retryAttempts: Map<string, number>; // Track retry attempts per operation
  
  constructor() {
    // Get API keys from environment variables
    this.keys = (process.env.YOUTUBE_API_KEYS || '').split(',').map(key => key.trim()).filter(key => key.length > 0);
    this.currentKeyIndex = 0;
    this.quotaExceededKeys = new Map<string, Set<string>>();
    this.lastResetTime = Date.now();
    this.retryAttempts = new Map<string, number>();
    
    if (this.keys.length === 0) {
      console.error('No YouTube API keys found in environment variables');
    } else {
      console.log(`Initialized YouTube Key Manager with ${this.keys.length} API keys`);
      
      // Reset quotas at midnight UTC
      this.setupDailyReset();
    }
  }
  
  /**
   * Set up a timer to reset quota tracking at midnight UTC
   */
  private setupDailyReset(): void {
    const resetQuotas = () => {
      console.log('Resetting YouTube API key quota tracking');
      this.quotaExceededKeys.clear();
      this.retryAttempts.clear();
      this.lastResetTime = Date.now();
      
      // Schedule next reset
      this.scheduleNextReset();
    };
    
    this.scheduleNextReset = () => {
      const now = new Date();
      const tomorrow = new Date(now);
      tomorrow.setUTCHours(0, 0, 0, 0);
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      
      const timeUntilMidnight = tomorrow.getTime() - now.getTime();
      setTimeout(resetQuotas, timeUntilMidnight);
      console.log(`Next YouTube API quota reset scheduled in ${Math.floor(timeUntilMidnight / (1000 * 60 * 60))} hours`);
    };
    
    // Schedule first reset
    this.scheduleNextReset();
  }
  
  private scheduleNextReset: () => void = () => {};
  
  /**
   * Get all available API keys
   * @returns Array of API keys
   */
  public async getAllKeys(): Promise<string[]> {
    return this.keys;
  }
  
  /**
   * Execute a YouTube API operation with automatic retry logic on quota errors
   * @param operationType The YouTube API operation type
   * @param apiFunction The API function to execute
   * @returns Result of the API call
   */
  public async executeWithRetry<T>(operationType: string, apiFunction: (key: string) => Promise<T>): Promise<T> {
    // Reset retry counter for this operation if it doesn't exist yet
    if (!this.retryAttempts.has(operationType)) {
      this.retryAttempts.set(operationType, 0);
    }
    
    const maxRetries = Math.min(this.keys.length, 5); // Don't retry more than 5 times or the number of keys
    let lastError: any = null;
    
    while (this.retryAttempts.get(operationType)! < maxRetries) {
      try {
        // Get a key for this operation
        const key = await this.getCurrentKey(operationType);
        
        // Try the operation
        const result = await apiFunction(key);
        
        // Success! Reset retry counter
        this.retryAttempts.set(operationType, 0);
        return result;
      } catch (error: any) {
        lastError = error;
        
        // Check if this is a quota error
        const reason = error?.errors?.[0]?.reason;
        if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
          // Mark the last used key as quota exceeded
          this.markKeyAsQuotaExceeded(await this.getCurrentKey(operationType), operationType);
          
          // Try the next key
          await this.getNextKey(operationType);
          
          // Increment retry counter
          this.retryAttempts.set(operationType, this.retryAttempts.get(operationType)! + 1);
          
          console.log(`Retrying ${operationType} after quota error (attempt ${this.retryAttempts.get(operationType)}/${maxRetries})`);
        } else {
          // Not a quota error, rethrow
          throw error;
        }
      }
    }
    
    // If we get here, we've exhausted our retry attempts
    console.error(`All available keys for ${operationType} have been quota exceeded.`);
    throw lastError || new Error(`All available keys for ${operationType} have been quota exceeded.`);
  }
  
  /**
   * Get the current API key for a specific operation
   * @param operationType The YouTube API operation type
   * @returns The current API key
   */
  public async getCurrentKey(operationType: string): Promise<string> {
    // Reset if more than a day has passed since last reset (failsafe)
    const now = Date.now();
    if (now - this.lastResetTime > 24 * 60 * 60 * 1000) {
      console.log('Forced quota reset due to time elapsed');
      this.quotaExceededKeys.clear();
      this.retryAttempts.clear();
      this.lastResetTime = now;
    }
    
    // Check if we have any keys available
    if (this.keys.length === 0) {
      throw new Error('No YouTube API keys available');
    }
    
    // Find a key that is not quota exceeded for this operation
    for (let i = 0; i < this.keys.length; i++) {
      const keyIndex = (this.currentKeyIndex + i) % this.keys.length;
      const key = this.keys[keyIndex];
      
      if (!this.isKeyQuotaExceeded(key, operationType)) {
        this.currentKeyIndex = keyIndex;
        return key;
      }
    }
    
    // If all keys are quota exceeded for this operation, use the current key
    console.warn(`All API keys are quota exceeded for ${operationType} operation, using current key anyway`);
    return this.keys[this.currentKeyIndex];
  }
  
  /**
   * Get the next available API key for a specific operation
   * @param operationType The YouTube API operation type
   * @returns The next available API key, or null if none available
   */
  public async getNextKey(operationType: string): Promise<string | null> {
    if (this.keys.length === 0) {
      return null;
    }
    
    // Try each key in sequence until we find one that is not quota exceeded
    let attemptsCount = 0;
    const maxAttempts = this.keys.length;
    
    while (attemptsCount < maxAttempts) {
      // Move to next key
      this.currentKeyIndex = (this.currentKeyIndex + 1) % this.keys.length;
      attemptsCount++;
      
      const key = this.keys[this.currentKeyIndex];
      if (!this.isKeyQuotaExceeded(key, operationType)) {
        return key;
      }
    }
    
    // If we've gone through all keys and they're all quota exceeded, return null
    console.warn(`All API keys are quota exceeded for ${operationType} operation`);
    return null;
  }
  
  /**
   * Check if a key is quota exceeded for a specific operation
   * @param key API key to check
   * @param operationType The YouTube API operation type
   * @returns True if the key is quota exceeded for this operation
   */
  public isKeyQuotaExceeded(key: string, operationType: string): boolean {
    if (!this.quotaExceededKeys.has(key)) {
      return false;
    }
    
    const operations = this.quotaExceededKeys.get(key);
    return operations?.has(operationType) || false;
  }
  
  /**
   * Mark a key as quota exceeded for a specific operation
   * @param key API key to mark
   * @param operationType The YouTube API operation type
   */
  public markKeyAsQuotaExceeded(key: string, operationType: string): void {
    if (!this.quotaExceededKeys.has(key)) {
      this.quotaExceededKeys.set(key, new Set<string>());
    }
    
    const operations = this.quotaExceededKeys.get(key);
    operations?.add(operationType);
    
    console.log(`Marked API key ${key.slice(-5)} as quota exceeded for ${operationType} operation. Unavailable keys for this operation: ${this.getUnavailableKeysCount(operationType)}/${this.keys.length}`);
  }
  
  /**
   * Get the number of keys that are quota exceeded for a specific operation
   * @param operationType The YouTube API operation type
   * @returns The number of unavailable keys
   */
  private getUnavailableKeysCount(operationType: string): number {
    let count = 0;
    for (const key of this.keys) {
      if (this.isKeyQuotaExceeded(key, operationType)) {
        count++;
      }
    }
    return count;
  }
  
  /**
   * Validate all API keys
   * This will check each key by making a lightweight API call and mark quota exceeded ones
   */
  public async validateKeys(): Promise<void> {
    console.log('Validating YouTube API keys...');
    
    // Track validation results
    let validCount = 0;
    let invalidCount = 0;
    let quotaExceededCount = 0;
    
    // Use Promise.all to validate all keys in parallel
    const validationPromises = this.keys.map(async (key, index) => {
      try {
        // Create a temporary YouTube client for validation
        const youtube = google.youtube('v3');
        
        // Try a lightweight API call to check if the key works
        await youtube.search.list({
          key,
          part: ['id'],
          q: 'test',
          maxResults: 1,
          type: ['video']
        });
        
        console.log(`✓ API key *****${key.slice(-5)} is valid`);
        validCount++;
        return true;
      } catch (error: any) {
        const reason = error?.errors?.[0]?.reason;
        if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
          console.log(`✗ API key *****${key.slice(-5)} quota exceeded`);
          this.markKeyAsQuotaExceeded(key, 'search.list');
          quotaExceededCount++;
          return false;
        } else {
          console.log(`✗ API key *****${key.slice(-5)} is invalid: ${reason || 'Unknown error'}`);
          invalidCount++;
          return false;
        }
      }
    });

    await Promise.all(validationPromises);
    
    console.log(`YouTube API key validation complete: ${validCount}/${this.keys.length} keys are valid`);
    
    if (quotaExceededCount > 0) {
      console.log(`- ${quotaExceededCount} keys exceeded quota`);
    }
    
    if (invalidCount > 0) {
      console.log(`- ${invalidCount} keys appear to be invalid`);
    }
  }
}

// Global instance of key manager
let keyManager: YouTubeKeyManager | null = null;

/**
 * Get the shared YouTube Key Manager instance
 */
export function getKeyManager(): YouTubeKeyManager {
  if (!keyManager) {
    keyManager = new YouTubeKeyManager();
  }
  return keyManager;
}

// Export a new instance for direct access to avoid circular dependencies
export const youtubeKeyManager = new YouTubeKeyManager(); 