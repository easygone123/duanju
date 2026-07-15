import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TASK_STATUS, TASK_TYPE } from '@/lib/task/types'
import { createViralReplicationAnalysisHandler } from '@/lib/workers/handlers/viral-replication-analysis'
import { prisma } from '../../helpers/prisma'
import { createTestProject, createTestUser } from '../../helpers/billing-fixtures'

type WatchdogModule = typeof import('@/lib/task/reconcile') & {
  sweepStaleTasksAndViralAnalysis(input: { processingThresholdMs: number }): Promise<unknown>
}

async function loadWatchdogSweep() {
  const reconcileModule = await import('@/lib/task/reconcile') as WatchdogModule
  expect(reconcileModule.sweepStaleTasksAndViralAnalysis).toBeTypeOf('function')
  return reconcileModule.sweepStaleTasksAndViralAnalysis
}

async function createFixture(input: {
  ownerTaskId?: string
  executionToken?: string
}) {
  const user = await createTestUser()
  const project = await createTestProject(user.id)
  const taskId = randomUUID()
  const sourceMedia = await prisma.mediaObject.create({
    data: {
      publicId: `watchdog-source-${randomUUID()}`,
      storageKey: `watchdog/source-${randomUUID()}.mp4`,
      mimeType: 'video/mp4',
    },
  })
  await prisma.task.create({
    data: {
      id: taskId,
      userId: user.id,
      projectId: project.id,
      type: TASK_TYPE.VIRAL_VIDEO_ANALYSIS,
      targetType: 'ViralReplication',
      targetId: 'pending-replication-id',
      status: TASK_STATUS.PROCESSING,
      startedAt: new Date(),
      heartbeatAt: new Date(),
    },
  })
  const replication = await prisma.viralReplication.create({
    data: {
      userId: user.id,
      projectId: project.id,
      brief: 'watchdog fixture',
      videoRatio: '9:16',
      artStyle: 'cinematic',
      status: 'analyzing',
      sourceVideoMediaId: sourceMedia.id,
      analysisModelSnapshot: 'provider::model',
      analysisExecutionTaskId: input.ownerTaskId ?? taskId,
      analysisExecutionToken: input.executionToken ?? 'execution-token-old',
      analysisExecutionExpiresAt: new Date(Date.now() + 15 * 60_000),
    },
  })
  await prisma.task.update({
    where: { id: taskId },
    data: { targetId: replication.id },
  })
  return { taskId, replicationId: replication.id, sourceMediaId: sourceMedia.id }
}

