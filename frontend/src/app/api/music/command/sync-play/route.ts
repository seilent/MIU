import { NextRequest, NextResponse } from 'next/server';
import env from '@/utils/env';

/**
 * API route to request synchronized playback across all connected clients
 * 
 * This endpoint sends a sync_play event to all connected clients with
 * precise timing information to ensure synchronized playback
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { trackId, position, bufferTime = 500 } = body;
    
    if (!trackId) {
      return NextResponse.json(
        { error: 'Missing track ID' },
        { status: 400 }
      );
    }
    
    // Get the current server time
    const serverTime = Date.now();
    
    // Set the play time in the future to allow clients to prepare
    // Default buffer is 500ms but can be customized
    const playAt = serverTime + bufferTime;
    
    // Forward the request to the backend
    const response = await fetch(`${env.apiUrl}/api/music/command/sync-play`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': request.headers.get('Authorization') || '',
        'X-Internal-Request': 'true'
      },
      body: JSON.stringify({
        trackId,
        position,
        serverTime,
        playAt
      })
    });
    
    if (!response.ok) {
      const error = await response.text();
      console.error('Failed to send sync play command:', error);
      return NextResponse.json(
        { error: 'Failed to send sync play command' },
        { status: response.status }
      );
    }
    
    return NextResponse.json({
      success: true,
      trackId,
      serverTime,
      playAt
    });
  } catch (error) {
    console.error('Error processing sync play command:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
} 