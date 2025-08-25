import { NextResponse } from 'next/server'
import prisma from '@/../lib/prisma'

export async function GET() {
  const recommendations = await prisma.youtubeRecommendation.findMany({
    select: {
      youtubeId: true,
      title: true,
      seedTrackId: true,
      relevanceScore: true,
      createdAt: true,
      updatedAt: true
    },
    where: {
      wasPlayed: false
    },
    orderBy: {
      relevanceScore: 'desc'
    }
  })

  // Format to match Track interface
  const formatted = recommendations.map(rec => ({
    youtubeId: rec.youtubeId,
    title: rec.title || 'Recommended Track',
    isMusicUrl: false,
    duration: 0,
    playCount: 0,
    skipCount: 0,
    status: 'STANDBY',
    channelId: null,
    channel: null,
    createdAt: rec.createdAt,
    lastPlayed: null,
    isRecommended: true
  }))

  return NextResponse.json(formatted)
}
