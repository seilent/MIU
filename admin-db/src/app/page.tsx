import Link from 'next/link'

export default function AdminDashboard() {
  return (
    <div className="container mx-auto p-4">
      <h1 className="text-2xl font-bold mb-6">Database Admin Panel</h1>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Link href="/channels" className="p-6 border rounded-lg hover:bg-gray-50">
          <h2 className="text-xl font-semibold">Channels</h2>
          <p className="text-gray-600">Manage YouTube channels</p>
        </Link>
        <Link href="/tracks" className="p-6 border rounded-lg hover:bg-gray-50">
          <h2 className="text-xl font-semibold">Tracks</h2>
          <p className="text-gray-600">Manage music tracks</p>
        </Link>
        <Link href="/bans" className="p-6 border rounded-lg hover:bg-gray-50">
          <h2 className="text-xl font-semibold">Bans</h2>
          <p className="text-gray-600">View and manage bans</p>
        </Link>
      </div>
    </div>
  )
}
