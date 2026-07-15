import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { submitTask } from '@/lib/task/submitter'
import { QUEUE_NAME } from '@/lib/task/queue-names'
import { TASK_TYPE, type TaskJobData, type TaskType } from '@/lib/task/types'
import { createViralReplicationAnalysisHandler } from '@/lib/workers/handlers/viral-replication-analysis'

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
    targetType: 'ViralReplication',
    targetId: `viral-replication-${params.suffix}`,
    payload: {
      sourceVideoMediaId: `media-${params.suffix}`,
      analysisModelSnapshot: 'test::analysis-model',
    },
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
      data: {
        targetType: 'ViralReplication',
        targetId: `viral-replication-${suffix}`,
        payload: {
          sourceVideoMediaId: `media-${suffix}`,
          analysisModelSnapshot: 'test::analysis-model',
          meta: { locale: 'en' },
        },
      },
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

  it('runs a submitted analysis task through the real handler into a review-ready report', async () => {
    const { task, queueCall } = await submit({
      type: TASK_TYPE.VIRAL_VIDEO_ANALYSIS,
      suffix: 'analysis-chain',
    })
    if (!queueCall) throw new Error('Analysis task was not enqueued')

    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'viral-chain-'))
    const replication: Record<string, unknown> & {
      id: string
      userId: string
      projectId: string
      brief: string
      status: string
      analysisModelSnapshot: string
      sourceVideoMediaId: string
      sourceVideoMedia: { id: string; storageKey: string }
      reportJson?: Record<string, unknown>
    } = {
      id: 'viral-replication-analysis-chain',
      userId: 'user-analysis-chain',
      projectId: 'viral-project-analysis-chain',
      brief: 'Create an original product reveal',
      status: 'analyzing',
      analysisExecutionTaskId: null,
      analysisExecutionToken: null,
      analysisExecutionExpiresAt: null,
      analysisModelSnapshot: 'test::analysis-model',
      sourceVideoMediaId: 'media-analysis-chain',
      sourceVideoMedia: {
        id: 'media-analysis-chain',
        storageKey: 'viral/source.mp4',
      },
    }
    const frames: Array<Record<string, unknown>> = []
    let mediaNumber = 0
    const modelCalls: Array<{ kind: 'vision' | 'text'; model: string }> = []
    const shots = Array.from({ length: 3 }, (_, shotIndex) => ({
      shotIndex,
      startMs: shotIndex * 1_000,
      endMs: (shotIndex + 1) * 1_000,
      representativeMs: shotIndex * 1_000 + 500,
    }))
    const analyzedShots = shots.map((shot) => ({
      shotIndex: shot.shotIndex,
      startMs: shot.startMs,
      endMs: shot.endMs,
      shotType: 'close-up',
      cameraAngle: 'eye-level',
      cameraMove: 'static',
      composition: 'centered subject',
      actionBeat: `beat ${shot.shotIndex}`,
      transition: 'cut',
      subtitleSummary: null,
      narrativeFunction: `function ${shot.shotIndex}`,
    }))
    const completion = (text: string) => ({
      id: 'deterministic',
      object: 'chat.completion',
      created: 0,
      model: 'test::analysis-model',
      choices: [{
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: text, refusal: null },
      }],
    })
    const analysisPrisma = {
      viralReplication: {
        findFirst: vi.fn(async () => replication),
        updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(replication, data)
          return { count: 1 }
        }),
      },
      mediaObject: {
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async () => ({ id: `frame-media-${++mediaNumber}` })),
      },
      viralReplicationFrame: {
        findUnique: vi.fn(async ({ where }: {
          where: { replicationId_shotIndex: { shotIndex: number } }
        }) => frames.find((frame) => frame.shotIndex === where.replicationId_shotIndex.shotIndex) || null),
        upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => {
          frames.push(create)
          return create
        }),
      },
      $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => await callback(analysisPrisma)),
    }

    try {
      const handler = createViralReplicationAnalysisHandler({
        prisma: analysisPrisma as never,
        getObjectStream: vi.fn(async () => Readable.from(Buffer.from('deterministic-video'))),
        preprocess: vi.fn(async ({ outputDirectory }: { outputDirectory: string }) => {
          await fs.mkdir(outputDirectory, { recursive: true })
          const persistedShots = []
          for (const shot of shots) {
            const framePath = path.join(outputDirectory, `${shot.shotIndex}.jpg`)
            await fs.writeFile(framePath, Buffer.from(`jpeg-${shot.shotIndex}`))
            persistedShots.push({ ...shot, framePath })
          }
          return {
            metadata: {
              formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
              majorBrand: 'isom',
              videoStreamIndex: 0,
              durationMs: 3_000,
              width: 1080,
              height: 1920,
              hasVideo: true,
              hasAudio: true,
              hasSubtitles: true,
              videoStreams: [],
              audioStreams: [],
              subtitleStreams: [],
            },
            shots: persistedShots,
            transcriptText: 'A deterministic embedded subtitle',
          }
        }) as never,
        readFrame: fs.readFile,
        uploadObject: vi.fn(async (_bytes, key) => key),
        deleteObject: vi.fn(async () => undefined),
        runVision: vi.fn(async (input) => {
          modelCalls.push({ kind: 'vision', model: input.model })
          return completion(JSON.stringify({ shots: analyzedShots })) as never
        }),
        runText: vi.fn(async (input) => {
          modelCalls.push({ kind: 'text', model: input.model })
          return completion(JSON.stringify({
            schemaVersion: 1,
            overview: {
              hook: 'Immediate reveal',
              coreAppeal: 'Visual transformation',
              pacing: 'Three even beats',
              emotionalArc: 'Curiosity to payoff',
            },
            styleFingerprint: {
              composition: ['centered'],
              lighting: ['soft'],
              color: ['warm'],
              editing: ['hard cuts'],
            },
            shots: analyzedShots,
            originalAdaptationAdvice: ['Invent a new subject while retaining the pacing.'],
          })) as never
        }),
        reportProgress: vi.fn(async () => undefined),
        touchTaskHeartbeat: vi.fn(async () => true),
        makeTempDirectory: vi.fn(async () => await fs.mkdtemp(path.join(root, 'worker-'))),
        removeTempDirectory: vi.fn(async (directory) => await fs.rm(directory, { recursive: true, force: true })),
        now: () => new Date('2026-07-15T01:00:00.000Z'),
        createExecutionToken: () => 'chain-execution-token',
        warn: vi.fn(),
      } as never)

      await handler({ data: queueCall.data } as never)

      expect(replication.status).toBe('review_ready')
      expect(replication.reportJson).toMatchObject({ schemaVersion: 1 })
      expect(frames.length).toBeGreaterThanOrEqual(3)
      expect(task.maxAttempts).toBe(1)
      expect(modelCalls).toEqual([
        { kind: 'vision', model: 'test::analysis-model' },
        { kind: 'text', model: 'test::analysis-model' },
      ])
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
