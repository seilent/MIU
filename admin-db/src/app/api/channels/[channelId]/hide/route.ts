import { NextRequest, NextResponse } from 'next/server'
import { readFileSync, writeFileSync } from 'fs'
import path from 'path'

export async function POST(
  request: NextRequest,
  { params }: { params: { channelId: string } }
) {
  try {
    const { channelId } = params
    const hiddenChannelsPath = path.join(process.cwd(), 'src/lib/hiddenChannels.json')
    const hiddenChannels = JSON.parse(readFileSync(hiddenChannelsPath, 'utf-8'))
    
    // Add channel if not already hidden
    if (!hiddenChannels.includes(channelId)) {
      hiddenChannels.push(channelId)
      writeFileSync(hiddenChannelsPath, JSON.stringify(hiddenChannels, null, 2))
    }

    return NextResponse.json({ success: true })
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    )
  }
}
