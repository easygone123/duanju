import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createViralReplicationAnalysisHandler } from '@/lib/workers/handlers/viral-replication-analysis'

function completion(text: string) {
  return {
    id: 'completion',
    object: 'chat.completion',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text, refusal: null } }],
  }
}

function shot(shotIndex: number, startMs = shotIndex * 1_000, endMs = (shotIndex + 1) * 1_000) {
  return {
    shotIndex,
    startMs,
    endMs,
    shotType: 'medium',
    cameraAngle: 'eye level',
    cameraMove: 'static',
    composition: `composition ${shotIndex}`,
    actionBeat: `action ${shotIndex}`,
    transition: 'cut',
    subtitleSummary: null,
    narrativeFunction: `beat ${shotIndex}`,
  }
}

function report(shots: ReturnType<typeof shot>[]) {
  return {
    schemaVersion: 1,
    overview: {
      hook: 'hook',
      coreAppeal: 'appeal',
      pacing: 'fast',
      emotionalArc: 'rise',
    },
    styleFingerprint: {
      composition: ['centered'],
      lighting: ['soft'],
      color: ['warm'],
      editing: ['hard cuts'],
    },
    shots,
    originalAdaptationAdvice: ['Keep the rhythm, invent original content.'],
  }
}

type HarnessOptions = {
  frameCount?: number
  visionText?: (batchIndex: number, shotIndexes: number[]) => string
  aggregateText?: string
  sourceVideoMediaId?: string
}

async function createHarness(options: HarnessOptions = {}) {
  const frameCount = options.frameCount ?? 12
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'viral-analysis-test-'))
  const sourceVideoMediaId = options.sourceVideoMediaId ?? 'source-media'
  const replication = {
    id: 'replication-1',
    userId: 'user-1',
    projectId: 'project-1',
    brief: 'Make an original launch video',
    status: 'analyzing',
    analysisModelSnapshot: 'provider::pinned-analysis-model',
    sourceVideoMediaId,
    sourceVideoMedia: { id: sourceVideoMediaId, storageKey: 'source/video.mp4' },
  }
  const frameMedia: Array<Record<string, unknown>> = []
  const frames: Array<Record<string, unknown>> = []
  const updates: Array<Record<string, unknown>> = []
  const progress: Array<{ value: number; payload?: Record<string, unknown> }> = []
  const visionCalls: Array<Record<string, unknown>> = []
  const textCalls: Array<Record<string, unknown>> = []
  let nextMedia = 1
  let nextAnalyzedShot = 0

  const prisma = {
    viralReplication: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return where.id === replication.id && where.userId === replication.userId ? replication : null
      }),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data)
        Object.assign(replication, data)
        return { count: 1 }
      }),
    },
    mediaObject: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const media = { id: `frame-media-${nextMedia++}`, ...data }
        frameMedia.push(media)
        return media
      }),
    },
    viralReplicationFrame: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const frame = { id: `frame-${frames.length + 1}`, ...data }
        frames.push(frame)
        return frame
      }),
    },
  }

  const preprocess = vi.fn(async ({ outputDirectory }: { sourcePath: string; outputDirectory: string }) => {
    await fs.mkdir(outputDirectory, { recursive: true })
    const shots = []
    for (let shotIndex = 0; shotIndex < frameCount; shotIndex += 1) {
      const framePath = path.join(outputDirectory, `shot-${shotIndex}.jpg`)
      await fs.writeFile(framePath, Buffer.from(`jpeg-${shotIndex}`))
      shots.push({
        shotIndex,
        startMs: shotIndex * 1_000,
        endMs: (shotIndex + 1) * 1_000,
        representativeMs: shotIndex * 1_000 + 500,
        framePath,
      })
    }
    return {
      metadata: {
        durationMs: frameCount * 1_000,
        width: 1080,
        height: 1920,
        videoStreamIndex: 0,
        container: 'mp4',
        subtitleStreams: [],
      },
      shots,
      transcriptText: '00:00:01.000 --> 00:00:02.000\nEmbedded subtitle context',
    }
  })
  const uploadObject = vi.fn(async (_body: Buffer, key: string) => key)
  const runVision = vi.fn(async (input: Record<string, unknown>) => {
    visionCalls.push(input)
    const imageCount = (input.imageUrls as string[]).length
    const shotIndexes = Array.from({ length: imageCount }, (_, index) => nextAnalyzedShot + index)
    nextAnalyzedShot += imageCount
    const batchIndex = visionCalls.length - 1
    const text = options.visionText?.(batchIndex, shotIndexes)
      ?? JSON.stringify({ shots: shotIndexes.map((index) => shot(index)) })
    return completion(text)
  })
  const runText = vi.fn(async (input: Record<string, unknown>) => {
    textCalls.push(input)
    return completion(options.aggregateText ?? JSON.stringify(report(Array.from({ length: frameCount }, (_, index) => shot(index)))))
  })
  const getObjectStream = vi.fn(async () => Readable.from(Buffer.from('source-video')))

  const handler = createViralReplicationAnalysisHandler({
    prisma: prisma as never,
    getObjectStream,
    preprocess: preprocess as never,
    uploadObject,
    runVision: runVision as never,
    runText: runText as never,
    reportProgress: vi.fn(async (_job, value, payload) => {
      progress.push({ value, payload })
    }),
    makeTempDirectory: vi.fn(async () => await fs.mkdtemp(path.join(root, 'worker-'))),
    removeTempDirectory: vi.fn(async (directory: string) => await fs.rm(directory, { recursive: true, force: true })),
  })

  const job = {
    data: {
      taskId: 'task-1',
      type: 'viral_video_analysis',
      locale: 'en',
      projectId: 'project-1',
      targetType: 'ViralReplication',
      targetId: 'replication-1',
      userId: 'user-1',
      payload: {
        sourceVideoMediaId,
        analysisModelSnapshot: 'provider::pinned-analysis-model',
      },
    },
  }

  return {
    root,
    handler,
    job,
    replication,
    prisma,
    preprocess,
    getObjectStream,
    uploadObject,
    runVision,
    runText,
    frameMedia,
    frames,
    updates,
    progress,
    visionCalls,
    textCalls,
  }
}

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await fs.rm(root, { recursive: true, force: true })))
})

