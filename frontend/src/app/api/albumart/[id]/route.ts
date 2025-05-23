import { NextRequest } from 'next/server';
import env from '@/utils/env';
import { NextResponse } from 'next/server';

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params;
  const searchParams = request.nextUrl.searchParams;
  const square = searchParams.get('square');
  
  try {
    // Construct URL with query parameters if present
    let url = `${env.apiUrl}/api/albumart/${id}`;
    if (square) {
      url += `?square=${square}`;
    }
    
    const response = await fetch(url, {
      headers: {
        'X-Internal-Request': 'true'
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch album art: ${response.status}`);
    }

    const blob = await response.blob();
    return new Response(blob, {
      headers: {
        'Content-Type': response.headers.get('Content-Type') || 'image/jpeg',
        'Cache-Control': 'public, max-age=31536000, immutable'
      }
    });
  } catch (error) {
    // Album art fetch error
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
} 