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
      this.eventSource.close();
      this.eventSource = null;
    }
    
    if (!token || token === 'undefined') {
      throw new Error('SSE: Cannot establish connection - Invalid token');
    }
    
    this.isConnecting = true;
    this.currentToken = token;

    return new Promise((resolve, reject) => {
      try {
        const url = new URL(`${env.apiUrl}/api/music/state/live`);
        url.searchParams.append('token', token);
        url.searchParams.append('_', Date.now().toString());
        if (this.lastEventId) {
          url.searchParams.append('lastEventId', this.lastEventId);
        }
        
        this.eventSource = new EventSource(url.toString(), {
          withCredentials: true
        });

        this.eventSource.onopen = () => {
          console.log('SSE: Connection opened');
          this.consecutiveErrors = 0;
          this.isConnecting = false;
          this.setupEventListeners();
          resolve();
        };

        this.eventSource.onerror = (error) => {
          console.error('SSE: Connection error:', error);
          this.handleError(error);
          reject(error);
        };

        // Add message handler for lastEventId tracking
        this.eventSource.onmessage = (event) => {
          this.lastEventId = event.lastEventId;
        };

      } catch (error) {
        console.error('SSE: Setup error:', error);
        this.handleError(error as Event);
        reject(error);
      }
    });
  }

  private setupEventListeners() {
    if (!this.eventSource) return;

    // Clear existing event listeners
    this.eventHandlers.forEach((handler, eventType) => {
      this.eventSource?.removeEventListener(eventType, handler);
    });
    this.eventHandlers.clear();

    // Add heartbeat handler
    const heartbeatHandler = () => this.handleHeartbeat();
    this.eventSource.addEventListener('heartbeat', heartbeatHandler);
    this.eventHandlers.set('heartbeat', heartbeatHandler);

    // Set up event listeners for each registered event type
    Object.entries(this.listeners).forEach(([eventType, listeners]) => {
      const handler = (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data);
          this.lastEventId = event.lastEventId; // Track lastEventId
          listeners.forEach(listener => {
            try {
              listener(data);
            } catch (error) {
              console.error(`SSE: Error in listener for ${eventType}:`, error);
            }
          });
        } catch (error) {
          console.error(`SSE: Error handling ${eventType} event:`, error);
        }
      };

      this.eventSource?.addEventListener(eventType, handler);
      this.eventHandlers.set(eventType, handler);
    });
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