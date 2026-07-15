import type { Job } from 'bullmq'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TASK_TYPE, type TaskJobData } from '@/lib/task/types'

type WorkerProcessor = (job: Job<TaskJobData>) => Promise<unknown>

const workerState = vi.hoisted(() => ({
  queueName: null as string | null,
  processor: null as WorkerProcessor | null,
  options: null as Record<string, unknown> | null,
}))

const withTaskLifecycleMock = vi.hoisted(() =>
  vi.fn(async (job: Job<TaskJobData>, handler: WorkerProcessor) => await handler(job)),
)
const handleViralReplicationAnalysisTaskMock = vi.hoisted(() =>
  vi.fn(async () => ({ kind: 'analysis' })),
)
const handleViralReplicationGenerationTaskMock = vi.hoisted(() =>
  vi.fn(async () => ({ kind: 'generation' })),
)

vi.mock('bullmq', () => ({
  Queue: class {
    constructor(queueName: string) {
      void queueName
    }
  },
  Worker: class {
    constructor(
      queueName: string,
      processor: WorkerProcessor,
      options: Record<string, unknown>,
    ) {
      workerState.queueName = queueName
      workerState.processor = processor
      workerState.options = options
    }
  },
}))

vi.mock('@/lib/redis', () => ({ queueRedis: {} }))
vi.mock('@/lib/workers/shared', () => ({ withTaskLifecycle: withTaskLifecycleMock }))
vi.mock('@/lib/workers/handlers/viral-replication-analysis', () => ({
  handleViralReplicationAnalysisTask: handleViralReplicationAnalysisTaskMock,
}))
vi.mock('@/lib/workers/handlers/viral-replication-generation', () => ({
  handleViralReplicationGenerationTask: handleViralReplicationGenerationTaskMock,
}))

function buildJob(type: TaskJobData['type']): Job<TaskJobData> {
  return {
    data: {
      taskId: `task-${type}`,
      type,
      locale: 'zh',
      projectId: 'project-1',
      targetType: 'ViralVideoReplication',
      targetId: 'replication-1',
      userId: 'user-1',
      payload: {},
    },
  } as Job<TaskJobData>
}

describe('viral replication worker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    workerState.queueName = null
    workerState.processor = null
    workerState.options = null
    delete process.env.QUEUE_CONCURRENCY_VIRAL_REPLICATION
  })

  it.each([
    [TASK_TYPE.VIRAL_VIDEO_ANALYSIS, handleViralReplicationAnalysisTaskMock, { kind: 'analysis' }],
    [TASK_TYPE.VIRAL_STORYBOARD_GENERATION, handleViralReplicationGenerationTaskMock, { kind: 'generation' }],
  ] as const)('dispatches %s through task lifecycle to its dedicated handler', async (taskType, handler, result) => {
    const { createViralReplicationWorker } = await import('@/lib/workers/viral-replication.worker')
    createViralReplicationWorker()
    const job = buildJob(taskType)

    await expect(workerState.processor!(job)).resolves.toEqual(result)
    expect(withTaskLifecycleMock).toHaveBeenCalledWith(job, expect.any(Function))
    expect(handler).toHaveBeenCalledWith(job)
  })

  it('throws for unsupported task types', async () => {
    const { createViralReplicationWorker } = await import('@/lib/workers/viral-replication.worker')
    createViralReplicationWorker()
    const job = buildJob(TASK_TYPE.IMAGE_PANEL)

    await expect(workerState.processor!(job)).rejects.toThrow(
      'Unsupported viral replication task type: image_panel',
    )
  })

  it('uses the dedicated queue and defaults concurrency to two', async () => {
    const { createViralReplicationWorker } = await import('@/lib/workers/viral-replication.worker')
    createViralReplicationWorker()

    expect(workerState.queueName).toBe('waoowaoo-viral-replication')
    expect(workerState.options).toMatchObject({ concurrency: 2 })
  })

})