describe('viral replication analysis handler', () => {
  it('streams, preprocesses, persists every frame, and analyzes ordered batches of at most ten', async () => {
    const harness = await createHarness({ frameCount: 12 })
    roots.push(harness.root)

    await harness.handler(harness.job as never)

    expect(harness.preprocess).toHaveBeenCalledOnce()
    expect(harness.getObjectStream).toHaveBeenCalledWith('source/video.mp4')
    const sourcePath = harness.preprocess.mock.calls[0]?.[0].sourcePath
    await expect(fs.readFile(sourcePath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(harness.uploadObject).toHaveBeenCalledTimes(12)
    expect(harness.frameMedia).toHaveLength(12)
    expect(harness.frames.map((frame) => frame.shotIndex)).toEqual(Array.from({ length: 12 }, (_, index) => index))
    expect(harness.visionCalls).toHaveLength(2)
    expect(harness.visionCalls.map((call) => (call.imageUrls as string[]).length)).toEqual([10, 2])
    expect(harness.visionCalls.flatMap((call) => call.imageUrls as string[])).toEqual(
      Array.from({ length: 12 }, (_, index) => `data:image/jpeg;base64,${Buffer.from(`jpeg-${index}`).toString('base64')}`),
    )
    expect(harness.visionCalls[0]?.prompt).toContain('Embedded subtitle context')
    expect(harness.visionCalls[0]?.prompt).toContain('"representativeMs":500')
    expect(harness.progress.some(({ payload }) => payload?.stage === 'viral_preprocess')).toBe(true)
    expect(harness.progress.some(({ payload }) => payload?.stage === 'viral_vision_analysis')).toBe(true)
  })

  it('pins every vision batch and the single aggregation call to the saved analysis model', async () => {
    const harness = await createHarness({ frameCount: 11 })
    roots.push(harness.root)

    await harness.handler(harness.job as never)

    expect(harness.runVision).toHaveBeenCalledTimes(2)
    expect(harness.runText).toHaveBeenCalledOnce()
    expect([...harness.visionCalls, ...harness.textCalls].map((call) => call.model)).toEqual([
      'provider::pinned-analysis-model',
      'provider::pinned-analysis-model',
      'provider::pinned-analysis-model',
    ])
  })

  it('validates aggregation and writes the completed report in one state update', async () => {
    const harness = await createHarness({ frameCount: 3 })
    roots.push(harness.root)

    await harness.handler(harness.job as never)

    expect(harness.textCalls).toHaveLength(1)
    expect(harness.updates).toHaveLength(1)
    expect(harness.updates[0]).toMatchObject({
      status: 'review_ready',
      transcriptText: expect.stringContaining('Embedded subtitle context'),
      durationMs: 3_000,
      reportJson: { schemaVersion: 1 },
    })
  })

  it('marks only the replication failed and rethrows invalid model JSON without fallback', async () => {
    const harness = await createHarness({ frameCount: 3, visionText: () => 'not-json' })
    roots.push(harness.root)

    await expect(harness.handler(harness.job as never)).rejects.toThrow()

    expect(harness.runVision).toHaveBeenCalledOnce()
    expect(harness.runText).not.toHaveBeenCalled()
    expect(harness.updates).toEqual([{ status: 'failed' }])
  })

  it('rejects a payload media mismatch before downloading or preprocessing', async () => {
    const harness = await createHarness()
    roots.push(harness.root)
    harness.job.data.payload.sourceVideoMediaId = 'other-media'

    await expect(harness.handler(harness.job as never)).rejects.toThrow(/source video/i)

    expect(harness.preprocess).not.toHaveBeenCalled()
    expect(harness.runVision).not.toHaveBeenCalled()
    expect(harness.updates).toEqual([{ status: 'failed' }])
  })
})
