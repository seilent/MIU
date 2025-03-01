import { NextResponse } from 'next/server';

/**
 * Simple ping endpoint for measuring network latency
 * Returns the current server timestamp
 */
export async function GET() {
  return NextResponse.json({ 
    timestamp: Date.now(),
    ok: true
  });
} 