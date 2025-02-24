import { headers } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import env from '@/utils/env';

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const code = searchParams.get('code');
  const error = searchParams.get('error');
  const errorDescription = searchParams.get('error_description');

  // Handle Discord OAuth errors
  if (error) {
    console.error('Discord OAuth error:', error, errorDescription);
    return NextResponse.redirect(
      new URL(`/login?error=${error}&description=${encodeURIComponent(errorDescription || '')}`, env.url)
    );
  }

  if (!code) {
    console.error('No code provided in callback');
    return NextResponse.redirect(new URL('/login?error=no_code', env.url));
  }

  try {
    const headersList = headers();
    const requestHeaders = new Headers();
    requestHeaders.set('Accept', 'application/json');
    requestHeaders.set('X-Internal-Request', 'true');
    
    // Forward necessary headers
    const origin = headersList.get('origin');
    const cookie = headersList.get('cookie');
    const host = headersList.get('host');
    
    if (origin) requestHeaders.set('Origin', origin);
    if (cookie) requestHeaders.set('Cookie', cookie);
    if (host) requestHeaders.set('Host', host);

    // Use the configured API URL for token exchange
    const backendUrl = `${env.apiUrl}/api/auth/callback`;

    // Add retry logic for rate limiting
    let retryCount = 0;
    const maxRetries = 3;
    let response = null;
    let backoff = 1000; // Start with 1 second backoff

    while (retryCount < maxRetries) {
      response = await fetch(`${backendUrl}?code=${code}`, {
        method: 'GET',
        headers: requestHeaders,
        credentials: 'include'
      });

      // If we got a successful response or it's not a rate limit error, break out of the loop
      if (response.ok || response.status !== 429) {
        break;
      }

      // If we're rate limited, wait and retry
      console.log(`Rate limited, retrying in ${backoff}ms...`);
      await new Promise(resolve => setTimeout(resolve, backoff));
      backoff *= 2; // Exponential backoff
      retryCount++;
    }

    // If we didn't get a response after all retries, redirect to login with error
    if (!response) {
      console.error('Auth callback failed: No response after retries');
      return NextResponse.redirect(
        new URL(`/login?error=no_response`, env.url)
      );
    }

    // If response is not ok, redirect to login with error
    if (!response.ok) {
      let errorText;
      try {
        const errorData = await response.json();
        errorText = JSON.stringify(errorData);
      } catch (e) {
        errorText = await response.text();
      }
      
      console.error('Auth callback failed:', errorText);
      return NextResponse.redirect(
        new URL(`/login?error=auth_failed&status=${response.status}`, env.url)
      );
    }

    const data = await response.json();

    // Parse the response data
    const { token, user } = data;

    if (!token) {
      console.error('No token received from backend');
      return NextResponse.redirect(new URL('/login?error=no_token', env.url));
    }

    // Create the response with redirect to the public URL
    const redirectResponse = NextResponse.redirect(new URL('/', env.url));
    
    // Use the hostname from the configured URL
    const cookieDomain = new URL(env.url).hostname;

    // Set a single cookie for the token to avoid duplicates
    redirectResponse.cookies.set('auth_token', token, {
      domain: cookieDomain,
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'none',
      maxAge: 7 * 24 * 60 * 60 // 7 days
    });

    // Copy any additional cookies from the API response
    const apiCookies = response.headers.getSetCookie();
    
    // Only add API cookies that aren't for auth_token to avoid duplicates
    apiCookies
      .filter(cookie => !cookie.startsWith('auth_token='))
      .forEach(cookie => {
        redirectResponse.headers.append('Set-Cookie', cookie);
      });

    return redirectResponse;
  } catch (error) {
    console.error('Auth callback error:', error);
    return NextResponse.redirect(new URL('/login?error=server_error', env.url));
  }
}