describe('viral analysis watchdog reconciliation', () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-07-15T02:00:00.000Z'))
    await prisma.viralReplication.deleteMany()
    await prisma.mediaObject.deleteMany()
    await prisma.taskEvent.deleteMany()
    await prisma.task.deleteMany()
    await prisma.project.deleteMany()
    await prisma.user.deleteMany()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fails and releases the matching viral execution after its Task heartbeat times out', async () => {
    const fixture = await createFixture({})
    vi.advanceTimersByTime(6 * 60_000)

    const sweep = await loadWatchdogSweep()
    await sweep({ processingThresholdMs: 5 * 60_000 })

    await expect(prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } }))
      .resolves.toMatchObject({ status: TASK_STATUS.FAILED })
    await expect(prisma.viralReplication.findUniqueOrThrow({ where: { id: fixture.replicationId } }))
      .resolves.toMatchObject({
        status: 'failed',
        analysisExecutionTaskId: null,
        analysisExecutionToken: null,
        analysisExecutionExpiresAt: null,
      })
  })

  it('does not clear a viral execution already taken over by a newer Task', async () => {
    const fixture = await createFixture({
      ownerTaskId: 'task-new-owner',
      executionToken: 'execution-token-new',
    })
    vi.advanceTimersByTime(6 * 60_000)

    const sweep = await loadWatchdogSweep()
    await sweep({ processingThresholdMs: 5 * 60_000 })

    await expect(prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } }))
      .resolves.toMatchObject({ status: TASK_STATUS.FAILED })
    await expect(prisma.viralReplication.findUniqueOrThrow({ where: { id: fixture.replicationId } }))
      .resolves.toMatchObject({
        status: 'analyzing',
        analysisExecutionTaskId: 'task-new-owner',
        analysisExecutionToken: 'execution-token-new',
      })
  })

  it('allows a new Task to claim and complete after watchdog recovery releases the old owner', async () => {
    const fixture = await createFixture({})
    vi.advanceTimersByTime(6 * 60_000)
    const sweep = await loadWatchdogSweep()
    await sweep({ processingThresholdMs: 5 * 60_000 })

    const nextTaskId = randomUUID()
    const task = await prisma.task.findUniqueOrThrow({ where: { id: fixture.taskId } })
    await prisma.task.create({
      data: {
        id: nextTaskId,
        userId: task.userId,
        projectId: task.projectId,
        type: TASK_TYPE.VIRAL_VIDEO_ANALYSIS,
        targetType: 'ViralReplication',
        targetId: fixture.replicationId,
        status: TASK_STATUS.PROCESSING,
      },
    })
    await prisma.viralReplication.update({
      where: { id: fixture.replicationId },
      data: { status: 'analyzing', errorMessage: null },
    })

    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'viral-watchdog-retry-'))
    const analyzedShot = {
      shotIndex: 0, startMs: 0, endMs: 1_000, shotType: 'medium', cameraAngle: 'eye level',
      cameraMove: 'static', composition: 'centered', actionBeat: 'reveal', transition: 'cut',
      subtitleSummary: null, narrativeFunction: 'hook',
    }
    const completion = (content: string) => ({
      id: 'completion', object: 'chat.completion', created: 0, model: 'provider::model',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content, refusal: null } }],
    })
    const handler = createViralReplicationAnalysisHandler({
      prisma,
      getObjectStream: async () => Readable.from(Buffer.from('video')),
      preprocess: async () => ({
        metadata: { durationMs: 1_000, width: 1080, height: 1920, videoStreamIndex: 0, formatName: 'mp4' },
        shots: [{ shotIndex: 0, startMs: 0, endMs: 1_000, representativeMs: 500, framePath: 'frame.jpg' }],
        transcriptText: null,
      }),
      readFrame: async () => Buffer.from('jpeg'),
      uploadObject: async (_body: Buffer, key: string) => key,
      deleteObject: async () => undefined,
      runVision: async () => completion(JSON.stringify({ shots: [analyzedShot] })) as never,
      runText: async () => completion(JSON.stringify({
        schemaVersion: 1,
        overview: { hook: 'hook', coreAppeal: 'appeal', pacing: 'fast', emotionalArc: 'rise' },
        styleFingerprint: { composition: ['centered'], lighting: ['soft'], color: ['warm'], editing: ['cut'] },
        shots: [analyzedShot],
        originalAdaptationAdvice: ['Create original content.'],
      })) as never,
      reportProgress: async () => undefined,
      touchTaskHeartbeat: async () => true,
      makeTempDirectory: async () => await fs.mkdtemp(path.join(root, 'run-')),
      removeTempDirectory: async (directory: string) => await fs.rm(directory, { recursive: true, force: true }),
      now: () => new Date(),
      createExecutionToken: () => 'execution-token-recovered',
      warn: vi.fn(),
    } as never)

    try {
      await handler({
        data: {
          taskId: nextTaskId,
          type: TASK_TYPE.VIRAL_VIDEO_ANALYSIS,
          locale: 'en',
          projectId: task.projectId,
          targetType: 'ViralReplication',
          targetId: fixture.replicationId,
          userId: task.userId,
          payload: {
            sourceVideoMediaId: fixture.sourceMediaId,
            analysisModelSnapshot: 'provider::model',
          },
        },
      } as never)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }

    await expect(prisma.viralReplication.findUniqueOrThrow({ where: { id: fixture.replicationId } }))
      .resolves.toMatchObject({
        status: 'review_ready',
        analysisExecutionTaskId: nextTaskId,
        analysisExecutionToken: null,
      })
  })
})
