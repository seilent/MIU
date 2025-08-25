import prisma from '@/../lib/prisma'
import { NextResponse } from 'next/server'

export async function GET() {
  try {
    const channels = await prisma.channel.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { tracks: true } } }
    })
    
    return NextResponse.json(channels)
  } catch (error) {
    console.error('Failed to fetch channels:', error)
    return NextResponse.json(
      { error: 'Failed to fetch channels' },
      { status: 500 }
    )
  }
}
