import { beforeEach, describe, expect, it, vi } from 'vitest'
import { submitTask } from '@/lib/task/submitter'
import { QUEUE_NAME } from '@/lib/task/queue-names'
import { TASK_TYPE, type TaskJobData, type TaskType } from '@/lib/task/types'

type StoredTask = Record<string, unknown> & {
  id: string
  maxAttempts: number
}

type QueueAddCall = {
  queueName: string
  jobName: string
  data: TaskJobData
  options: Record<string, unknown>
}

const queueState = vi.hoisted(() => ({
  addCalls: [] as QueueAddCall[],
}))
const dbState = vi.hoisted(() => ({
  nextTaskId: 1,
  nextRunId: 1,
  tasks: new Map<string, StoredTask>(),
  runs: new Map<string, Record<string, unknown>>(),
}))
const publishTaskEventMock = vi.hoisted(() => vi.fn(async () => ({})))

const prismaMock = vi.hoisted(() => ({
  task: {
    findFirst: vi.fn(async () => null),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => dbState.tasks.get(where.id) || null),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const id = `task-${dbState.nextTaskId++}`
      const task = { id, ...data } as StoredTask
      dbState.tasks.set(id, task)
      return task
    }),
    update: vi.fn(async ({
      where,
      data,
    }: {
      where: { id: string }
      data: Record<string, unknown>
    }) => {
      const current = dbState.tasks.get(where.id)
      if (!current) throw new Error(`Task not found: ${where.id}`)
      const task = { ...current, ...data } as StoredTask
      dbState.tasks.set(where.id, task)
      return task
    }),
  },
  graphRun: {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const now = new Date()
      const id = `run-${dbState.nextRunId++}`
      const run = {
        id,
        ...data,
        output: null,
        errorCode: null,
        errorMessage: null,
        cancelRequestedAt: null,
        startedAt: null,
        finishedAt: null,
        createdAt: now,
        updatedAt: now,
      }
      dbState.runs.set(id, run)
      return run
    }),
    update: vi.fn(async ({
      where,
      data,
    }: {
      where: { id: string }
      data: Record<string, unknown>
    }) => {
      const current = dbState.runs.get(where.id)
      if (!current) throw new Error(`Run not found: ${where.id}`)
      const run = { ...current, ...data, updatedAt: new Date() }
      dbState.runs.set(where.id, run)
      return run
    }),
  },
}))

vi.mock('bullmq', () => ({
  Queue: class {
    constructor(private readonly queueName: string) {}

    async add(jobName: string, data: TaskJobData, options: Record<string, unknown>) {
      queueState.addCalls.push({ queueName: this.queueName, jobName, data, options })
      return { id: data.taskId }
    }

    async getJob() {
      return null
    }
  },
}))

vi.mock('@/lib/redis', () => ({ queueRedis: {} }))
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('@/lib/task/publisher', () => ({ publishTaskEvent: publishTaskEventMock }))

async function submit(params: { type: TaskType; maxAttempts?: number; suffix: string }) {
  const result = await submitTask({
    userId: `user-${params.suffix}`,
    locale: 'en',
    projectId: `viral-project-${params.suffix}`,
    type: params.type,
    targetType: 'ViralVideoReplication',
    targetId: `viral-replication-${params.suffix}`,
    payload: { analysisModelSnapshot: 'test::analysis-model' },
    ...(params.maxAttempts === undefined ? {} : { maxAttempts: params.maxAttempts }),
  })
  const task = dbState.tasks.get(result.taskId)
  if (!task) throw new Error(`Persisted task not found: ${result.taskId}`)
  const queueCall = queueState.addCalls.find((call) => call.data.taskId === result.taskId)
  return { task, queueCall }
}

describe('chain contract - viral replication submission', () => {
  beforeEach(() => {
    process.env.BILLING_MODE = 'OFF'
    dbState.nextTaskId = 1
    dbState.nextRunId = 1
    dbState.tasks.clear()
    dbState.runs.clear()
    queueState.addCalls.length = 0
    vi.clearAllMocks()
  })

  it.each([
    [TASK_TYPE.VIRAL_VIDEO_ANALYSIS, undefined, 'omitted'],
    [TASK_TYPE.VIRAL_STORYBOARD_GENERATION, 9, 'requested-nine'],
  ] as const)('persists and enqueues one attempt for %s', async (type, maxAttempts, suffix) => {
    const { task, queueCall } = await submit({ type, maxAttempts, suffix })

    expect(task.maxAttempts).toBe(1)
    expect(queueCall).toMatchObject({
      queueName: QUEUE_NAME.VIRAL_REPLICATION,
      jobName: type,
      options: { attempts: 1 },
    })
  })

  it.each([
    [undefined, 5, 'nonviral-default'],
    [9, 9, 'nonviral-nine'],
  ] as const)('preserves non-viral maxAttempts=%s as %s', async (requested, expected, suffix) => {
    const { task, queueCall } = await submit({
      type: TASK_TYPE.ANALYZE_NOVEL,
      maxAttempts: requested,
      suffix,
    })

    expect(task.maxAttempts).toBe(expected)
    expect(queueCall).toMatchObject({
      queueName: QUEUE_NAME.TEXT,
      jobName: TASK_TYPE.ANALYZE_NOVEL,
      options: { attempts: expected },
    })
  })
})
