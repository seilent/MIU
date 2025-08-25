'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'

interface Track {
  youtubeId: string
  isMusicUrl: boolean
  title: string
  duration: number
  playCount: number
  skipCount: number
  status: string
  channelId: string | null
  channel: {
    title: string
    isBlocked: boolean
    _count: {
      tracks: number
    }
  } | null
  createdAt: Date
  lastPlayed: Date | null
  isRecommended?: boolean
}

export default function TracksPage() {
  const searchParams = useSearchParams()
  const [tracks, setTracks] = useState<Track[]>([])
  const [loading, setLoading] = useState(true)

  const hideBlocked = searchParams.get('hideBlocked') === null 
    ? true 
    : searchParams.get('hideBlocked') !== 'false'
  const hideBlockedChannels = searchParams.get('hideBlockedChannels') === null 
    ? true 
    : searchParams.get('hideBlockedChannels') !== 'false'
  const uniqueChannels = searchParams.get('uniqueChannels') === null 
    ? true 
    : searchParams.get('uniqueChannels') !== 'false'
  const sortBy = searchParams.get('sortBy') || 'createdAt'
  const sortDirection = searchParams.get('sortDirection') || 'desc'
  const includeRecommendations = searchParams.get('includeRecommendations') === null 
    ? true 
    : searchParams.get('includeRecommendations') !== 'false'

  useEffect(() => {
    const fetchTracks = async () => {
      try {
        setLoading(true)
        const res = await fetch(
          `/api/tracks?hideBlocked=${hideBlocked}&hideBlockedChannels=${hideBlockedChannels}&sortBy=${sortBy}&sortDirection=${sortDirection}&includeRecommendations=${includeRecommendations}`
        )
        const data = await res.json()
        setTracks(data)
      } catch (error) {
        console.error('Failed to fetch tracks:', error)
      } finally {
        setLoading(false)
      }
    }
    fetchTracks()
  }, [hideBlocked, hideBlockedChannels, sortBy, sortDirection])

  const filteredTracks = uniqueChannels 
    ? Array.from(
        tracks.reduce((map, track) => {
          if (!map.has(track.channelId)) {
            // Get all tracks for this channel (filtered by hideBlocked if enabled)
            const channelTracks = tracks.filter(t => 
              t.channelId === track.channelId && 
              (!hideBlocked || t.status !== 'BLOCKED') &&
              (!hideBlockedChannels || !t.channel?.isBlocked)
            )
            // Select random track if available
            if (channelTracks.length > 0) {
              const randomTrack = channelTracks[
                Math.floor(Math.random() * channelTracks.length)
              ]
              map.set(track.channelId, randomTrack)
            }
          }
          return map
        }, new Map<string | null, Track>()).values()
      )
    : tracks

  return (
<div className="container mx-auto p-4">
  <div className="flex justify-between items-center mb-6">
    <h1 className="text-2xl font-bold">Track Management</h1>
  <div className="flex items-center gap-4">
    <div className="flex items-center">
      <select 
        value={sortBy}
        onChange={(e) => {
          const params = new URLSearchParams(searchParams.toString())
          params.set('sortBy', e.target.value)
          window.location.search = params.toString()
        }}
        className="bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 p-2"
      >
        <option value="createdAt">Date Added</option>
        <option value="title">Name</option>
        <option value="lastPlayed">Last Played</option>
        <option value="playCount">Play Count</option>
        <option value="channel._count.tracks">Channel Tracks</option>
      </select>
      <button
        type="button"
        onClick={() => {
          const newDirection = sortDirection === 'asc' ? 'desc' : 'asc'
          const params = new URLSearchParams(searchParams.toString())
          params.set('sortDirection', newDirection)
          window.location.search = params.toString()
        }}
        className="ml-2 px-3 py-1 bg-gray-200 rounded hover:bg-gray-300"
      >
        {sortDirection === 'asc' ? '↑' : '↓'}
      </button>
    </div>
    <div className="flex items-center">
    <input 
      type="checkbox" 
      id="hideBlocked"
      checked={hideBlocked}
      onChange={(e) => {
        const params = new URLSearchParams(searchParams.toString())
        params.set('hideBlocked', String(e.target.checked))
        window.location.search = params.toString()
      }}
      className="w-4 h-4 text-blue-600 bg-gray-100 border-gray-300 rounded focus:ring-blue-500"
    />
    <label htmlFor="hideBlocked" className="ml-2 text-sm font-medium text-gray-900">
      Hide blocked tracks
    </label>
    <input 
      type="checkbox" 
      id="hideBlockedChannels"
      checked={hideBlockedChannels}
      onChange={(e) => {
        const params = new URLSearchParams(searchParams.toString())
        params.set('hideBlockedChannels', String(e.target.checked))
        window.location.search = params.toString()
      }}
      className="w-4 h-4 text-blue-600 bg-gray-100 border-gray-300 rounded focus:ring-blue-500 ml-4"
    />
    <label htmlFor="hideBlockedChannels" className="ml-2 text-sm font-medium text-gray-900">
      Hide blocked channels
    </label>
    <input 
      type="checkbox" 
      id="uniqueChannels"
      checked={uniqueChannels}
      onChange={(e) => {
        const params = new URLSearchParams(searchParams.toString())
        params.set('uniqueChannels', String(e.target.checked))
        window.location.search = params.toString()
      }}
      className="w-4 h-4 text-blue-600 bg-gray-100 border-gray-300 rounded focus:ring-blue-500 ml-4"
    />
    <label htmlFor="uniqueChannels" className="ml-2 text-sm font-medium text-gray-900">
      Show one track per channel
    </label>
    <input 
      type="checkbox" 
      id="includeRecommendations"
      checked={includeRecommendations}
      onChange={(e) => {
        const params = new URLSearchParams(searchParams.toString())
        params.set('includeRecommendations', String(e.target.checked))
        window.location.search = params.toString()
      }}
      className="w-4 h-4 text-purple-600 bg-gray-100 border-gray-300 rounded focus:ring-purple-500 ml-4"
    />
    <label htmlFor="includeRecommendations" className="ml-2 text-sm font-medium text-gray-900">
      Include Recommendations
    </label>
    </div>
  </div>
  </div>
      
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filteredTracks.map((track: Track) => (
          <div key={track.youtubeId} className="border rounded-lg p-4">
            <img 
              src={`https://img.youtube.com/vi/${track.youtubeId}/mqdefault.jpg`}
              alt={track.title}
              className="w-full rounded mb-2"
            />
<div className="font-medium">{track.title}</div>
<div className="text-xs text-gray-500">YouTube ID: {track.youtubeId}</div>
<div className="text-sm text-gray-500">
              {track.channel ? (
                <Link 
                  href={`/channels/${track.channelId}`} 
                  className="text-blue-500 hover:underline"
                >
                  {track.channel.title}
                </Link>
              ) : 'No channel'}
            </div>
            <div className="mt-2 flex justify-between items-center">
<span className={`px-2 py-1 text-xs rounded ${
  track.status === 'BLOCKED' 
    ? 'bg-red-100 text-red-800' 
    : track.isRecommended
      ? 'bg-purple-100 text-purple-800'
      : 'bg-green-100 text-green-800'
}`}>
  {track.isRecommended ? 'RECOMMENDED' : track.status}
</span>
{track.isMusicUrl && (
  <span className="px-2 py-1 bg-blue-100 text-blue-800 text-xs rounded ml-2">
    YT Music
  </span>
)}
              <div className="space-x-2">
                <button 
                  onClick={async (e) => {
                    const button = e.currentTarget
                    const originalText = button.textContent
                    const command = `/ban id id:${track.youtubeId} block_channel:true`
                    
                    try {
                      await navigator.clipboard.writeText(command)
                      button.textContent = '✓ Copied!'
                      button.classList.add('bg-green-500')
                      button.classList.remove('bg-gray-500')
                    } catch (error) {
                      // Silent fallback
                      const textarea = document.createElement('textarea')
                      textarea.value = command
                      document.body.appendChild(textarea)
                      textarea.select()
                      document.execCommand('copy')
                      document.body.removeChild(textarea)
                      button.textContent = '✓ Copied!'
                      button.classList.add('bg-green-500')
                      button.classList.remove('bg-gray-500')
                    }

                    setTimeout(() => {
                      button.textContent = originalText
                      button.classList.remove('bg-green-500')
                      button.classList.add('bg-gray-500')
                    }, 2000)
                  }}
                  className="px-3 py-1 bg-gray-500 text-white rounded hover:bg-gray-600 text-sm"
                >
                  Copy Ban Command
                </button>
                {track.channelId && (
                  <button 
                    onClick={async () => {
                      try {
                        await fetch(`/api/channels/${track.channelId}/hide`, {
                          method: 'POST'
                        })
                      } catch (err: any) {
                        console.error('Failed to hide channel:', err)
                      }
                    }}
                    className="px-3 py-1 bg-yellow-500 text-white rounded hover:bg-yellow-600 text-sm"
                  >
                    Hide CH
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
