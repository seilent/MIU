import { readFileSync, writeFileSync } from 'fs'
import { NextResponse } from 'next/server'
import path from 'path'

const hiddenChannelsPath = path.join(process.cwd(), 'src/lib/hiddenChannels.json')

export async function POST(
  request: Request,
  { params }: { params: { channelId: string } }
) {
  try {
    // Read current hidden channels
    const hiddenChannels = JSON.parse(readFileSync(hiddenChannelsPath, 'utf-8'))
    
    // Remove channel if it exists
    const updatedChannels = hiddenChannels.filter((id: string) => id !== params.channelId)
    writeFileSync(hiddenChannelsPath, JSON.stringify(updatedChannels, null, 2))

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Failed to show channel:', error)
    return NextResponse.json(
      { error: 'Failed to show channel' },
      { status: 500 }
    )
  }
}
