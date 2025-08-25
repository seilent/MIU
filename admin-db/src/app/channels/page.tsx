'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'

interface Channel {
  id: string
  title: string
  isBlocked: boolean
  blockedAt: Date | null
  blockedReason: string | null
  createdAt: Date
  updatedAt: Date
  _count: {
    tracks: number
  }
}

export default function ChannelsPage() {
  const [channels, setChannels] = useState<Channel[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fetchChannels = async () => {
      try {
        const response = await fetch('/api/channels')
        if (!response.ok) {
          throw new Error(`Failed to fetch channels: ${response.status} ${response.statusText}`)
        }
        const data = await response.json()
        setChannels(data)
        setError(null)
      } catch (err: any) {
        setError(err.message || 'An unknown error occurred')
      } finally {
        setLoading(false)
      }
    }

    fetchChannels()
  }, [])

  if (loading) {
    return <div className="container mx-auto p-4">Loading channel data...</div>
  }

  if (error) {
    return (
      <div className="container mx-auto p-4">
        <h1 className="text-2xl font-bold mb-4">Channel Management</h1>
        <div className="text-red-500 bg-red-50 p-4 rounded-md">Error: {error}</div>
      </div>
    )
  }

  return (
    <div className="container mx-auto p-4">
      <h1 className="text-2xl font-bold mb-6">Channel Management</h1>
      
      <div className="overflow-x-auto">
        <table className="min-w-full bg-white">
          <thead>
            <tr>
              <th className="py-2 px-4 border-b">Channel</th>
              <th className="py-2 px-4 border-b">Tracks</th>
              <th className="py-2 px-4 border-b">Status</th>
              <th className="py-2 px-4 border-b">Actions</th>
            </tr>
          </thead>
          <tbody>
            {channels.map((channel) => (
              <tr key={channel.id}>
                <td className="py-2 px-4 border-b">
                  <Link 
                    href={`/channels/${channel.id}`}
                    className="font-medium text-blue-500 hover:underline"
                  >
                    {channel.title}
                  </Link>
                  <div className="text-sm text-gray-500">{channel.id}</div>
                </td>
                <td className="py-2 px-4 border-b">{channel._count.tracks}</td>
                <td className="py-2 px-4 border-b">
                  {channel.isBlocked ? (
                    <span className="text-red-500">Blocked</span>
                  ) : (
                    <span className="text-green-500">Active</span>
                  )}
                </td>
                <td className="py-2 px-4 border-b">
                  {channel.isBlocked ? (
                    <button className="px-4 py-2 border rounded hover:bg-gray-100">Unblock</button>
                  ) : (
                    <button 
                      onClick={async () => {
                        if (!confirm('Are you sure you want to ban this channel?')) return
                        try {
                          const response = await fetch(`/api/channels/${channel.id}/ban`, {
                            method: 'POST'
                          })
                          if (!response.ok) throw new Error('Ban failed')
                          window.location.reload()
                        } catch (err) {
                          alert(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`)
                        }
                      }}
                      className="px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600"
                    >
                      Ban Channel
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
