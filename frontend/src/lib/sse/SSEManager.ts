import { usePlayerStore } from '../store/playerStore';
import env from '@/utils/env';

type EventCallback = (data: any) => void;
type ErrorCallback = (error: Event) => void;

interface SSEListeners {
  [key: string]: Map<string, EventCallback>;
}

class SSEManager {
  private static instance: SSEManager;
  private eventSource: EventSource | null = null;
  private listeners: SSEListeners = {};
  private errorListeners: Set<ErrorCallback> = new Set();
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private consecutiveErrors: number = 0;
  private isConnecting: boolean = false;
  private currentToken: string | null = null;
  private setupPromise: Promise<void> | null = null;
  private eventHandlers: Map<string, (event: MessageEvent) => void> = new Map();
  private lastEventId: string | null = null;
  private readonly MAX_RECONNECT_DELAY = 30000; // 30 seconds
  private readonly INITIAL_RECONNECT_DELAY = 1000; // 1 second

  private constructor() {}

  static getInstance(): SSEManager {
    if (!SSEManager.instance) {
      SSEManager.instance = new SSEManager();
    }
    return SSEManager.instance;
  }

  async connect(token: string): Promise<void> {
    if (this.setupPromise) {
      await this.setupPromise;
      return;
    }

    if (this.currentToken === token && 
        this.eventSource?.readyState === EventSource.OPEN) {
      return;
    }

    this.setupPromise = this.setupConnection(token);
    
    try {
      await this.setupPromise;
      console.log('SSE: Connection established successfully');
    } catch (error) {
      console.error('SSE: Connection setup failed:', error);
      this.handleError(error as Event);
    } finally {
      this.setupPromise = null;
    }
  }

  private async setupConnection(token: string): Promise<void> {
    if (this.eventSource) {
      this.disconnect();
    }

    this.isConnecting = true;
    this.currentToken = token;

    try {
      const url = new URL(`${env.apiUrl}/api/music/state/live`);
      url.searchParams.append('token', token);
      
      console.log('SSE: Connecting to URL', url.toString());
      
      this.eventSource = new EventSource(url.toString());
      
      this.eventSource.onopen = () => {
        console.log('SSE: Connection opened');
        this.consecutiveErrors = 0;
      };

      this.eventSource.onerror = (event) => {
        console.error('SSE: Connection error', event);
        this.handleError(event);
      };

      // Set up event handlers for each event type
      for (const eventType in this.listeners) {
        const handler = (event: MessageEvent) => {
          try {
            const data = JSON.parse(event.data);
            this.listeners[eventType].forEach((callback) => {
              try {
                callback(data);
              } catch (error) {
                console.error(`SSE: Error in ${eventType} callback:`, error);
              }
            });
          } catch (error) {
            console.error(`SSE: Error parsing ${eventType} event data:`, error);
          }
        };
        
        this.eventHandlers.set(eventType, handler);
        this.eventSource.addEventListener(eventType, handler);
      }

      // Wait for the connection to be established or fail
      await new Promise<void>((resolve, reject) => {
        if (!this.eventSource) {
          reject(new Error('EventSource not initialized'));
          return;
        }

        const onOpen = () => {
          cleanup();
          resolve();
        };

        const onError = (event: Event) => {
          cleanup();
          reject(event);
        };

        const cleanup = () => {
          this.eventSource?.removeEventListener('open', onOpen);
          this.eventSource?.removeEventListener('error', onError);
        };

        this.eventSource.addEventListener('open', onOpen);
        this.eventSource.addEventListener('error', onError);

        // Add timeout for connection
        setTimeout(() => {
          cleanup();
          reject(new Error('Connection timeout after 10 seconds'));
        }, 10000);
      });
    } finally {
      this.isConnecting = false;
    }
  }

  private handleError(error: Event) {
    this.isConnecting = false;
    this.consecutiveErrors++;
    
    console.error(`SSE: Error occurred (attempt ${this.consecutiveErrors}):`, error);
    
    this.errorListeners.forEach(listener => {
      try {
        listener(error);
      } catch (listenerError) {
        console.error('SSE: Error in error listener:', listenerError);
      }
    });

    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    // Exponential backoff with max delay
    const backoffTime = Math.min(
      Math.pow(2, this.consecutiveErrors - 1) * this.INITIAL_RECONNECT_DELAY,
      this.MAX_RECONNECT_DELAY
    );
    
    console.log(`SSE: Reconnecting in ${backoffTime}ms...`);
    
    this.reconnectTimeout = setTimeout(() => {
      if (this.currentToken) {
        console.log('SSE: Attempting reconnection...');
        this.connect(this.currentToken).catch(error => {
          console.error('SSE: Reconnection failed:', error);
        });
      }
    }, backoffTime);
  }

  private handleHeartbeat = () => {
    this.consecutiveErrors = 0;
    console.log('SSE: Heartbeat received');
  };

  addEventListener(eventType: string, callback: EventCallback) {
    if (!this.listeners[eventType]) {
      this.listeners[eventType] = new Map();
    }
    
    const callbackId = callback.toString();
    if (!this.listeners[eventType].has(callbackId)) {
      this.listeners[eventType].set(callbackId, callback);
      console.log(`SSE: Added listener for ${eventType}`);
      
      if (this.eventSource?.readyState === EventSource.OPEN) {
        this.setupEventListeners();
      }
    }
  }

  removeEventListener(eventType: string, callback: EventCallback) {
    const callbackId = callback.toString();
    this.listeners[eventType]?.delete(callbackId);
    
    if (this.listeners[eventType]?.size === 0) {
      delete this.listeners[eventType];
      const handler = this.eventHandlers.get(eventType);
      if (handler && this.eventSource) {
        this.eventSource.removeEventListener(eventType, handler);
        this.eventHandlers.delete(eventType);
      }
    }
    console.log(`SSE: Removed listener for ${eventType}`);
  }

  addErrorListener(callback: ErrorCallback) {
    this.errorListeners.add(callback);
  }

  removeErrorListener(callback: ErrorCallback) {
    this.errorListeners.delete(callback);
  }

  disconnect() {
    console.log('SSE: Disconnecting...');
    
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }

    this.eventHandlers.clear();
    this.isConnecting = false;
    this.consecutiveErrors = 0;
    this.currentToken = null;
    this.lastEventId = null;
    
    console.log('SSE: Disconnected');
  }
}

export default SSEManager; 