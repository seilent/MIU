import { NextRequest, NextResponse } from 'next/server';
import { ImageResponse } from 'next/og';
import env from '@/utils/env';

// Route segment config
export const runtime = 'edge';

// Function to get the current playing track
async function getCurrentTrack() {
  try {
    const response = await fetch(`${env.apiUrl}/api/music/current`, {
      headers: {
        'X-Internal-Request': 'true'
      },
      next: { revalidate: 10 } // Revalidate every 10 seconds
    });

    if (!response.ok) {
      console.error(`Failed to fetch current track: ${response.status} ${response.statusText}`);
      throw new Error(`Failed to fetch current track: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data.currentTrack || null;
  } catch (error) {
    console.error('Error fetching current track:', error);
    return null;
  }
}

// Default image in case no track is playing
const DEFAULT_IMAGE = `${env.apiUrl || 'https://miu.gacha.boo'}/images/DEFAULT.jpg`;

export async function GET(request: NextRequest) {
  try {
    // Get the current playing track
    const currentTrack = await getCurrentTrack();
    
    // If a track is playing, return dynamic OpenGraph meta tags
    if (currentTrack) {
      const thumbnailUrl = currentTrack.thumbnail.includes('?') 
        ? `${currentTrack.thumbnail}&t=${Date.now()}`  // Add timestamp to bypass cache
        : `${currentTrack.thumbnail}?t=${Date.now()}`;
        
      // Use square album art for better display in Discord
      const albumArtUrl = thumbnailUrl.includes('/api/albumart/') && !thumbnailUrl.includes('square=')
        ? `${thumbnailUrl}&square=1`
        : thumbnailUrl;
        
      const username = currentTrack.requestedBy?.username || 'MIU';
      
      // Generate an OpenGraph image with the track info and album art
      try {
        // Define the JSX for the OG image
        return new ImageResponse(
          (
            <div 
              style={{
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                width: '1200px',
                height: '630px',
                backgroundColor: '#090909',
                padding: '40px',
                color: '#f5f5f5',
                fontFamily: 'sans-serif',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  width: '60%',
                  padding: '20px',
                }}
              >
                <div style={{ fontSize: '40px', fontWeight: 'bold', marginBottom: '10px' }}>
                  MIU
                </div>
                <div style={{ fontSize: '60px', fontWeight: 'bold', marginBottom: '20px', color: '#f1c0e8' }}>
                  Now Playing
                </div>
                <div style={{ fontSize: '36px', marginBottom: '10px', wordBreak: 'break-word' }}>
                  {currentTrack.title}
                </div>
                <div style={{ fontSize: '24px', color: '#a0a0a0' }}>
                  Requested by: {username}
                </div>
              </div>
              <div
                style={{
                  width: '400px',
                  height: '400px',
                  borderRadius: '20px',
                  overflow: 'hidden',
                  border: '10px solid rgba(241, 192, 232, 0.3)',
                }}
              >
                <img
                  src={albumArtUrl}
                  alt={currentTrack.title}
                  style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                  }}
                />
              </div>
            </div>
          ),
          {
            width: 1200,
            height: 630,
          }
        );
      } catch (error) {
        console.error('Error generating OG image:', error);
        
        // Return a static response if image generation fails
        return NextResponse.json(
          {
            title: `Now Playing: ${currentTrack.title}`,
            description: `Requested by ${username}`,
            image: albumArtUrl,
          },
          {
            headers: {
              'Content-Type': 'application/json',
            },
          }
        );
      }
    }
    
    // Default response when no track is playing
    return NextResponse.json(
      {
        title: 'MIU',
        description: 'Collaborative music player for Discord communities',
        image: DEFAULT_IMAGE,
      },
      {
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (error) {
    console.error('Error in OG route:', error);
    
    // Return an error response for debugging
    try {
      return new ImageResponse(
        (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              width: '1200px',
              height: '630px',
              backgroundColor: '#ff0000',
              padding: '40px',
              color: '#ffffff',
              fontFamily: 'sans-serif',
            }}
          >
            <div style={{ fontSize: '48px', fontWeight: 'bold', marginBottom: '20px' }}>
              Error in OG Route
            </div>
            <div style={{ fontSize: '24px', wordBreak: 'break-word', maxWidth: '80%', textAlign: 'center' }}>
              {error instanceof Error ? error.message : String(error)}
            </div>
          </div>
        ),
        {
          width: 1200,
          height: 630,
        }
      );
    } catch (imgError) {
      // Fallback if image generation fails
      return NextResponse.json(
        {
          title: 'MIU - Error',
          description: error instanceof Error ? error.message : String(error),
          image: DEFAULT_IMAGE,
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );
    }
  }
} 