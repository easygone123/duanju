export const VIRAL_REPLICATION_STATUS = {
  UPLOADING: 'uploading',
  ANALYZING: 'analyzing',
  REVIEW_READY: 'review_ready',
  GENERATING: 'generating',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const

export const VIRAL_REPLICATION_STATUSES = Object.values(VIRAL_REPLICATION_STATUS)

export type ViralReplicationStatus =
  (typeof VIRAL_REPLICATION_STATUS)[keyof typeof VIRAL_REPLICATION_STATUS]

export const VIRAL_UPLOAD_MAX_BYTES = 500 * 1024 * 1024
export const VIRAL_VIDEO_MIN_DURATION_MS = 5_000
export const VIRAL_VIDEO_MAX_DURATION_MS = 180_000
export const VIRAL_MAX_ANALYSIS_FRAMES = 72
export const VIRAL_MAX_GENERATED_PANELS = 72
export const VIRAL_ANALYSIS_BATCH_SIZE = 10

export const VIRAL_STORYBOARD_GENERATION_FAILED = 'VIRAL_STORYBOARD_GENERATION_FAILED'
