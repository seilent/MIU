// Define enums to match Prisma schema
export enum RequestStatus {
  PENDING = 'PENDING',
  PLAYING = 'PLAYING',
  QUEUED = 'QUEUED',
  COMPLETED = 'COMPLETED',
  DOWNLOADING = 'DOWNLOADING',
  SKIPPED = 'SKIPPED',
  EXPIRED = 'EXPIRED',
  READY = 'READY'
}

export enum PlaylistMode {
  LINEAR = 'LINEAR',
  POOL = 'POOL'
}

// Track status enum for better track state management
export enum TrackStatus {
  PLAYING = 'PLAYING',    // Currently playing
  STANDBY = 'STANDBY',    // Finished playing / not in queue or just added to queue but no metadata processed yet
  QUEUED = 'QUEUED',      // In queue, fetched metadata
  DOWNLOADING = 'DOWNLOADING', // In queue, but currently downloading
  READY = 'READY',        // QUEUED and DOWNLOADED
  BLOCKED = 'BLOCKED'     // Banned song by admin
} 