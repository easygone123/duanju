export const VIRAL_REPLICATION_STATUSES = [
  'uploading',
  'analyzing',
  'review_ready',
  'generating',
  'completed',
  'failed',
] as const

export type ViralReplicationStatus = (typeof VIRAL_REPLICATION_STATUSES)[number]

export const VIRAL_UPLOAD_MAX_BYTES = 500 * 1024 * 1024
export const VIRAL_VIDEO_MIN_DURATION_MS = 15_000
export const VIRAL_VIDEO_MAX_DURATION_MS = 180_000
export const VIRAL_MAX_ANALYSIS_FRAMES = 72
export const VIRAL_ANALYSIS_BATCH_SIZE = 10
