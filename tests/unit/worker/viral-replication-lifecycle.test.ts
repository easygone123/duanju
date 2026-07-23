import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import { DelayedError, UnrecoverableError, type Job } from 'bullmq'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TaskJobData } from '@/lib/task/types'

const taskService = vi.hoisted(() => ({
  rollbackTaskBillingForTask: vi.fn(async () => ({ attempted: false, rolledBack: true, billingInfo: null })),
  touchTaskHeartbeat: vi.fn(async () => true),
  tryMarkTaskCompleted: vi.fn(async () => true),
  tryMarkTaskFailed: vi.fn(async () => true),
  tryMarkTaskProcessing: vi.fn(async () => true),
  tryResumeTaskFromComfyCapacityWait: vi.fn(async () => false),
  tryUpdateTaskProgress: vi.fn(async () => true),
  updateTaskBillingInfo: vi.fn(async () => undefined),
}))

vi.mock('@/lib/task/service', () => taskService)
vi.mock('@/lib/task/publisher', () => ({
  publishTaskEvent: vi.fn(async () => ({})),
  publishTaskStreamEvent: vi.fn(async () => ({})),
}))
vi.mock('@/lib/run-runtime/publisher', () => ({ publishRunEvent: vi.fn(async () => undefined) }))

import { withTaskLifecycle } from '@/lib/workers/shared'
import { createViralReplicationAnalysisHandler } from '@/lib/workers/handlers/viral-replication-analysis'

function completion(text: string) {
  return {
    id: 'completion', object: 'chat.completion', created: 0, model: 'model',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text, refusal: null } }],
  }
}

function analyzedShot() {
  return {
    shotIndex: 0, startMs: 0, endMs: 1_000, shotType: 'medium', cameraAngle: 'eye level',
    cameraMove: 'static', composition: 'centered', actionBeat: 'product reveal', transition: 'cut',
    subtitleSummary: null, narrativeFunction: 'hook',
    visibleCharacters: ['presenter'], speaker: 'presenter', location: 'studio', props: ['product'],
    dialogueIntent: null, plotBeat: 'the presenter reveals the product', causalLink: null,
    analysisConfidence: 0.95, needsVisualReview: false,
  }
}

function report() {
  return {
    schemaVersion: 1,
    overview: { hook: 'hook', coreAppeal: 'appeal', pacing: 'fast', emotionalArc: 'rise' },
    sourceStory: {
      summary: 'A presenter reveals a product.',
      premise: 'The audience waits for a product reveal.',
      characterRelations: ['The presenter addresses the audience.'],
      storyBeats: [{
        shotIndexes: [0],
        beat: 'The presenter reveals the product.',
        cause: null,
        effect: null,
      }],
    },
    styleFingerprint: { composition: ['centered'], lighting: ['soft'], color: ['warm'], editing: ['cut'] },
    shots: [analyzedShot()],
    originalAdaptationAdvice: ['Create original content.'],
  }
}

function whereMatches(record: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const key of [
    'id', 'userId', 'status', 'sourceVideoMediaId', 'analysisModelSnapshot',
    'analysisExecutionTaskId', 'analysisExecutionToken',
  ]) {
    if (key in where && record[key] !== where[key]) return false
  }
  if (Array.isArray(where.OR)) {
    return where.OR.some((candidate) => whereMatches(record, candidate as Record<string, unknown>))
  }
  const expires = where.analysisExecutionExpiresAt
  if (expires && typeof expires === 'object' && 'lte' in expires) {
    const current = record.analysisExecutionExpiresAt
    if (!(current instanceof Date) || current > (expires as { lte: Date }).lte) return false
  }
  return true
}

type HarnessOptions = {
  status?: string
  ownerTaskId?: string | null
  executionToken?: string | null
  executionExpiresAt?: Date | null
  sourceGate?: Promise<void>
  tokens?: string[]
}

