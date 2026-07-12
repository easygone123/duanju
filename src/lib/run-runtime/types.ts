export const RUN_STATUS = {
  QUEUED: 'queued',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELING: 'canceling',
  CANCELED: 'canceled',
} as const

export type RunStatus = (typeof RUN_STATUS)[keyof typeof RUN_STATUS]

export const RUN_STEP_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELED: 'canceled',
} as const

export type RunStepStatus = (typeof RUN_STEP_STATUS)[keyof typeof RUN_STEP_STATUS]

export const RUN_EVENT_TYPE = {
  RUN_START: 'run.start',
  STEP_START: 'step.start',
  STEP_CHUNK: 'step.chunk',
  STEP_COMPLETE: 'step.complete',
  STEP_ERROR: 'step.error',
  RUN_COMPLETE: 'run.complete',
  RUN_ERROR: 'run.error',
  RUN_CANCELED: 'run.canceled',
} as const

export type RunEventType = (typeof RUN_EVENT_TYPE)[keyof typeof RUN_EVENT_TYPE]

export const GRAPH_ARTIFACT_MAX_BYTES = 256 * 1024
export const GRAPH_ARTIFACT_PAYLOAD_TOO_LARGE = 'GRAPH_ARTIFACT_PAYLOAD_TOO_LARGE'
export const GRAPH_ARTIFACT_PAYLOAD_INVALID = 'GRAPH_ARTIFACT_PAYLOAD_INVALID'

export const RUN_ARTIFACT_TYPE = {
  SIX_GRID_STORYBOARD_GROUP: 'storyboard.six_grid.group',
  SIX_GRID_STORYBOARD_PLAN: 'storyboard.six_grid.plan',
  SIX_GRID_STORYBOARD_PHASE1: 'storyboard.six_grid.phase1',
  SIX_GRID_STORYBOARD_PHASE2_CINE: 'storyboard.six_grid.phase2.cine',
  SIX_GRID_STORYBOARD_PHASE2_ACTING: 'storyboard.six_grid.phase2.acting',
  SIX_GRID_STORYBOARD_PHASE3: 'storyboard.six_grid.phase3',
} as const

export const RUN_ARTIFACT_STEP_KEY = {
  SIX_GRID_PERSIST: 'six_grid_persist',
  SIX_GRID_EPISODE_PLAN: 'six_grid_episode_plan',
} as const

export type RunEventInput = {
  runId: string
  projectId: string
  userId: string
  eventType: RunEventType
  stepKey?: string | null
  attempt?: number | null
  lane?: 'text' | 'reasoning' | null
  payload?: Record<string, unknown> | null
}

export type RunEvent = {
  id: string
  runId: string
  projectId: string
  userId: string
  seq: number
  eventType: RunEventType
  stepKey?: string | null
  attempt?: number | null
  lane?: 'text' | 'reasoning' | null
  payload?: Record<string, unknown> | null
  createdAt: string
}

export type CreateRunInput = {
  userId: string
  projectId: string
  episodeId?: string | null
  workflowType: string
  taskType?: string | null
  taskId?: string | null
  targetType: string
  targetId: string
  input?: Record<string, unknown> | null
}

export type RunLeaseState = {
  leaseOwner?: string | null
  leaseExpiresAt?: string | null
  heartbeatAt?: string | null
  workflowVersion?: number
}

export type ListRunsInput = {
  userId: string
  projectId?: string
  workflowType?: string
  targetType?: string
  targetId?: string
  episodeId?: string
  statuses?: RunStatus[]
  limit?: number
  recoverableOnly?: boolean
  latestOnly?: boolean
}

export type StateRef = {
  scriptId?: string
  storyboardId?: string
  voiceLineBatchId?: string
  versionHash?: string
  cursor?: string
}

export const RUN_STATE_MAX_BYTES = 64 * 1024
