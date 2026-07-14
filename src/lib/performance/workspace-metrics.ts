export type WorkspaceRequestKind = 'data' | 'script' | 'media'

export interface WorkspaceRequestMetric {
  name: string
  bytes: number
  kind: WorkspaceRequestKind
}

export interface WorkspaceStageMetric {
  visibleMs?: number
  mountedCards?: number
}

export interface WorkspaceMetricsSnapshot {
  stages: Record<string, WorkspaceStageMetric>
  requests: WorkspaceRequestMetric[]
  requestCount: number
  requestBytes: number
  refetchCount: number
}

export interface WorkspaceMetrics {
  stageStart(stage: string, timestamp?: number): void
  stageVisible(stage: string, timestamp?: number): void
  recordRequest(name: string, bytes: number, kind?: WorkspaceRequestKind): void
  /** Task 1 tracks only the aggregate; Tasks 4 and 6 can segment by query key. */
  recordRefetch(queryKey: readonly unknown[]): void
  setMountedCards(stage: string, count: number): void
  snapshot(): WorkspaceMetricsSnapshot
}

export interface CreateWorkspaceMetricsOptions {
  /**
   * Callers decide how metrics are enabled. Server tooling can inject
   * `process.env.WORKSPACE_PERF_METRICS === '1'` without exposing that variable
   * to client bundles.
   */
  enabled?: boolean
  now?: () => number
}

interface MutableStageMetric extends WorkspaceStageMetric {
  startedAt?: number
}

const emptySnapshot = (): WorkspaceMetricsSnapshot => ({
  stages: {},
  requests: [],
  requestCount: 0,
  requestBytes: 0,
  refetchCount: 0,
})

export function createWorkspaceMetrics(
  options: CreateWorkspaceMetricsOptions = {},
): WorkspaceMetrics {
  const collecting = options.enabled === true && process.env.NODE_ENV !== 'production'
  const now = options.now ?? (() => performance.now())
  const stages: Record<string, MutableStageMetric> = {}
  const requests: WorkspaceRequestMetric[] = []
  let refetchCount = 0

  const stageMetric = (stage: string): MutableStageMetric => {
    stages[stage] ??= {}
    return stages[stage]
  }

  return {
    stageStart(stage, timestamp) {
      if (!collecting) return
      stageMetric(stage).startedAt = timestamp ?? now()
    },

    stageVisible(stage, timestamp) {
      if (!collecting) return
      const metric = stageMetric(stage)
      if (metric.startedAt !== undefined) {
        metric.visibleMs = (timestamp ?? now()) - metric.startedAt
      }
    },

    recordRequest(name, bytes, kind = 'data') {
      if (!collecting) return
      requests.push({ name, bytes, kind })
    },

    recordRefetch() {
      if (!collecting) return
      refetchCount += 1
    },

    setMountedCards(stage, count) {
      if (!collecting) return
      stageMetric(stage).mountedCards = count
    },

    snapshot() {
      if (!collecting) return emptySnapshot()

      const stageSnapshot = Object.fromEntries(
        Object.entries(stages).map(([stage, { visibleMs, mountedCards }]) => [
          stage,
          {
            ...(visibleMs === undefined ? {} : { visibleMs }),
            ...(mountedCards === undefined ? {} : { mountedCards }),
          },
        ]),
      )
      const requestSnapshot = requests.map((request) => ({ ...request }))

      return {
        stages: stageSnapshot,
        requests: requestSnapshot,
        requestCount: requestSnapshot.length,
        requestBytes: requestSnapshot.reduce((total, request) => total + request.bytes, 0),
        refetchCount,
      }
    },
  }
}