async function createHarness(options: HarnessOptions = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'viral-lifecycle-'))
  const replication: Record<string, unknown> = {
    id: 'replication-1', userId: 'user-1', projectId: 'project-1', brief: 'original brief',
    status: options.status ?? 'analyzing', sourceVideoMediaId: 'source-media',
    analysisModelSnapshot: 'provider::model',
    analysisExecutionTaskId: options.ownerTaskId ?? null,
    analysisExecutionToken: options.executionToken ?? null,
    analysisExecutionExpiresAt: options.executionExpiresAt ?? null,
    sourceVideoMedia: { id: 'source-media', storageKey: 'source/video.mp4' },
  }
  const frames: Array<Record<string, unknown>> = []
  const media: Array<Record<string, unknown>> = []
  let tokenIndex = 0
  const prisma = {
    viralReplication: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => (
        whereMatches(replication, where) ? { ...replication } : null
      )),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (!whereMatches(replication, where)) return { count: 0 }
        Object.assign(replication, data)
        return { count: 1 }
      }),
    },
    viralReplicationFrame: {
      findUnique: vi.fn(async () => frames[0] || null),
      upsert: vi.fn(async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
        if (frames[0]) Object.assign(frames[0], update)
        else frames.push({ id: 'frame-1', ...create })
        return frames[0]
      }),
    },
    mediaObject: {
      findUnique: vi.fn(async () => media[0] || null),
      upsert: vi.fn(async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
        if (media[0]) Object.assign(media[0], update)
        else media.push({ id: 'media-1', ...create })
        return media[0]
      }),
    },
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => await callback(prisma)),
  }
  const handler = createViralReplicationAnalysisHandler({
    prisma,
    getObjectStream: vi.fn(async () => {
      await options.sourceGate
      return Readable.from(Buffer.from('video'))
    }),
    preprocess: vi.fn(async () => ({
      metadata: { durationMs: 1_000, width: 1080, height: 1920, videoStreamIndex: 0, formatName: 'mp4' },
      shots: [{ shotIndex: 0, startMs: 0, endMs: 1_000, representativeMs: 500, framePath: 'frame.jpg' }],
      transcriptText: null,
    })),
    readFrame: vi.fn(async () => Buffer.from('jpeg')),
    uploadObject: vi.fn(async (_body: Buffer, key: string) => key),
    deleteObject: vi.fn(async () => undefined),
    runVision: vi.fn(async () => completion(JSON.stringify({ shots: [analyzedShot()] }))),
    runText: vi.fn(async () => completion(JSON.stringify(report()))),
    reportProgress: vi.fn(async () => undefined),
    touchTaskHeartbeat: taskService.touchTaskHeartbeat,
    makeTempDirectory: vi.fn(async () => await fs.mkdtemp(path.join(root, 'run-'))),
    removeTempDirectory: vi.fn(async (directory: string) => await fs.rm(directory, { recursive: true, force: true })),
    now: () => new Date('2026-07-15T03:00:00.000Z'),
    createExecutionToken: () => options.tokens?.[tokenIndex++] ?? `execution-${tokenIndex++}`,
    warn: vi.fn(),
  } as never)

  function job(taskId: string) {
    const job = {
      data: {
        taskId,
        type: 'viral_video_analysis', locale: 'en', projectId: 'project-1',
        targetType: 'ViralReplication', targetId: 'replication-1', userId: 'user-1',
        payload: { sourceVideoMediaId: 'source-media', analysisModelSnapshot: 'provider::model' },
      },
      queueName: 'viral', token: `bull-token-${taskId}`, opts: { attempts: 1 }, attemptsMade: 0,
      updateData: vi.fn(async (nextData: TaskJobData) => { job.data = nextData as typeof job.data }),
      moveToDelayed: vi.fn(async () => undefined),
    }
    return job as unknown as Job<TaskJobData> & {
      updateData: ReturnType<typeof vi.fn>
      moveToDelayed: ReturnType<typeof vi.fn>
    }
  }

  return { root, replication, handler, job, prisma }
}

const roots: string[] = []

beforeEach(() => {
  vi.clearAllMocks()
  taskService.rollbackTaskBillingForTask.mockResolvedValue({ attempted: false, rolledBack: true, billingInfo: null })
  taskService.touchTaskHeartbeat.mockResolvedValue(true)
  taskService.tryMarkTaskCompleted.mockResolvedValue(true)
  taskService.tryMarkTaskFailed.mockResolvedValue(true)
  taskService.tryMarkTaskProcessing.mockResolvedValue(true)
  taskService.tryResumeTaskFromComfyCapacityWait.mockResolvedValue(false)
  taskService.tryUpdateTaskProgress.mockResolvedValue(true)
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await fs.rm(root, { recursive: true, force: true })))
})

