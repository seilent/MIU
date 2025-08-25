import { readFileSync } from 'fs'
import { NextResponse } from 'next/server'
import path from 'path'

const hiddenChannelsPath = path.join(process.cwd(), 'src/lib/hiddenChannels.json')

export async function GET() {
  try {
    const hiddenChannels = JSON.parse(readFileSync(hiddenChannelsPath, 'utf-8'))
    return NextResponse.json(hiddenChannels)
  } catch (error) {
    console.error('Failed to get hidden channels:', error)
    return NextResponse.json(
      { error: 'Failed to get hidden channels' },
      { status: 500 }
    )
  }
}
