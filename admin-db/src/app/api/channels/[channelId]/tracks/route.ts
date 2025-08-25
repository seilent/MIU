import prisma from '@/../lib/prisma'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET(
  request: Request,
  { params }: { params: { channelId: string } }
) {
  try {
    const { channelId } = params;
    
    const tracks = await prisma.track.findMany({
      where: { channelId },
      select: {
        youtubeId: true,
        title: true,
        duration: true,
        status: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' }
    })

    return NextResponse.json(tracks)
  } catch (error) {
    console.error('Failed to fetch channel tracks:', error)
    return NextResponse.json(
      { error: 'Failed to fetch channel tracks' },
      { status: 500 }
    )
  }
}
