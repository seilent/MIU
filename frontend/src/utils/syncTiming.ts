/**
 * Utility for precise playback synchronization using the Performance API
 */

/**
 * Measures the one-way network latency using the Performance API
 * @returns Promise that resolves to the estimated one-way latency in milliseconds
 */
export const measureNetworkLatency = async (): Promise<number> => {
  // Start timing using high-precision performance timer
  const startTime = performance.now();
  
  try {
    // Make a simple request to the server
    const response = await fetch('/api/music/ping');
    
    if (!response.ok) {
      throw new Error('Network latency measurement failed');
    }
    
    // Calculate round-trip time
    const roundTripTime = performance.now() - startTime;
    
    // Estimate one-way latency (half of round-trip)
    const oneWayLatency = roundTripTime / 2;
    
    // Log for debugging
    console.log(`Measured one-way network latency: ${oneWayLatency.toFixed(2)}ms`);
    
    return oneWayLatency;
  } catch (error) {
    console.error('Failed to measure network latency:', error);
    // Return a conservative default value
    return 100;
  }
};

/**
 * Stores the latest measured network latency
 */
let lastMeasuredLatency: number | null = null;

/**
 * Gets the current network latency, measuring it if not already available
 */
export const getNetworkLatency = async (): Promise<number> => {
  if (lastMeasuredLatency === null) {
    lastMeasuredLatency = await measureNetworkLatency();
  }
  return lastMeasuredLatency;
};

/**
 * Calculates the time until a scheduled play event should occur
 * 
 * @param serverPlayTimestamp The server's timestamp when playback should begin (from server time)
 * @param serverTimestamp The server's current timestamp when sending the message
 * @param receivedTimestamp The performance.now() value when message was received
 * @returns Time in milliseconds until playback should start (negative if already passed)
 */
export const calculateTimeUntilPlay = async (
  serverPlayTimestamp: number,
  serverTimestamp: number,
  receivedTimestamp: number
): Promise<number> => {
  // Current high-precision time
  const now = performance.now();
  
  // Get the estimated one-way network latency
  const latency = await getNetworkLatency();
  
  // Time passed since we received the message
  const timePassedSinceReceived = now - receivedTimestamp;
  
  // Time buffer provided by the server (difference between play time and message send time)
  const serverBuffer = serverPlayTimestamp - serverTimestamp;
  
  // Calculate time until playback should begin:
  // Server buffer (e.g. 500ms) - time passed since we received message - network latency
  const timeUntilPlay = serverBuffer - timePassedSinceReceived - latency;
  
  console.log(`Sync timing calculation:
    Server buffer: ${serverBuffer.toFixed(2)}ms
    Time since message: ${timePassedSinceReceived.toFixed(2)}ms
    Network latency: ${latency.toFixed(2)}ms
    Time until play: ${timeUntilPlay.toFixed(2)}ms`);
  
  return timeUntilPlay;
};

/**
 * Schedules a function to run at a precise time using performance timing
 * 
 * @param callback Function to call at the scheduled time
 * @param delayMs Time in milliseconds to wait before calling
 * @returns Timer ID that can be used to cancel the scheduled callback
 */
export const scheduleWithPrecision = (callback: () => void, delayMs: number): number => {
  // If delay is negative, run immediately
  if (delayMs <= 0) {
    callback();
    return 0;
  }
  
  // For very short delays, just use setTimeout
  if (delayMs < 25) {
    return window.setTimeout(callback, delayMs) as unknown as number;
  }
  
  // For longer delays, use a combination of setTimeout and requestAnimationFrame
  // for higher precision near the target time
  const targetTime = performance.now() + delayMs;
  
  // Initial timeout (fire 25ms before target time)
  const timeoutId = window.setTimeout(() => {
    const remainingTime = targetTime - performance.now();
    
    if (remainingTime <= 0) {
      // Already passed the target time
      callback();
      return;
    }
    
    // Use requestAnimationFrame for the final approach to the target time
    const rafHandler = () => {
      const now = performance.now();
      if (now >= targetTime) {
        callback();
      } else {
        requestAnimationFrame(rafHandler);
      }
    };
    
    requestAnimationFrame(rafHandler);
  }, delayMs - 25);
  
  return timeoutId;
}; 