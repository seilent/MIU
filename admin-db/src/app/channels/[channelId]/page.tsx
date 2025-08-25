'use client'
import { use } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'

interface Channel {
  id: string
  title: string
  isBlocked: boolean
  createdAt: Date
  updatedAt: Date
}

interface Track {
  youtubeId: string
  title: string
  duration: number
  status: string
  createdAt: Date
}

async function fetchChannelData(channelId: string) {
  const [channelRes, tracksRes] = await Promise.all([
    fetch(`${window.location.origin}/api/channels/${channelId}`),
    fetch(`${window.location.origin}/api/channels/${channelId}/tracks`)
  ])

  if (!channelRes.ok || !tracksRes.ok) {
    throw new Error('Failed to fetch channel data')
  }

  return {
    channel: await channelRes.json(),
    tracks: await tracksRes.json(),
    error: null
  }
}

export default function ChannelDetailPage() {
  const params = useParams()
  const channelId = params.channelId as string
  const router = useRouter()
  const { channel, tracks, error } = use(fetchChannelData(channelId))

  const handleHideChannel = async () => {
    if (!confirm('Are you sure you want to hide this channel from track listings?')) return
    
    try {
      const response = await fetch(`/api/channels/${channelId}/hide`, {
        method: 'POST'
      })

      if (!response.ok) {
        throw new Error('Failed to hide channel')
      }

      router.refresh()
    } catch (err: any) {
      alert(`Error: ${err.message}`)
    }
  }

  if (error) return <div className="container mx-auto p-4 text-red-500">Error: {error}</div>
  if (!channel) return <div className="container mx-auto p-4">Channel not found</div>

  return (
    <div className="container mx-auto p-4">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">{channel.title}</h1>
        <div className="text-sm text-gray-500 mb-4">Channel ID: {channel.id}</div>
        
        <div className="flex items-center gap-4 mb-6">
          <span className={`px-3 py-1 rounded-full text-sm ${
            channel.isBlocked 
              ? 'bg-red-100 text-red-800' 
              : 'bg-green-100 text-green-800'
          }`}>
            {channel.isBlocked ? 'Blocked' : 'Active'}
          </span>

          <button 
            onClick={handleHideChannel}
            className="px-4 py-2 bg-yellow-500 text-white rounded hover:bg-yellow-600"
          >
            Hide Channel
          </button>
        </div>
      </div>

      <h2 className="text-xl font-semibold mb-4">Tracks ({tracks.length})</h2>
      <div className="overflow-x-auto">
        <table className="min-w-full bg-white">
          <thead>
            <tr>
              <th className="py-2 px-4 border-b">Title</th>
              <th className="py-2 px-4 border-b">Duration</th>
              <th className="py-2 px-4 border-b">Status</th>
              <th className="py-2 px-4 border-b">Added</th>
            </tr>
          </thead>
          <tbody>
            {tracks.map((track: Track) => (
              <tr key={track.youtubeId}>
                <td className="py-2 px-4 border-b">
                  <Link 
                    href={`/tracks/${track.youtubeId}`}
                    className="text-blue-500 hover:underline"
                  >
                    {track.title}
                  </Link>
                </td>
                <td className="py-2 px-4 border-b">
                  {new Date(track.duration * 1000).toISOString().substr(11, 8)}
                </td>
                <td className="py-2 px-4 border-b">
                  <span className={`px-2 py-1 rounded-full text-xs ${
                    track.status === 'BLOCKED'
                      ? 'bg-red-100 text-red-800'
                      : 'bg-green-100 text-green-800'
                  }`}>
                    {track.status}
                  </span>
                </td>
                <td className="py-2 px-4 border-b">
                  {new Date(track.createdAt).toLocaleDateString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
