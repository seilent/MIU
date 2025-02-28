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