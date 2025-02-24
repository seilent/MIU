import { NextRequest, NextResponse } from 'next/server';
import env from '@/utils/env';

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const code = searchParams.get('code');

  if (!code) {
    return NextResponse.json({ error: 'No code provided' }, { status: 400 });
  }

  try {
    // Use HTTP for local development to avoid SSL issues
    const backendUrl = process.env.NODE_ENV === 'development'
      ? 'http://localhost:3000/api/auth/callback'
      : `${env.apiUrl}/api/auth/callback`;
    
    console.log('API route: Forwarding auth callback to backend', {
      code: code.substring(0, 5) + '...',
      backendUrl,
      nodeEnv: process.env.NODE_ENV
    });

    const response = await fetch(`${backendUrl}?code=${code}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'X-Internal-Request': 'true'
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Backend auth callback failed:', errorText);
      return NextResponse.json(
        { error: 'Failed to authenticate with backend' },
        { status: response.status }
      );
    }

    // Return the response from the backend
    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('Auth callback API route error:', error);
    return NextResponse.json(
      { error: 'Server error during authentication' },
      { status: 500 }
    );
  }
} 