describe('viral analysis through the real Task lifecycle', () => {
  it('delays an active same-Task duplicate without completing or failing its Task', async () => {
    const harness = await createHarness({
      ownerTaskId: 'task-1', executionToken: 'owner-token',
      executionExpiresAt: new Date('2026-07-15T03:10:00.000Z'),
    })
    roots.push(harness.root)
    const job = harness.job('task-1')

    await expect(withTaskLifecycle(job, harness.handler)).rejects.toBeInstanceOf(DelayedError)

    expect(job.updateData).toHaveBeenCalledWith(expect.objectContaining({
      viralAnalysisResume: expect.objectContaining({
        taskId: 'task-1', replicationId: 'replication-1',
        retryAt: Date.parse('2026-07-15T03:00:05.000Z'),
      }),
    }))
    expect(job.moveToDelayed).toHaveBeenCalledWith(
      Date.parse('2026-07-15T03:00:05.000Z'),
      'bull-token-task-1',
    )
    expect(taskService.touchTaskHeartbeat).toHaveBeenCalledWith('task-1')
    expect(taskService.tryMarkTaskCompleted).not.toHaveBeenCalled()
    expect(taskService.tryMarkTaskFailed).not.toHaveBeenCalled()
    expect(harness.prisma.viralReplication.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }),
    )
  })

  it.each(['review_ready', 'generating', 'completed']) (
    'reconciles same-Task domain status %s to Task completion on resumed delivery',
    async (status) => {
      const harness = await createHarness({ status, ownerTaskId: 'task-1' })
      roots.push(harness.root)

      await expect(withTaskLifecycle(harness.job('task-1'), harness.handler)).resolves.toBeUndefined()

      expect(taskService.tryMarkTaskCompleted).toHaveBeenCalledOnce()
      expect(taskService.tryMarkTaskFailed).not.toHaveBeenCalled()
    },
  )

  it('fails the resumed Task when its owned domain status is failed', async () => {
    const harness = await createHarness({ status: 'failed', ownerTaskId: 'task-1' })
    roots.push(harness.root)

    await expect(withTaskLifecycle(harness.job('task-1'), harness.handler)).rejects.toBeInstanceOf(UnrecoverableError)

    expect(taskService.tryMarkTaskFailed).toHaveBeenCalledOnce()
    expect(taskService.tryMarkTaskCompleted).not.toHaveBeenCalled()
  })

  it('takes over an expired same-Task lease and completes under a new token', async () => {
    const harness = await createHarness({
      ownerTaskId: 'task-1', executionToken: 'expired-token',
      executionExpiresAt: new Date('2026-07-15T02:00:00.000Z'), tokens: ['takeover-token'],
    })
    roots.push(harness.root)

    await withTaskLifecycle(harness.job('task-1'), harness.handler)

    expect(harness.replication).toMatchObject({
      status: 'review_ready', analysisExecutionTaskId: 'task-1', analysisExecutionToken: null,
    })
    expect(taskService.tryMarkTaskCompleted).toHaveBeenCalledOnce()
  })

  it('fails a different losing Task without mutating the active domain owner', async () => {
    const harness = await createHarness({
      ownerTaskId: 'task-owner', executionToken: 'owner-token',
      executionExpiresAt: new Date('2026-07-15T03:10:00.000Z'),
    })
    roots.push(harness.root)

    await expect(withTaskLifecycle(harness.job('task-loser'), harness.handler)).rejects.toBeInstanceOf(UnrecoverableError)

    expect(taskService.tryMarkTaskFailed).toHaveBeenCalledWith('task-loser', expect.any(String), expect.any(String))
    expect(harness.replication).toMatchObject({
      status: 'analyzing', analysisExecutionTaskId: 'task-owner', analysisExecutionToken: 'owner-token',
    })
  })

  it('fails a Task whose immutable media snapshot mismatches without mutating the domain', async () => {
    const harness = await createHarness({})
    roots.push(harness.root)
    const job = harness.job('task-mismatch')
    job.data.payload = {
      sourceVideoMediaId: 'different-source-media',
      analysisModelSnapshot: 'provider::model',
    }

    await expect(withTaskLifecycle(job, harness.handler)).rejects.toBeInstanceOf(UnrecoverableError)

    expect(taskService.tryMarkTaskFailed).toHaveBeenCalledWith(
      'task-mismatch', expect.any(String), expect.stringMatching(/immutable|superseded/i),
    )
    expect(harness.replication).toMatchObject({
      status: 'analyzing', sourceVideoMediaId: 'source-media', analysisExecutionTaskId: null,
    })
  })

  it('lets the owner succeed while an interleaved same-Task delivery yields without FAILED', async () => {
    let releaseSource!: () => void
    const sourceGate = new Promise<void>((resolve) => { releaseSource = resolve })
    const harness = await createHarness({ sourceGate, tokens: ['owner-token', 'duplicate-token'] })
    roots.push(harness.root)
    const ownerJob = harness.job('task-1')
    const duplicateJob = harness.job('task-1')

    const owner = withTaskLifecycle(ownerJob, harness.handler)
    await vi.waitFor(() => expect(harness.replication.analysisExecutionToken).toBe('owner-token'))
    const duplicate = withTaskLifecycle(duplicateJob, harness.handler)
    await expect(duplicate).rejects.toBeInstanceOf(DelayedError)
    releaseSource()
    await owner

    expect(harness.replication.status).toBe('review_ready')
    expect(taskService.tryMarkTaskFailed).not.toHaveBeenCalled()
    expect(taskService.tryMarkTaskCompleted).toHaveBeenCalledOnce()
  })
})
