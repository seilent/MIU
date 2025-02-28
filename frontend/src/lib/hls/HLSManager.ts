import Hls from 'hls.js';
import env from '@/utils/env';

class HLSManager {
  private static instance: HLSManager;
  private hls: Hls | null = null;
  private currentTrackId: string | null = null;
  private retryCount: number = 0;
  private maxRetries: number = 3;
  private loadPromise: Promise<void> | null = null;

  private constructor() {}

  static getInstance(): HLSManager {
    if (!HLSManager.instance) {
      HLSManager.instance = new HLSManager();
    }
    return HLSManager.instance;
  }

  public isSupported(): boolean {
    return Hls.isSupported();
  }

  public async attachMedia(audio: HTMLAudioElement, youtubeId: string): Promise<void> {
    // If we're already loading this track, wait for it
    if (this.loadPromise && this.currentTrackId === youtubeId) {
      return this.loadPromise;
    }

    // Create new load promise
    this.loadPromise = this.setupHLS(audio, youtubeId);

    try {
      await this.loadPromise;
    } finally {
      this.loadPromise = null;
    }
  }

  private async setupHLS(audio: HTMLAudioElement, youtubeId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.currentTrackId === youtubeId && this.hls?.media === audio) {
        console.log('HLS: Track already loaded:', youtubeId);
        resolve();
        return;
      }

      console.log('HLS: Setting up new track:', youtubeId);
      
      // Destroy existing instance
      this.destroy();

      // Reset retry count for new track
      this.retryCount = 0;

      // Create new HLS instance
      this.hls = new Hls({
        debug: false,
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 90,
        manifestLoadingTimeOut: 10000,
        manifestLoadingMaxRetry: 3,
        manifestLoadingRetryDelay: 500,
        levelLoadingTimeOut: 10000,
        fragLoadingTimeOut: 20000,
        enableSoftwareAES: true,
      });

      let resolved = false;

      // Bind events
      this.hls.on(Hls.Events.MEDIA_ATTACHED, () => {
        console.log('HLS: Media attached');
      });

      this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
        console.log('HLS: Manifest parsed');
        if (!resolved) {
          resolved = true;
          this.currentTrackId = youtubeId;
          resolve();
        }
      });

      this.hls.on(Hls.Events.ERROR, (event, data) => {
        console.error('HLS: Error:', data);
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              console.log('HLS: Fatal network error, attempting recovery');
              if (this.retryCount < this.maxRetries) {
                this.retryCount++;
                console.log(`HLS: Retry attempt ${this.retryCount}/${this.maxRetries}`);
                this.hls?.startLoad();
              } else {
                console.error('HLS: Max retries reached');
                if (!resolved) {
                  resolved = true;
                  reject(new Error('Failed to load media after max retries'));
                }
                this.destroy();
              }
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              console.log('HLS: Fatal media error, attempting recovery');
              if (this.retryCount < this.maxRetries) {
                this.retryCount++;
                console.log(`HLS: Retry attempt ${this.retryCount}/${this.maxRetries}`);
                this.hls?.recoverMediaError();
              } else {
                console.error('HLS: Max retries reached');
                if (!resolved) {
                  resolved = true;
                  reject(new Error('Failed to recover media after max retries'));
                }
                this.destroy();
              }
              break;
            default:
              console.error('HLS: Fatal error, destroying');
              if (!resolved) {
                resolved = true;
                reject(new Error('Fatal HLS error'));
              }
              this.destroy();
              break;
          }
        }
      });

      // Attach media
      this.hls.attachMedia(audio);

      // Load source
      const manifestUrl = `${env.apiUrl}/api/music/hls/${youtubeId}/playlist.m3u8`;
      console.log('HLS: Loading manifest:', manifestUrl);
      this.hls.loadSource(manifestUrl);

      // Set timeout for initial load
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(new Error('Timeout waiting for manifest'));
          this.destroy();
        }
      }, 30000);
    });
  }

  public destroy() {
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    this.currentTrackId = null;
    this.retryCount = 0;
    this.loadPromise = null;
  }
}

export default HLSManager; 