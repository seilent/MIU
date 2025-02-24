import { NextRequest } from 'next/server';
import env from '@/utils/env';

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params;
  
  try {
    const response = await fetch(`${env.apiUrl}/api/albumart/${id}`, {
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
    console.error('Album art fetch error:', error);
    return new Response('Failed to fetch album art', { status: 500 });
  }
} 