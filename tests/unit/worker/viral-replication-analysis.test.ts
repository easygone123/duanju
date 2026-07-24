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

function shot(
  shotIndex: number,
  startMs = shotIndex * 1_000,
  endMs = (shotIndex + 1) * 1_000,
): {
  shotIndex: number
  startMs: number
  endMs: number
  shotType: string
  cameraAngle: string
  cameraMove: string
  composition: string
  actionBeat: string
  transition: string
  subtitleSummary: string | null
  narrativeFunction: string
  visibleCharacters: string[]
  speaker: string | null
  location: string | null
  props: string[]
  dialogueIntent: string | null
  plotBeat: string | null
  causalLink: string | null
  analysisConfidence: number
  needsVisualReview: boolean
} {
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
    visibleCharacters: [`character ${shotIndex}`],
    speaker: `character ${shotIndex}`,
    location: `location ${shotIndex}`,
    props: [],
    dialogueIntent: null,
    plotBeat: `plot beat ${shotIndex}`,
    causalLink: shotIndex === 0 ? null : `follows shot ${shotIndex - 1}`,
    analysisConfidence: 0.95,
    needsVisualReview: false,
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
    sourceStory: {
      summary: 'A character encounters and resolves a problem.',
      premise: 'A routine moment becomes unexpected.',
      characterRelations: ['character 0 interacts with character 1'],
      storyBeats: shots.map((item) => ({
        shotIndexes: [item.shotIndex],
        beat: item.plotBeat || item.actionBeat,
        cause: item.causalLink,
        effect: null,
      })),
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
  reviewText?: string | ((reviewCallIndex: number, imageCount: number) => string)
  aggregateText?: string
  transcriptText?: string | null
  includeAnalysisAudio?: boolean
  analysisAudioSegments?: Array<{ startMs: number; endMs: number }>
  audioTranscriptionText?: string | ((callIndex: number) => string)
  audioTranscriptionError?: Error
  externalAsrTranscript?: string | null
  analysisModelSnapshot?: string
  sourceVideoMediaId?: string
  mediaCreateError?: Error
  frameCreateError?: Error
  cleanupError?: Error
  initialStatus?: string
  initialExecutionToken?: string | null
  initialExecutionExpiresAt?: Date | null
  now?: Date
  onVision?: (replication: Record<string, unknown>) => void | Promise<void>
  sourceGate?: Promise<void>
  existingFrameMedia?: boolean
}

function whereMatches(record: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const key of [
    'id',
    'userId',
    'status',
    'sourceVideoMediaId',
    'analysisModelSnapshot',
    'analysisExecutionTaskId',
    'analysisExecutionToken',
  ]) {
    if (key in where && record[key] !== where[key]) return false
  }
  if (Array.isArray(where.OR)) {
    return where.OR.some((candidate) => whereMatches(record, candidate as Record<string, unknown>))
  }
  const expiry = where.analysisExecutionExpiresAt
  if (expiry && typeof expiry === 'object' && 'lte' in expiry) {
    const current = record.analysisExecutionExpiresAt
    if (!(current instanceof Date) || current > (expiry as { lte: Date }).lte) return false
  }
  return true
}

