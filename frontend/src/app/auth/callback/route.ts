import { headers } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import env from '@/utils/env';
import { cookies } from 'next/headers';

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const code = searchParams.get('code');
  const error = searchParams.get('error');
  const errorDescription = searchParams.get('error_description');

  if (error || errorDescription) {
    // Discord OAuth error
    return NextResponse.redirect(
      new URL(`/login?error=${error || 'oauth'}&description=${encodeURIComponent(errorDescription || '')}`, env.url)
    );
  }
  
  if (!code) {
    // No code provided in callback
    return NextResponse.redirect(new URL('/login?error=no_code', env.url));
  }
  
  try {
    // Exchange code for token
    let response = null;
    let retries = 0;
    const maxRetries = 3;
    
    while (!response && retries < maxRetries) {
      try {
        response = await fetch(`${env.apiUrl}/api/auth/callback?code=${code}`, {
          method: 'GET',
          headers: {
            'X-Internal-Request': 'true'
          }
        });
      } catch (err) {
        retries++;
        if (retries >= maxRetries) throw err;
        
        // Rate limited, retrying
        const backoff = Math.pow(2, retries) * 1000;
        await new Promise(resolve => setTimeout(resolve, backoff));
      }
    }
    
    if (!response) {
      // Auth callback failed: No response after retries
      return NextResponse.redirect(new URL('/login?error=server_error', env.url));
    }
    
    if (!response.ok) {
      const errorText = await response.text();
      // Auth callback failed
      return NextResponse.redirect(
        new URL(`/login?error=auth_failed&status=${response.status}`, env.url)
      );
    }
    
    const data = await response.json();
    
    if (!data.token) {
      // No token received from backend
      return NextResponse.redirect(new URL('/login?error=no_token', env.url));
    }
    
    // Set cookies
    cookies().set('token', data.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 365 * 24 * 60 * 60, // 365 days
      path: '/'
    });
    
    // Also set a client-accessible cookie for the frontend
    cookies().set('auth_token', data.token, {
      httpOnly: false,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 365 * 24 * 60 * 60, // 365 days
      path: '/'
    });
    
    // Redirect to home page
    return NextResponse.redirect(new URL('/', env.url));
  } catch (error) {
    // Auth callback error
    return NextResponse.redirect(new URL('/login?error=server_error', env.url));
  }
}
