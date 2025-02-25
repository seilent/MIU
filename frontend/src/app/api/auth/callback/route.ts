import { NextRequest, NextResponse } from 'next/server';
import env from '@/utils/env';

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const code = searchParams.get('code');

  if (!code) {
    return NextResponse.json({ error: 'No code provided' }, { status: 400 });
  }

  try {
    // Forwarding auth callback to backend
    const response = await fetch(`${env.apiUrl}/api/auth/callback?code=${code}`, {
      method: 'GET',
      headers: {
        'X-Internal-Request': 'true'
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      // Backend auth callback failed
      return NextResponse.json({ error: 'Authentication failed' }, { status: response.status });
    }

    // Return the response from the backend
    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    // Auth callback API route error
    return NextResponse.json({ error: 'Authentication failed' }, { status: 500 });
  }
} 