async function createHarness(options: HarnessOptions = {}) {
  const frameCount = options.frameCount ?? 12
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'viral-analysis-test-'))
  const sourceVideoMediaId = options.sourceVideoMediaId ?? 'source-media'
  const replication: Record<string, unknown> & {
    id: string
    userId: string
    projectId: string
    brief: string
    status: string
    analysisModelSnapshot: string
    sourceVideoMediaId: string
    sourceVideoMedia: { id: string; storageKey: string }
  } = {
    id: 'replication-1',
    userId: 'user-1',
    projectId: 'project-1',
    brief: 'Make an original launch video',
    status: options.initialStatus ?? 'analyzing',
    analysisExecutionTaskId: null,
    analysisExecutionToken: options.initialExecutionToken ?? null,
    analysisExecutionExpiresAt: options.initialExecutionExpiresAt ?? null,
    analysisModelSnapshot: options.analysisModelSnapshot ?? 'provider::pinned-analysis-model',
    sourceVideoMediaId,
    sourceVideoMedia: { id: sourceVideoMediaId, storageKey: 'source/video.mp4' },
  }
  const frameMedia: Array<Record<string, unknown>> = []
  const frames: Array<Record<string, unknown>> = []
  const updates: Array<Record<string, unknown>> = []
  const updateWheres: Array<Record<string, unknown>> = []
  const progress: Array<{ value: number; payload?: Record<string, unknown> }> = []
  const visionCalls: Array<Record<string, unknown>> = []
  const textCalls: Array<Record<string, unknown>> = []
  let nextMedia = 1
  let nextAnalyzedShot = 0
  let nextReviewCall = 0
  let nextAudioTranscriptionCall = 0
  let nextExecutionToken = 0
  if (options.existingFrameMedia) {
    frameMedia.push({
      id: 'existing-frame-media',
      storageKey: 'viral-replications/replication-1/frames/000.jpg',
    })
  }

  function findFrame(shotIndex: number) {
    return frames.find((frame) => frame.shotIndex === shotIndex) || null
  }

  const prisma = {
    viralReplication: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return whereMatches(replication, where) ? replication : null
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        updateWheres.push(where)
        if (!whereMatches(replication, where)) return { count: 0 }
        updates.push(data)
        Object.assign(replication, data)
        return { count: 1 }
      }),
    },
    mediaObject: {
      findUnique: vi.fn(async ({ where }: { where: { storageKey: string } }) => (
        frameMedia.find((media) => media.storageKey === where.storageKey) || null
      )),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (options.mediaCreateError) throw options.mediaCreateError
        const media = { id: `frame-media-${nextMedia++}`, ...data }
        frameMedia.push(media)
        return media
      }),
      upsert: vi.fn(async ({ where, create, update }: {
        where: { storageKey: string }
        create: Record<string, unknown>
        update: Record<string, unknown>
      }) => {
        if (options.mediaCreateError) throw options.mediaCreateError
        const existing = frameMedia.find((media) => media.storageKey === where.storageKey)
        if (existing) {
          Object.assign(existing, update)
          return existing as { id: string }
        }
        const media = { id: `frame-media-${nextMedia++}`, ...create }
        frameMedia.push(media)
        return media
      }),
    },
    viralReplicationFrame: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (options.frameCreateError) throw options.frameCreateError
        const frame = { id: `frame-${frames.length + 1}`, ...data }
        frames.push(frame)
        return frame
      }),
      findUnique: vi.fn(async ({ where }: {
        where: { replicationId_shotIndex: { shotIndex: number } }
      }) => findFrame(where.replicationId_shotIndex.shotIndex)),
      upsert: vi.fn(async ({ where, create, update }: {
        where: { replicationId_shotIndex: { shotIndex: number } }
        create: Record<string, unknown>
        update: Record<string, unknown>
      }) => {
        if (options.frameCreateError) throw options.frameCreateError
        const existing = findFrame(where.replicationId_shotIndex.shotIndex)
        if (existing) {
          Object.assign(existing, update)
          return existing
        }
        const frame = { id: `frame-${frames.length + 1}`, ...create }
        frames.push(frame)
        return frame
      }),
    },
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      const replicationSnapshot = { ...replication }
      const updateCount = updates.length
      const updateWhereCount = updateWheres.length
      const mediaCount = frameMedia.length
      const frameCountBefore = frames.length
      const mediaSequence = nextMedia
      try {
        return await callback(prisma)
      } catch (error: unknown) {
        Object.assign(replication, replicationSnapshot)
        updates.splice(updateCount)
        updateWheres.splice(updateWhereCount)
        frameMedia.splice(mediaCount)
        frames.splice(frameCountBefore)
        nextMedia = mediaSequence
        throw error
      }
    }),
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
    const includeAnalysisAudio = options.includeAnalysisAudio === true
    const analysisAudioPath = includeAnalysisAudio
      ? path.join(outputDirectory, 'analysis-audio.mp3')
      : null
    if (analysisAudioPath) await fs.writeFile(analysisAudioPath, Buffer.from('analysis-audio'))
    const analysisAudioSegments = await Promise.all(
      (options.analysisAudioSegments ?? []).map(async (segment, segmentIndex) => {
        const audioPath = path.join(outputDirectory, `analysis-audio-${segmentIndex}.mp3`)
        await fs.writeFile(audioPath, Buffer.from(`analysis-audio-${segmentIndex}`))
        return { ...segment, audioPath }
      }),
    )
    const transcriptText = Object.hasOwn(options, 'transcriptText')
      ? options.transcriptText ?? null
      : '00:00:01.000 --> 00:00:02.000\nEmbedded subtitle context'
    return {
      metadata: {
        durationMs: frameCount * 1_000,
        width: 1080,
        height: 1920,
        videoStreamIndex: 0,
        container: 'mp4',
        audioStreams: includeAnalysisAudio ? [{ index: 1, codecName: 'aac' }] : [],
        subtitleStreams: [],
      },
      shots,
      transcriptText,
      analysisAudioSegments,
      analysisAudioPath,
    }
  })
  const extractReviewFrames = vi.fn(async ({
    outputDirectory,
    shots,
  }: {
    outputDirectory: string
    shots: Array<{ shotIndex: number; startMs: number; endMs: number }>
  }) => {
    const reviewFrames = []
    for (const candidate of shots) {
      for (const [position, timestampMs] of [
        ['opening', candidate.startMs + 200],
        ['closing', candidate.endMs - 200],
      ] as const) {
        const framePath = path.join(
          outputDirectory,
          `review-${candidate.shotIndex}-${position}.jpg`,
        )
        await fs.writeFile(framePath, Buffer.from(`review-${candidate.shotIndex}-${position}`))
        reviewFrames.push({
          shotIndex: candidate.shotIndex,
          position,
          timestampMs,
          framePath,
        })
      }
    }
    return reviewFrames
  })
  const uploadObject = vi.fn(async (_body: Buffer, key: string) => key)
  const runVision = vi.fn(async (input: Record<string, unknown>) => {
    visionCalls.push(input)
    const imageUrls = input.imageUrls as string[]
    if (imageUrls[0]?.startsWith('data:audio/')) {
      if (options.audioTranscriptionError) throw options.audioTranscriptionError
      const text = typeof options.audioTranscriptionText === 'function'
        ? options.audioTranscriptionText(nextAudioTranscriptionCall++)
        : options.audioTranscriptionText
      return completion(text ?? JSON.stringify({ cues: [] }))
    }
    const action = (input.options as { action?: string } | undefined)?.action
    if (action === 'viral_shot_review') {
      if (!options.reviewText) throw new Error('Unexpected adaptive review call')
      const text = typeof options.reviewText === 'function'
        ? options.reviewText(nextReviewCall++, imageUrls.length)
        : options.reviewText
      return completion(text)
    }
    await options.onVision?.(replication)
    const imageCount = imageUrls.length
    const firstShotIndex = nextAnalyzedShot % frameCount
    const shotIndexes = Array.from({ length: imageCount }, (_, index) => firstShotIndex + index)
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
  const transcribeAudio = vi.fn(async () => (
    Object.hasOwn(options, 'externalAsrTranscript')
      ? { configured: true as const, transcriptText: options.externalAsrTranscript ?? null }
      : { configured: false as const }
  ))
  const getObjectStream = vi.fn(async () => {
    await options.sourceGate
    return Readable.from(Buffer.from('source-video'))
  })
  const deleteObject = vi.fn(async () => undefined)
  const warn = vi.fn()
  let activeFrameReads = 0
  let maxActiveFrameReads = 0
  const readFrame = vi.fn(async (framePath: string) => {
    activeFrameReads += 1
    maxActiveFrameReads = Math.max(maxActiveFrameReads, activeFrameReads)
    try {
      await Promise.resolve()
      return await fs.readFile(framePath)
    } finally {
      activeFrameReads -= 1
    }
  })

  const handler = createViralReplicationAnalysisHandler({
    prisma: prisma as never,
    getObjectStream,
    preprocess: preprocess as never,
    extractReviewFrames: extractReviewFrames as never,
    uploadObject,
    deleteObject,
    readFrame,
    runVision: runVision as never,
    runText: runText as never,
    transcribeAudio,
    reportProgress: vi.fn(async (_job, value, payload) => {
      progress.push({ value, payload })
    }),
    touchTaskHeartbeat: vi.fn(async () => true),
    makeTempDirectory: vi.fn(async () => await fs.mkdtemp(path.join(root, 'worker-'))),
    removeTempDirectory: vi.fn(async (directory: string) => {
      await fs.rm(directory, { recursive: true, force: true })
      if (options.cleanupError) throw options.cleanupError
    }),
    warn,
    now: () => options.now ?? new Date('2026-07-15T01:00:00.000Z'),
    createExecutionToken: () => (
      nextExecutionToken++ === 0 ? 'execution-token-new' : `execution-token-${nextExecutionToken}`
    ),
  } as never)

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
        analysisModelSnapshot: options.analysisModelSnapshot ?? 'provider::pinned-analysis-model',
      },
    },
    queueName: 'viral',
    token: 'bull-token-task-1',
    updateData: vi.fn(async (nextData: Record<string, unknown>) => {
      job.data = nextData as typeof job.data
    }),
    moveToDelayed: vi.fn(async () => undefined),
  }

  return {
    root,
    handler,
    job,
    replication,
    prisma,
    preprocess,
    extractReviewFrames,
    getObjectStream,
    uploadObject,
    deleteObject,
    warn,
    readFrame,
    maxActiveFrameReads: () => maxActiveFrameReads,
    runVision,
    runText,
    transcribeAudio,
    frameMedia,
    frames,
    updates,
    updateWheres,
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
    expect((harness.visionCalls[0]?.prompt as string).match(/Embedded subtitle context/g)).toHaveLength(1)
    expect(harness.visionCalls[1]?.prompt).not.toContain('Embedded subtitle context')
    expect(harness.visionCalls[1]?.prompt).toContain('plot beat 9')
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
    const completedUpdates = harness.updates.filter((update) => update.status === 'review_ready')
    expect(completedUpdates).toHaveLength(1)
    expect(completedUpdates[0]).toMatchObject({
      status: 'review_ready',
      transcriptText: expect.stringContaining('Embedded subtitle context'),
      durationMs: 3_000,
      reportJson: { schemaVersion: 1 },
    })
  })

  it('requires audio transcription and deterministically overlays transcript cues onto every shot', async () => {
    const harness = await createHarness({
      frameCount: 3,
      transcriptText: null,
      includeAnalysisAudio: true,
      analysisModelSnapshot: 'google::gemini-audio',
      audioTranscriptionText: JSON.stringify({
        cues: [
          { startMs: 100, endMs: 900, text: '第一句原声' },
          { startMs: 1_100, endMs: 2_700, text: '跨镜头原声' },
        ],
      }),
      aggregateText: JSON.stringify(report([
        { ...shot(0), subtitleSummary: '模型改写一' },
        { ...shot(1), subtitleSummary: '模型改写二' },
        { ...shot(2), subtitleSummary: '模型改写三' },
      ])),
    })
    roots.push(harness.root)

    await harness.handler(harness.job as never)

    expect(harness.visionCalls[0]?.imageUrls).toEqual([
      `data:audio/mpeg;base64,${Buffer.from('analysis-audio').toString('base64')}`,
    ])
    const completed = harness.updates.find((update) => update.status === 'review_ready')
    expect(completed?.transcriptText).toContain('第一句原声')
    expect((completed?.reportJson as ReturnType<typeof report>).shots.map((item) => item.subtitleSummary)).toEqual([
      '第一句原声',
      '跨镜头原声',
      '跨镜头原声',
    ])
  })

  it('uses configured external ASR even when the analysis model cannot accept inline audio', async () => {
    const harness = await createHarness({
      frameCount: 3,
      transcriptText: null,
      includeAnalysisAudio: true,
      analysisModelSnapshot: 'provider::text-and-vision-only',
      externalAsrTranscript: [
        '1',
        '00:00:00,100 --> 00:00:00,900',
        '独立 ASR 原声',
      ].join('\n'),
    })
    roots.push(harness.root)

    await harness.handler(harness.job as never)

    expect(harness.transcribeAudio).toHaveBeenCalledOnce()
    expect(harness.visionCalls.some(
      (call) => (call.imageUrls as string[])[0]?.startsWith('data:audio/'),
    )).toBe(false)
    const completed = harness.updates.find((update) => update.status === 'review_ready')
    expect(completed?.transcriptText).toContain('独立 ASR 原声')
  })

  it('keeps embedded subtitles primary and transcribes only declared missing audio segments', async () => {
    const harness = await createHarness({
      frameCount: 12,
      transcriptText: [
        '1',
        '00:00:00,000 --> 00:00:04,000',
        '内嵌字幕',
      ].join('\n'),
      analysisAudioSegments: [{ startMs: 6_000, endMs: 10_000 }],
      analysisModelSnapshot: 'google::gemini-audio',
      audioTranscriptionText: JSON.stringify({
        cues: [
          { startMs: 0, endMs: 2_000, text: '音频补齐字幕' },
        ],
      }),
    })
    roots.push(harness.root)

    await harness.handler(harness.job as never)

    const audioCalls = harness.visionCalls.filter(
      (call) => (call.options as { action?: string }).action === 'viral_audio_transcription',
    )
    expect(audioCalls).toHaveLength(1)
    expect(audioCalls[0]?.imageUrls).toEqual([
      `data:audio/mpeg;base64,${Buffer.from('analysis-audio-0').toString('base64')}`,
    ])
    const completed = harness.updates.find((update) => update.status === 'review_ready')
    expect(completed?.transcriptText).toContain('内嵌字幕')
    expect(completed?.transcriptText).toContain('00:00:06,000 --> 00:00:08,000')
    expect(completed?.transcriptText).toContain('音频补齐字幕')
  })

  it('reviews only low-confidence shots with representative, opening, and closing frames', async () => {
    const initialShots = [
      shot(0),
      {
        ...shot(1),
        speaker: null,
        plotBeat: null,
        analysisConfidence: 0.4,
        needsVisualReview: true,
      },
      shot(2),
    ]
    const reviewedShot = {
      ...shot(1),
      speaker: 'customer',
      dialogueIntent: 'asks why the offer changed',
      plotBeat: 'the customer questions the changed offer',
      causalLink: 'responds to the offer shown in the previous shot',
      analysisConfidence: 0.93,
      needsVisualReview: false,
    }
    const harness = await createHarness({
      frameCount: 3,
      transcriptText: [
        '1',
        '00:00:01,100 --> 00:00:01,900',
        '为什么优惠变了',
      ].join('\n'),
      visionText: () => JSON.stringify({ shots: initialShots }),
      reviewText: JSON.stringify({ shots: [reviewedShot] }),
      aggregateText: JSON.stringify(report(initialShots)),
    })
    roots.push(harness.root)

    await harness.handler(harness.job as never)

    expect(harness.extractReviewFrames).toHaveBeenCalledOnce()
    expect(harness.extractReviewFrames.mock.calls[0]?.[0].shots.map(
      (candidate: { shotIndex: number }) => candidate.shotIndex,
    )).toEqual([1])
    const reviewCall = harness.visionCalls.find(
      (call) => (call.options as { action?: string }).action === 'viral_shot_review',
    )
    expect(reviewCall?.imageUrls).toEqual([
      `data:image/jpeg;base64,${Buffer.from('review-1-opening').toString('base64')}`,
      `data:image/jpeg;base64,${Buffer.from('jpeg-1').toString('base64')}`,
      `data:image/jpeg;base64,${Buffer.from('review-1-closing').toString('base64')}`,
    ])
    expect(reviewCall?.prompt).toContain('"frameTimestampsMs":[1200,1500,1800]')
    const completed = harness.updates.find((update) => update.status === 'review_ready')
    const completedReport = completed?.reportJson as ReturnType<typeof report>
    expect(completedReport.shots[1]).toMatchObject({
      speaker: 'customer',
      subtitleSummary: '为什么优惠变了',
      plotBeat: 'the customer questions the changed offer',
      analysisConfidence: 0.93,
      needsVisualReview: false,
    })
    expect(harness.textCalls[0]?.messages).toEqual([
      expect.objectContaining({
        content: expect.stringContaining('the customer questions the changed offer'),
      }),
    ])
    expect(harness.progress.some(({ payload }) => payload?.stage === 'viral_plot_review')).toBe(true)
  })

  it('caps adaptive review at twelve lowest-confidence shots and batches at four shots', async () => {
    const initialShots = Array.from({ length: 15 }, (_, index) => ({
      ...shot(index),
      analysisConfidence: index / 100,
      needsVisualReview: true,
    }))
    const harness = await createHarness({
      frameCount: 15,
      transcriptText: null,
      visionText: (_batchIndex, shotIndexes) => JSON.stringify({
        shots: shotIndexes.map((index) => initialShots[index]),
      }),
      reviewText: (reviewCallIndex) => JSON.stringify({
        shots: Array.from({ length: 4 }, (_, batchIndex) => ({
          ...shot(reviewCallIndex * 4 + batchIndex),
          analysisConfidence: 0.9,
          needsVisualReview: false,
        })),
      }),
      aggregateText: JSON.stringify(report(initialShots)),
    })
    roots.push(harness.root)

    await harness.handler(harness.job as never)

    const reviewedCandidates = harness.extractReviewFrames.mock.calls[0]?.[0].shots
    expect(reviewedCandidates).toHaveLength(12)
    expect(reviewedCandidates.map(
      (candidate: { shotIndex: number }) => candidate.shotIndex,
    )).toEqual(Array.from({ length: 12 }, (_, index) => index))
    const reviewCalls = harness.visionCalls.filter(
      (call) => (call.options as { action?: string }).action === 'viral_shot_review',
    )
    expect(reviewCalls).toHaveLength(3)
    expect(reviewCalls.map((call) => (call.imageUrls as string[]).length)).toEqual([12, 12, 12])
  })

  it('fails explicitly instead of continuing with visual subtitle summaries when audio transcription fails', async () => {
    const harness = await createHarness({
      frameCount: 3,
      transcriptText: null,
      includeAnalysisAudio: true,
      analysisModelSnapshot: 'google::gemini-audio',
      audioTranscriptionError: new Error('provider audio request failed'),
    })
    roots.push(harness.root)

    await expect(harness.handler(harness.job as never)).rejects.toThrow(
      'VIRAL_AUDIO_TRANSCRIPTION_FAILED',
    )

    expect(harness.runText).not.toHaveBeenCalled()
    expect(harness.updates.filter((update) => update.status === 'failed')).toEqual([{
      status: 'failed',
      errorMessage: 'VIRAL_AUDIO_TRANSCRIPTION_FAILED',
      analysisExecutionTaskId: null,
      analysisExecutionToken: null,
      analysisExecutionExpiresAt: null,
    }])
    expect(harness.warn).toHaveBeenCalledWith(
      'Failed to transcribe viral source audio',
      expect.objectContaining({ message: 'provider audio request failed' }),
    )
  })

  it('marks only the replication failed and rethrows invalid model JSON without fallback', async () => {
    const harness = await createHarness({ frameCount: 3, visionText: () => 'not-json' })
    roots.push(harness.root)

    await expect(harness.handler(harness.job as never)).rejects.toThrow()

    expect(harness.runVision).toHaveBeenCalledOnce()
    expect(harness.runText).not.toHaveBeenCalled()
    expect(harness.updates.filter((update) => update.status === 'failed')).toEqual([{
      status: 'failed',
      errorMessage: 'VIRAL_ANALYSIS_FAILED',
      analysisExecutionTaskId: null,
      analysisExecutionToken: null,
      analysisExecutionExpiresAt: null,
    }])
    expect(harness.updateWheres.at(-1)).toMatchObject({
      status: 'analyzing',
      sourceVideoMediaId: 'source-media',
      analysisModelSnapshot: 'provider::pinned-analysis-model',
      analysisExecutionTaskId: 'task-1',
      analysisExecutionToken: 'execution-token-new',
    })
  })

  it('rejects a payload media mismatch before downloading or preprocessing', async () => {
    const harness = await createHarness()
    roots.push(harness.root)
    harness.job.data.payload.sourceVideoMediaId = 'other-media'

    await expect(harness.handler(harness.job as never)).rejects.toThrow(/superseded/i)

    expect(harness.preprocess).not.toHaveBeenCalled()
    expect(harness.runVision).not.toHaveBeenCalled()
    expect(harness.updates).toEqual([])
  })

  it('claims analysis with an execution token before performing side effects', async () => {
    const harness = await createHarness({ frameCount: 3 })
    roots.push(harness.root)

    await harness.handler(harness.job as never)

    expect(harness.updates[0]).toMatchObject({
      analysisExecutionTaskId: 'task-1',
      analysisExecutionToken: expect.any(String),
      analysisExecutionExpiresAt: expect.any(Date),
    })
    const ownedExecutionWheres = harness.updateWheres.filter((where) => (
      where.analysisExecutionToken === 'execution-token-new'
    ))
    expect(ownedExecutionWheres.length).toBeGreaterThan(0)
    expect(ownedExecutionWheres.every((where) => (
      where.status === 'analyzing'
      && where.sourceVideoMediaId === 'source-media'
      && where.analysisModelSnapshot === 'provider::pinned-analysis-model'
      && where.analysisExecutionTaskId === 'task-1'
    ))).toBe(true)
  })

  it.each(['generating', 'completed', 'failed'])('does not claim when status is %s', async (status) => {
    const harness = await createHarness({ frameCount: 3, initialStatus: status })
    roots.push(harness.root)

    await expect(harness.handler(harness.job as never)).rejects.toThrow(
      status === 'failed' ? /failed/i : /superseded/i,
    )

    expect(harness.getObjectStream).not.toHaveBeenCalled()
    expect(harness.replication.status).toBe(status)
    expect(harness.updates).toEqual([])
  })

  it.each(['generating', 'completed', 'failed'])('does not overwrite newer %s state reached while analysis is running', async (newerStatus) => {
    const harness = await createHarness({
      frameCount: 3,
      onVision: (replication) => {
        replication.status = newerStatus
      },
    })
    roots.push(harness.root)

    await expect(harness.handler(harness.job as never)).rejects.toThrow(/superseded/i)

    expect(harness.replication.status).toBe(newerStatus)
    expect(harness.updates.filter((update) => update.status === 'failed')).toEqual([])
  })

  it('allows an expired lease takeover with a new token', async () => {
    const harness = await createHarness({
      frameCount: 3,
      initialExecutionToken: 'expired-token',
      initialExecutionExpiresAt: new Date('2026-07-15T00:00:00.000Z'),
      now: new Date('2026-07-15T01:00:00.000Z'),
    })
    roots.push(harness.root)

    await harness.handler(harness.job as never)

    expect(harness.updates[0]).toMatchObject({ analysisExecutionToken: 'execution-token-new' })
    expect(harness.replication.status).toBe('review_ready')
  })

  it('prevents an old worker from committing after another worker takes its lease', async () => {
    const harness = await createHarness({
      frameCount: 3,
      onVision: (replication) => {
        replication.analysisExecutionToken = 'newer-worker-token'
      },
    })
    roots.push(harness.root)

    await expect(harness.handler(harness.job as never)).rejects.toThrow(/superseded/i)

    expect(harness.replication.status).toBe('analyzing')
    expect(harness.updates.filter((update) => update.status === 'failed')).toEqual([])
    expect(harness.updates.filter((update) => update.status === 'review_ready')).toEqual([])
  })

  it('allows only one of two interleaved workers to hold the active lease', async () => {
    let releaseSource!: () => void
    const sourceGate = new Promise<void>((resolve) => {
      releaseSource = resolve
    })
    const harness = await createHarness({ frameCount: 3, sourceGate })
    roots.push(harness.root)

    const first = harness.handler(harness.job as never)
    await vi.waitFor(() => expect(harness.getObjectStream).toHaveBeenCalledOnce())
    const second = harness.handler(harness.job as never)
    const secondExpectation = expect(second).rejects.toMatchObject({ name: 'DelayedError' })
    await Promise.resolve()
    releaseSource()

    await expect(first).resolves.toMatchObject({ frameCount: 3 })
    await secondExpectation
    expect(harness.replication.status).toBe('review_ready')
    expect(harness.uploadObject).toHaveBeenCalledTimes(3)
    expect(harness.frames).toHaveLength(3)
    expect(harness.deleteObject).not.toHaveBeenCalled()
  })

  it('compensates a newly uploaded frame when media persistence fails', async () => {
    const harness = await createHarness({
      frameCount: 3,
      mediaCreateError: new Error('media create failed'),
    })
    roots.push(harness.root)

    await expect(harness.handler(harness.job as never)).rejects.toThrow('media create failed')

    expect(harness.uploadObject).toHaveBeenCalledOnce()
    expect(harness.deleteObject).toHaveBeenCalledOnce()
  })

  it('compensates a newly uploaded frame when frame persistence fails', async () => {
    const harness = await createHarness({
      frameCount: 3,
      frameCreateError: new Error('frame create failed'),
    })
    roots.push(harness.root)

    await expect(harness.handler(harness.job as never)).rejects.toThrow('frame create failed')

    expect(harness.uploadObject).toHaveBeenCalledOnce()
    expect(harness.deleteObject).toHaveBeenCalledOnce()
  })

  it('reuses an existing deterministic media object without uploading or deleting it', async () => {
    const harness = await createHarness({ frameCount: 1, existingFrameMedia: true })
    roots.push(harness.root)

    await harness.handler(harness.job as never)

    expect(harness.uploadObject).not.toHaveBeenCalled()
    expect(harness.deleteObject).not.toHaveBeenCalled()
    expect(harness.frames).toHaveLength(1)
    expect(harness.frames[0]).toMatchObject({ mediaId: 'existing-frame-media' })
  })

  it('reuses deterministic persisted frames when the same analysis runs again', async () => {
    const harness = await createHarness({ frameCount: 3 })
    roots.push(harness.root)

    await harness.handler(harness.job as never)
    harness.replication.status = 'analyzing'
    harness.replication.analysisExecutionTaskId = null
    harness.replication.analysisExecutionToken = null
    harness.replication.analysisExecutionExpiresAt = null
    await harness.handler(harness.job as never)

    expect(harness.uploadObject).toHaveBeenCalledTimes(3)
    expect(harness.frames).toHaveLength(3)
  })

  it('does not let cleanup failure reverse a successful analysis', async () => {
    const harness = await createHarness({ frameCount: 3, cleanupError: new Error('cleanup failed') })
    roots.push(harness.root)

    await expect(harness.handler(harness.job as never)).resolves.toMatchObject({ frameCount: 3 })
    expect(harness.warn).toHaveBeenCalledWith(
      'Failed to clean viral analysis temporary directory',
      expect.objectContaining({ message: 'cleanup failed' }),
    )
  })

  it('preserves the primary analysis failure when cleanup also fails', async () => {
    const harness = await createHarness({
      frameCount: 3,
      visionText: () => 'not-json',
      cleanupError: new Error('cleanup failed'),
    })
    roots.push(harness.root)

    await expect(harness.handler(harness.job as never)).rejects.not.toThrow('cleanup failed')
    expect(harness.warn).toHaveBeenCalledOnce()
  })

  it('reads frame bytes in bounded windows and does not retain all frame buffers', async () => {
    const harness = await createHarness({ frameCount: 23 })
    roots.push(harness.root)

    await harness.handler(harness.job as never)

    expect(harness.readFrame).toHaveBeenCalledTimes(46)
    expect(harness.maxActiveFrameReads()).toBeLessThanOrEqual(10)
  })

  it.each([
    ['omits a shot', [shot(0), shot(1)]],
    ['alters a shot boundary', [shot(0), shot(1, 1_000, 1_900), shot(2)]],
    ['reorders shots', [shot(1, 0, 1_000), shot(0, 1_000, 2_000), shot(2)]],
  ])('rejects an aggregation report that %s', async (_label, aggregateShots) => {
    const harness = await createHarness({
      frameCount: 3,
      aggregateText: JSON.stringify(report(aggregateShots)),
    })
    roots.push(harness.root)

    await expect(harness.handler(harness.job as never)).rejects.toThrow(/shot|timeline/i)
    expect(harness.replication.status).toBe('failed')
  })
})
