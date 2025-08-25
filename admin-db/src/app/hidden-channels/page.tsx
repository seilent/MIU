'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'

export default function HiddenChannelsPage() {
  const [hiddenChannels, setHiddenChannels] = useState<string[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchHiddenChannels = async () => {
      try {
        const res = await fetch('/api/hidden-channels')
        const data = await res.json()
        setHiddenChannels(data)
      } catch (error) {
        console.error('Failed to fetch hidden channels:', error)
      } finally {
        setLoading(false)
      }
    }
    fetchHiddenChannels()
  }, [])

  const handleUnhide = async (channelId: string) => {
    try {
      const response = await fetch(`/api/channels/${channelId}/show`, {
        method: 'POST'
      })

      if (!response.ok) {
        throw new Error('Failed to unhide channel')
      }

      // Update local state
      setHiddenChannels(hiddenChannels.filter(id => id !== channelId))
    } catch (error) {
      console.error('Error unhiding channel:', error)
    }
  }

  if (loading) return <div className="container mx-auto p-4">Loading...</div>

  return (
    <div className="container mx-auto p-4">
      <h1 className="text-2xl font-bold mb-6">Hidden Channels</h1>
      
      {hiddenChannels.length === 0 ? (
        <p>No channels are currently hidden</p>
      ) : (
        <div className="space-y-4">
          {hiddenChannels.map(channelId => (
            <div key={channelId} className="border p-4 rounded-lg flex justify-between items-center">
              <Link 
                href={`/channels/${channelId}`}
                className="text-blue-500 hover:underline"
              >
                {channelId}
              </Link>
              <button
                onClick={() => handleUnhide(channelId)}
                className="px-4 py-2 bg-green-500 text-white rounded hover:bg-green-600"
              >
                Unhide
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
