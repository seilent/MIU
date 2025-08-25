import { NextResponse } from 'next/server'
import prisma from '@/../lib/prisma'
import { TrackStatus } from '@prisma/client'
import { readFileSync } from 'fs'
import path from 'path'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const hideBlocked = searchParams.get('hideBlocked') === 'true'
  const hideHiddenChannels = searchParams.get('hideHiddenChannels') !== 'false'
  const sortBy = searchParams.get('sortBy') || 'createdAt'
  const sortDirection = searchParams.get('sortDirection') || 'desc'
  const includeRecommendations = searchParams.get('includeRecommendations') !== 'false'

  // Get hidden channels if needed
  const hiddenChannelsPath = path.join(process.cwd(), 'src/lib/hiddenChannels.json')
  const hiddenChannels: string[] = hideHiddenChannels 
    ? JSON.parse(readFileSync(hiddenChannelsPath, 'utf-8')) 
    : []

  // First get all channels with their track counts if needed
  const channelCounts = new Map<string, number>()
  if (sortBy === 'channel._count.tracks') {
    const channels = await prisma.channel.findMany({
      include: { 
        _count: { 
          select: { tracks: true } 
        } 
      }
    })
    channels.forEach((channel: { id: string, _count: { tracks: number } }) => {
      channelCounts.set(channel.id, channel._count.tracks)
    })
  }

  // Fetch tracks with optional recommendations
  let tracks = await prisma.track.findMany({
    include: { 
      channel: {
        include: {
          _count: {
            select: { tracks: true }
          }
        }
      } 
    },
    where: {
      AND: [
        ...(hideBlocked ? [{ NOT: { status: TrackStatus.BLOCKED } }] : []),
        ...(hideBlocked ? [{ channel: { isBlocked: false } }] : []),
        ...(hideHiddenChannels ? [{ NOT: { channelId: { in: hiddenChannels } } }] : [])
      ]
    }
  })

  // Include recommendations if requested
  if (includeRecommendations) {
    const recommendations = await prisma.youtubeRecommendation.findMany({
      where: { wasPlayed: false },
      select: {
        youtubeId: true,
        title: true,
        createdAt: true
      }
    })

    // Format recommendations to match full Track interface
    const formattedRecs = recommendations.map(rec => ({
      youtubeId: rec.youtubeId,
      title: rec.title || 'Recommended Track',
      isMusicUrl: false,
      duration: 0,
      playCount: 0,
      skipCount: 0,
      status: TrackStatus.STANDBY,
      channelId: null,
      channel: null,
      createdAt: rec.createdAt,
      lastPlayed: null,
      isRecommended: true,
      // Additional required fields from Track model
      updatedAt: rec.createdAt,
      resolvedYtId: null,
      globalScore: 0,
      isActive: true,
      lastValidated: null
    }))

    // Merge and dedupe (prefer tracks over recommendations)
    tracks = [...tracks, ...formattedRecs].reduce((acc, track) => {
      if (!acc.some(t => t.youtubeId === track.youtubeId)) {
        acc.push(track)
      }
      return acc
    }, [] as typeof tracks)
  }

  // Apply sorting
  if (sortBy === 'channel._count.tracks') {
    tracks = tracks.sort((a, b) => {
      const aCount = a.channelId ? channelCounts.get(a.channelId) || 0 : 0
      const bCount = b.channelId ? channelCounts.get(b.channelId) || 0 : 0
      return sortDirection === 'asc' ? aCount - bCount : bCount - aCount
    })
  } else {
    tracks = tracks.sort((a, b) => {
      const aValue = a[sortBy as keyof typeof a]
      const bValue = b[sortBy as keyof typeof b]
      if (aValue === null || aValue === undefined) return 1
      if (bValue === null || bValue === undefined) return -1
      if (aValue < bValue) return sortDirection === 'asc' ? -1 : 1
      if (aValue > bValue) return sortDirection === 'asc' ? 1 : -1
      return 0
    })
  }

  return NextResponse.json(tracks)
}
