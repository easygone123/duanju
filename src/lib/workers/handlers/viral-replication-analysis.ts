import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { DelayedError, type Job } from 'bullmq'

import { getProviderKey } from '@/lib/api-config'
import { safeParseJson } from '@/lib/json-repair'
import { getCompletionContent } from '@/lib/llm/completion-parts'
import { createScopedLogger } from '@/lib/logging/core'
import { parseModelKeyStrict } from '@/lib/model-config-contract'
import { stablePublicIdFromStorageKey } from '@/lib/media/hash'
import {
  runModelGatewayTextCompletion,
  runModelGatewayVisionCompletion,
} from '@/lib/model-gateway/llm'
import { prisma } from '@/lib/prisma'
import { deleteObject, getObjectStream, uploadObject } from '@/lib/storage'
import { touchTaskHeartbeat } from '@/lib/task/service'
import type { TaskJobData } from '@/lib/task/types'
import {
  VIRAL_ADAPTIVE_REVIEW_BATCH_SIZE,
  VIRAL_ADAPTIVE_REVIEW_CONFIDENCE_THRESHOLD,
  VIRAL_ANALYSIS_FAILED,
  VIRAL_AUDIO_TRANSCRIPTION_FAILED,
  VIRAL_MAX_ADAPTIVE_REVIEW_SHOTS,
  VIRAL_REPLICATION_STATUS,
} from '@/lib/viral-replication/constants'
import { parseViralAnalysisReport, type ViralAnalysisReportV1 } from '@/lib/viral-replication/contracts'
import { MAX_FRAME_JPEG_BYTES } from '@/lib/viral-replication/ffmpeg'
import {
  audioTextForRange,
  mergeViralAudioTranscripts,
  parseViralAudioCues,
} from '@/lib/viral-replication/audio-timeline'
import {
  buildAnalysisBatches,
  extractViralReviewFrames,
  preprocessViralVideo,
  type PreprocessedViralShot,
  type ViralReviewFrame,
} from '@/lib/viral-replication/preprocess'
import {
  buildViralReportAggregationPrompt,
  buildViralAudioTranscriptionPrompt,
  buildViralShotAnalysisPrompt,
  buildViralShotReviewPrompt,
  parseViralAudioTranscription,
  parseViralShotAnalysisBatch,
  type ViralShotAnalysisBatch,
} from '@/lib/viral-replication/prompts'
import { reportTaskProgress } from '@/lib/workers/shared'

const ANALYSIS_EXECUTION_LEASE_MS = 15 * 60 * 1_000
const analysisLogger = createScopedLogger({ module: 'worker.viral-replication-analysis' })

type ReplicationRecord = {
  id: string
  userId: string
  projectId: string | null
  brief: string
  status: string
  sourceVideoMediaId: string | null
  analysisModelSnapshot: string | null
  analysisExecutionTaskId: string | null
  analysisExecutionToken: string | null
  analysisExecutionExpiresAt: Date | null
  sourceVideoMedia: { id: string; storageKey: string } | null
}

type PersistedFrame = {
  id: string
  mediaId: string
  shotIndex: number
  timestampMs: number
  startMs: number
  endMs: number
  media?: { storageKey: string }
}

type AnalysisTransaction = {
  viralReplication: {
    updateMany(args: Record<string, unknown>): Promise<{ count: number }>
  }
  mediaObject: {
    upsert(args: Record<string, unknown>): Promise<{ id: string }>
  }
  viralReplicationFrame: {
    upsert(args: Record<string, unknown>): Promise<PersistedFrame>
  }
}

type AnalysisPrisma = AnalysisTransaction & {
  viralReplication: AnalysisTransaction['viralReplication'] & {
    findFirst(args: Record<string, unknown>): Promise<ReplicationRecord | null>
  }
  viralReplicationFrame: AnalysisTransaction['viralReplicationFrame'] & {
    findUnique(args: Record<string, unknown>): Promise<PersistedFrame | null>
  }
  mediaObject: AnalysisTransaction['mediaObject'] & {
    findUnique(args: Record<string, unknown>): Promise<{ id: string } | null>
  }
  $transaction<T>(callback: (tx: AnalysisTransaction) => Promise<T>): Promise<T>
}

type VisionCompletion = Awaited<ReturnType<typeof runModelGatewayVisionCompletion>>
type TextCompletion = Awaited<ReturnType<typeof runModelGatewayTextCompletion>>

export type ViralReplicationAnalysisDependencies = {
  prisma: AnalysisPrisma
  getObjectStream(storageKey: string): Promise<NodeJS.ReadableStream>
  preprocess: typeof preprocessViralVideo
  extractReviewFrames?: typeof extractViralReviewFrames
  readFrame(framePath: string): Promise<Buffer>
  uploadObject(body: Buffer, key: string, maxRetries?: number, contentType?: string): Promise<string>
  deleteObject(storageKey: string): Promise<void>
  runVision(input: Parameters<typeof runModelGatewayVisionCompletion>[0]): Promise<VisionCompletion>
  runText(input: Parameters<typeof runModelGatewayTextCompletion>[0]): Promise<TextCompletion>
  reportProgress(job: Job<TaskJobData>, progress: number, payload?: Record<string, unknown>): Promise<unknown>
  touchTaskHeartbeat(taskId: string): Promise<boolean>
  makeTempDirectory(): Promise<string>
  removeTempDirectory(directory: string): Promise<void>
  now(): Date
  createExecutionToken(): string
  warn(message: string, error: unknown): void
}

const defaultDependencies: ViralReplicationAnalysisDependencies = {
  prisma: prisma as unknown as AnalysisPrisma,
  getObjectStream,
  preprocess: preprocessViralVideo,
  extractReviewFrames: extractViralReviewFrames,
  readFrame: fs.readFile,
  uploadObject,
  deleteObject,
  runVision: runModelGatewayVisionCompletion,
  runText: runModelGatewayTextCompletion,
  reportProgress: reportTaskProgress,
  touchTaskHeartbeat,
  makeTempDirectory: async () => await fs.mkdtemp(path.join(os.tmpdir(), 'viral-analysis-')),
  removeTempDirectory: async (directory) => await fs.rm(directory, { recursive: true, force: true }),
  now: () => new Date(),
  createExecutionToken: randomUUID,
  warn: (message, error) => analysisLogger.warn({ message, error }),
}

export class ViralAnalysisSupersededError extends Error {
  constructor(message = 'Viral analysis execution was superseded') {
    super(message)
    this.name = 'ViralAnalysisSupersededError'
  }
}

export class ViralAudioTranscriptionError extends Error {
  readonly code = VIRAL_AUDIO_TRANSCRIPTION_FAILED

  constructor(message = VIRAL_AUDIO_TRANSCRIPTION_FAILED, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ViralAudioTranscriptionError'
  }
}

function requirePayloadString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Viral analysis payload is missing ${key}`)
  }
  return value.trim()
}

function executionWhere(input: {
  job: Job<TaskJobData>
  token: string
  sourceVideoMediaId: string
  model: string
}) {
  return {
    id: input.job.data.targetId,
    userId: input.job.data.userId,
    status: VIRAL_REPLICATION_STATUS.ANALYZING,
    sourceVideoMediaId: input.sourceVideoMediaId,
    analysisModelSnapshot: input.model,
    analysisExecutionTaskId: input.job.data.taskId,
    analysisExecutionToken: input.token,
  }
}

function nextLeaseExpiry(dependencies: ViralReplicationAnalysisDependencies): Date {
  return new Date(dependencies.now().getTime() + ANALYSIS_EXECUTION_LEASE_MS)
}

type ClaimResult =
  | { outcome: 'claimed' }
  | { outcome: 'terminal_success'; status: string }

const ANALYSIS_TERMINAL_SUCCESS_STATUSES = new Set<string>([
  VIRAL_REPLICATION_STATUS.REVIEW_READY,
  VIRAL_REPLICATION_STATUS.GENERATING,
  VIRAL_REPLICATION_STATUS.COMPLETED,
])

async function clearViralAnalysisResumeMarker(job: Job<TaskJobData>): Promise<void> {
  if (!job.data.viralAnalysisResume || typeof job.updateData !== 'function') return
  const nextData = { ...job.data }
  delete nextData.viralAnalysisResume
  await job.updateData(nextData)
}

async function yieldActiveSameTaskExecution(input: {
  dependencies: ViralReplicationAnalysisDependencies
  job: Job<TaskJobData>
  token: string
  expiresAt: Date
}): Promise<never> {
  if (typeof input.job.moveToDelayed !== 'function'
    || typeof input.job.updateData !== 'function'
    || !input.job.token) {
    throw new Error('VIRAL_ANALYSIS_DELAY_UNAVAILABLE')
  }
  const nowMs = input.dependencies.now().getTime()
  const retryAt = Math.max(
    nowMs + 1_000,
    Math.min(input.expiresAt.getTime(), nowMs + 5_000),
  )
  const previousData = input.job.data
  await input.job.updateData({
    ...previousData,
    viralAnalysisResume: {
      version: 1,
      taskId: previousData.taskId,
      replicationId: previousData.targetId,
      observedExecutionToken: input.token,
      retryAt,
    },
  })
  await input.dependencies.touchTaskHeartbeat(previousData.taskId)
  try {
    await input.job.moveToDelayed(retryAt, input.job.token)
  } catch (error: unknown) {
    await input.job.updateData(previousData)
    throw error
  }
  throw new DelayedError()
}

async function claimExecution(input: {
  dependencies: ViralReplicationAnalysisDependencies
  job: Job<TaskJobData>
  sourceVideoMediaId: string
  model: string
  token: string
}): Promise<ClaimResult> {
  const now = input.dependencies.now()
  const claimed = await input.dependencies.prisma.viralReplication.updateMany({
    where: {
      id: input.job.data.targetId,
      userId: input.job.data.userId,
      status: VIRAL_REPLICATION_STATUS.ANALYZING,
      sourceVideoMediaId: input.sourceVideoMediaId,
      analysisModelSnapshot: input.model,
      OR: [
        {
          analysisExecutionTaskId: null,
          analysisExecutionToken: null,
        },
        { analysisExecutionExpiresAt: { lte: now } },
      ],
    },
    data: {
      analysisExecutionTaskId: input.job.data.taskId,
      analysisExecutionToken: input.token,
      analysisExecutionExpiresAt: new Date(now.getTime() + ANALYSIS_EXECUTION_LEASE_MS),
    },
  })
  if (claimed.count === 1) {
    await clearViralAnalysisResumeMarker(input.job)
    return { outcome: 'claimed' }
  }

  const current = await input.dependencies.prisma.viralReplication.findFirst({
    where: {
      id: input.job.data.targetId,
      userId: input.job.data.userId,
    },
    select: {
      id: true,
      status: true,
      sourceVideoMediaId: true,
      analysisModelSnapshot: true,
      analysisExecutionTaskId: true,
      analysisExecutionToken: true,
      analysisExecutionExpiresAt: true,
    },
  })
  if (!current
    || current.sourceVideoMediaId !== input.sourceVideoMediaId
    || current.analysisModelSnapshot !== input.model) {
    throw new ViralAnalysisSupersededError('Viral analysis immutable input was superseded')
  }
  if (current.status === VIRAL_REPLICATION_STATUS.FAILED) {
    throw new Error('Viral analysis domain execution failed')
  }
  const sameTask = current.analysisExecutionTaskId === input.job.data.taskId
  if (sameTask && ANALYSIS_TERMINAL_SUCCESS_STATUSES.has(current.status)) {
    await clearViralAnalysisResumeMarker(input.job)
    return { outcome: 'terminal_success', status: current.status }
  }
  if (current.status === VIRAL_REPLICATION_STATUS.ANALYZING
    && sameTask
    && current.analysisExecutionToken
    && current.analysisExecutionExpiresAt
    && current.analysisExecutionExpiresAt.getTime() > now.getTime()) {
    return await yieldActiveSameTaskExecution({
      dependencies: input.dependencies,
      job: input.job,
      token: current.analysisExecutionToken,
      expiresAt: current.analysisExecutionExpiresAt,
    })
  }
  throw new ViralAnalysisSupersededError()
}

async function extendExecutionLease(
  tx: Pick<AnalysisTransaction, 'viralReplication'>,
  dependencies: ViralReplicationAnalysisDependencies,
  execution: Parameters<typeof executionWhere>[0],
): Promise<void> {
  const extended = await tx.viralReplication.updateMany({
    where: executionWhere(execution),
    data: { analysisExecutionExpiresAt: nextLeaseExpiry(dependencies) },
  })
  if (extended.count !== 1) throw new ViralAnalysisSupersededError()
}

async function markFailed(
  dependencies: ViralReplicationAnalysisDependencies,
  execution: Parameters<typeof executionWhere>[0],
  error: unknown,
): Promise<void> {
  try {
    await dependencies.prisma.viralReplication.updateMany({
      where: executionWhere(execution),
      data: {
        status: VIRAL_REPLICATION_STATUS.FAILED,
        errorMessage: error instanceof ViralAudioTranscriptionError
          ? VIRAL_AUDIO_TRANSCRIPTION_FAILED
          : VIRAL_ANALYSIS_FAILED,
        analysisExecutionTaskId: null,
        analysisExecutionToken: null,
        analysisExecutionExpiresAt: null,
      },
    })
  } catch (error: unknown) {
    dependencies.warn('Failed to mark the owned viral analysis execution as failed', error)
  }
}

async function executionIsCurrent(
  dependencies: ViralReplicationAnalysisDependencies,
  execution: Parameters<typeof executionWhere>[0],
): Promise<boolean> {
  return Boolean(await dependencies.prisma.viralReplication.findFirst({
    where: executionWhere(execution),
    select: { id: true },
  }))
}

function frameStorageKey(replicationId: string, shotIndex: number): string {
  return `viral-replications/${replicationId}/frames/${String(shotIndex).padStart(3, '0')}.jpg`
}

function assertFrameSize(bytes: Buffer): void {
  if (bytes.length <= 0 || bytes.length > MAX_FRAME_JPEG_BYTES) {
    throw new Error(`Viral analysis JPEG must be between 1 and ${MAX_FRAME_JPEG_BYTES} bytes`)
  }
}

async function persistFrame(input: {
  dependencies: ViralReplicationAnalysisDependencies
  execution: Parameters<typeof executionWhere>[0]
  replicationId: string
  shot: PreprocessedViralShot
}): Promise<void> {
  const compositeWhere = {
    replicationId_shotIndex: {
      replicationId: input.replicationId,
      shotIndex: input.shot.shotIndex,
    },
  }
  const existing = await input.dependencies.prisma.viralReplicationFrame.findUnique({
    where: compositeWhere,
    include: { media: { select: { storageKey: true } } },
  })
  if (existing) {
    if (
      existing.timestampMs !== input.shot.representativeMs
      || existing.startMs !== input.shot.startMs
      || existing.endMs !== input.shot.endMs
    ) {
      throw new Error(`Persisted viral frame ${input.shot.shotIndex} has a mismatched timeline`)
    }
    await extendExecutionLease(input.dependencies.prisma, input.dependencies, input.execution)
    return
  }

  const requestedStorageKey = frameStorageKey(input.replicationId, input.shot.shotIndex)
  await extendExecutionLease(input.dependencies.prisma, input.dependencies, input.execution)
  const existingMedia = await input.dependencies.prisma.mediaObject.findUnique({
    where: { storageKey: requestedStorageKey },
    select: { id: true },
  })
  if (existingMedia) {
    await input.dependencies.prisma.$transaction(async (tx) => {
      await extendExecutionLease(tx, input.dependencies, input.execution)
      await tx.viralReplicationFrame.upsert({
        where: compositeWhere,
        create: {
          replicationId: input.replicationId,
          mediaId: existingMedia.id,
          shotIndex: input.shot.shotIndex,
          timestampMs: input.shot.representativeMs,
          startMs: input.shot.startMs,
          endMs: input.shot.endMs,
        },
        update: {
          mediaId: existingMedia.id,
          timestampMs: input.shot.representativeMs,
          startMs: input.shot.startMs,
          endMs: input.shot.endMs,
        },
      })
    })
    return
  }
  const bytes = await input.dependencies.readFrame(input.shot.framePath)
  assertFrameSize(bytes)
  const storageKey = await input.dependencies.uploadObject(bytes, requestedStorageKey, 1, 'image/jpeg')
  try {
    await input.dependencies.prisma.$transaction(async (tx) => {
      await extendExecutionLease(tx, input.dependencies, input.execution)
      const media = await tx.mediaObject.upsert({
        where: { storageKey },
        create: {
          publicId: stablePublicIdFromStorageKey(storageKey),
          storageKey,
          mimeType: 'image/jpeg',
          sizeBytes: BigInt(bytes.length),
        },
        update: {
          mimeType: 'image/jpeg',
          sizeBytes: BigInt(bytes.length),
        },
        select: { id: true },
      })
      await tx.viralReplicationFrame.upsert({
        where: compositeWhere,
        create: {
          replicationId: input.replicationId,
          mediaId: media.id,
          shotIndex: input.shot.shotIndex,
          timestampMs: input.shot.representativeMs,
          startMs: input.shot.startMs,
          endMs: input.shot.endMs,
        },
        update: {
          mediaId: media.id,
          timestampMs: input.shot.representativeMs,
          startMs: input.shot.startMs,
          endMs: input.shot.endMs,
        },
      })
    })
  } catch (error: unknown) {
    const referenced = await input.dependencies.prisma.viralReplicationFrame.findUnique({
      where: compositeWhere,
      select: { id: true },
    }).catch(() => null)
    const mayDelete = !referenced && await executionIsCurrent(input.dependencies, input.execution).catch(() => false)
    if (mayDelete) {
      try {
        await input.dependencies.deleteObject(storageKey)
      } catch (deleteError: unknown) {
        input.dependencies.warn('Failed to compensate an unreferenced viral frame object', deleteError)
      }
    }
    throw error
  }
}

function videoMetadataForPrompt(metadata: Awaited<ReturnType<typeof preprocessViralVideo>>['metadata']) {
  return {
    durationMs: metadata.durationMs,
    width: metadata.width,
    height: metadata.height,
    formatName: metadata.formatName,
    videoStreamIndex: metadata.videoStreamIndex,
  }
}

function supportsInlineAudioTranscription(model: string): boolean {
  const parsed = parseModelKeyStrict(model)
  if (!parsed) return false
  const providerKey = getProviderKey(parsed.provider).toLowerCase()
  return providerKey === 'google' || providerKey === 'gemini-compatible'
}

function applyTranscriptToShots<T extends {
  startMs: number
  endMs: number
  subtitleSummary: string | null
}>(shots: T[], transcriptText: string | null): T[] {
  const cues = parseViralAudioCues(transcriptText)
  for (const shot of shots) {
    const timelineText = audioTextForRange(cues, shot.startMs, shot.endMs)
    if (timelineText !== null) shot.subtitleSummary = timelineText
  }
  return shots
}

function preprocessedAudioSegments(
  preprocessed: Awaited<ReturnType<typeof preprocessViralVideo>>,
): Array<{ startMs: number; endMs: number; audioPath: string }> {
  if (
    Array.isArray(preprocessed.analysisAudioSegments)
    && preprocessed.analysisAudioSegments.length > 0
  ) {
    return preprocessed.analysisAudioSegments
  }
  if (preprocessed.analysisAudioPath) {
    return [{
      startMs: 0,
      endMs: preprocessed.metadata.durationMs,
      audioPath: preprocessed.analysisAudioPath,
    }]
  }
  return []
}

function completionStoppedEarly(completion: VisionCompletion): boolean {
  return completion.choices.some((choice) => choice.finish_reason === 'length')
}

function transcriptContextForShots(
  transcriptText: string | null,
  shots: Array<Pick<PreprocessedViralShot, 'startMs' | 'endMs'>>,
): string | null {
  const firstShot = shots[0]
  const lastShot = shots.at(-1)
  if (!firstShot || !lastShot) return null
  const cues = parseViralAudioCues(transcriptText).filter(
    (cue) => cue.startMs < lastShot.endMs && cue.endMs > firstShot.startMs,
  )
  return cues.length > 0 ? JSON.stringify({ cues }) : null
}

function selectShotsForAdaptiveReview(
  batchResults: ViralShotAnalysisBatch[],
): ViralShotAnalysisBatch['shots'] {
  return batchResults
    .flatMap((batch) => batch.shots)
    .filter((shot) =>
      shot.needsVisualReview
      || shot.analysisConfidence < VIRAL_ADAPTIVE_REVIEW_CONFIDENCE_THRESHOLD
      || (shot.subtitleSummary !== null && shot.speaker === null),
    )
    .sort((left, right) => {
      if (left.needsVisualReview !== right.needsVisualReview) {
        return left.needsVisualReview ? -1 : 1
      }
      return left.analysisConfidence - right.analysisConfidence || left.shotIndex - right.shotIndex
    })
    .slice(0, VIRAL_MAX_ADAPTIVE_REVIEW_SHOTS)
}

function replaceReviewedShots(
  batchResults: ViralShotAnalysisBatch[],
  reviewedShots: ViralShotAnalysisBatch['shots'],
): void {
  const replacements = new Map(reviewedShots.map((shot) => [shot.shotIndex, shot]))
  for (const batch of batchResults) {
    batch.shots = batch.shots.map((shot) => replacements.get(shot.shotIndex) ?? shot)
  }
}

function framesForReviewShot(
  shot: PreprocessedViralShot,
  supplementalFrames: ViralReviewFrame[],
): Array<{ timestampMs: number; framePath: string }> {
  return [
    { timestampMs: shot.representativeMs, framePath: shot.framePath },
    ...supplementalFrames
      .filter((frame) => frame.shotIndex === shot.shotIndex)
      .map((frame) => ({ timestampMs: frame.timestampMs, framePath: frame.framePath })),
  ].sort((left, right) => left.timestampMs - right.timestampMs)
}

function assertAggregatedTimeline(
  report: ViralAnalysisReportV1,
  batchResults: ViralShotAnalysisBatch[],
): void {
  const trustedShots = batchResults.flatMap((batch) => batch.shots)
  if (report.shots.length !== trustedShots.length) {
    throw new Error('Aggregated viral report shot count does not match analyzed timeline')
  }
  report.shots.forEach((shot, index) => {
    const trusted = trustedShots[index]
    if (
      !trusted
      || shot.shotIndex !== trusted.shotIndex
      || shot.startMs !== trusted.startMs
      || shot.endMs !== trusted.endMs
    ) {
      throw new Error(`Aggregated viral report shot ${index} does not match analyzed timeline`)
    }
  })
}

export function createViralReplicationAnalysisHandler(
  dependencies: ViralReplicationAnalysisDependencies,
) {
  return async function viralReplicationAnalysisHandler(job: Job<TaskJobData>) {
    let tempDirectory: string | null = null
    let execution: Parameters<typeof executionWhere>[0] | null = null
    try {
      if (job.data.targetType !== 'ViralReplication') {
        throw new Error('Viral analysis task target type is invalid')
      }
      const payload = (job.data.payload || {}) as Record<string, unknown>
      const sourceVideoMediaId = requirePayloadString(payload, 'sourceVideoMediaId')
      const model = requirePayloadString(payload, 'analysisModelSnapshot')
      const token = dependencies.createExecutionToken()
      execution = { job, token, sourceVideoMediaId, model }
      const claim = await claimExecution({ dependencies, job, sourceVideoMediaId, model, token })
      if (claim.outcome === 'terminal_success') {
        return {
          replicationId: job.data.targetId,
          reconciled: true,
          status: claim.status,
        }
      }

      const replication = await dependencies.prisma.viralReplication.findFirst({
        where: executionWhere(execution),
        select: {
          id: true,
          userId: true,
          projectId: true,
          brief: true,
          status: true,
          sourceVideoMediaId: true,
          analysisModelSnapshot: true,
          analysisExecutionTaskId: true,
          analysisExecutionToken: true,
          analysisExecutionExpiresAt: true,
          sourceVideoMedia: { select: { id: true, storageKey: true } },
        },
      })
      if (!replication?.sourceVideoMedia || replication.sourceVideoMedia.id !== sourceVideoMediaId) {
        throw new ViralAnalysisSupersededError('Claimed viral analysis source video is unavailable')
      }

      tempDirectory = await dependencies.makeTempDirectory()
      const sourcePath = path.join(tempDirectory, 'source-video')
      const outputDirectory = path.join(tempDirectory, 'frames')
      await dependencies.reportProgress(job, 10, {
        stage: 'viral_preprocess', stageLabel: '预处理参考视频', displayMode: 'detail',
      })
      const sourceStream = await dependencies.getObjectStream(replication.sourceVideoMedia.storageKey)
      await pipeline(sourceStream as Readable, createWriteStream(sourcePath, { flags: 'wx' }))
      const preprocessed = await dependencies.preprocess({ sourcePath, outputDirectory })
      let transcriptText = preprocessed.transcriptText
      const audioSegments = preprocessedAudioSegments(preprocessed)
      if (audioSegments.length > 0) {
        if (!supportsInlineAudioTranscription(model)) {
          throw new ViralAudioTranscriptionError()
        }
        await dependencies.reportProgress(job, 38, {
          stage: 'viral_audio_transcription',
          stageLabel: '识别原声音频内容',
          displayMode: 'detail',
        })
        try {
          const supplementalTranscripts: Array<string | null> = []
          for (const segment of audioSegments) {
            const audioBytes = await fs.readFile(segment.audioPath)
            const segmentDurationMs = segment.endMs - segment.startMs
            const transcription = await dependencies.runVision({
              userId: job.data.userId,
              model,
              prompt: buildViralAudioTranscriptionPrompt({
                locale: job.data.locale,
                durationMs: segmentDurationMs,
              }),
              imageUrls: [`data:audio/mpeg;base64,${audioBytes.toString('base64')}`],
              options: {
                temperature: 0,
                projectId: replication.projectId || undefined,
                action: 'viral_audio_transcription',
              },
            })
            if (completionStoppedEarly(transcription)) {
              throw new Error('Audio transcription response stopped before the segment completed')
            }
            supplementalTranscripts.push(parseViralAudioTranscription(
              getCompletionContent(transcription),
              segmentDurationMs,
              segment.startMs,
            ))
          }
          transcriptText = mergeViralAudioTranscripts({
            primaryTranscript: transcriptText,
            supplementalTranscripts,
            durationMs: preprocessed.metadata.durationMs,
          })
        } catch (error: unknown) {
          dependencies.warn('Failed to transcribe viral source audio', error)
          throw new ViralAudioTranscriptionError(
            VIRAL_AUDIO_TRANSCRIPTION_FAILED,
            { cause: error },
          )
        }
      }
      await dependencies.reportProgress(job, 40, {
        stage: 'viral_preprocess', stageLabel: '参考视频预处理完成', displayMode: 'detail',
        frameCount: preprocessed.shots.length,
      })

      for (const shot of preprocessed.shots) {
        await persistFrame({ dependencies, execution, replicationId: replication.id, shot })
      }

      const frameBatches = buildAnalysisBatches(preprocessed.shots)
      const batchResults: ViralShotAnalysisBatch[] = []
      for (const [batchIndex, shots] of frameBatches.entries()) {
        await extendExecutionLease(dependencies.prisma, dependencies, execution)
        await dependencies.reportProgress(
          job,
          45 + Math.floor((batchIndex / Math.max(frameBatches.length, 1)) * 35),
          {
            stage: 'viral_vision_analysis', stageLabel: '分析镜头语言', displayMode: 'detail',
            batchIndex: batchIndex + 1, batchCount: frameBatches.length,
          },
        )
        const imageUrls = await Promise.all(shots.map(async (shot) => {
          const bytes = await dependencies.readFrame(shot.framePath)
          assertFrameSize(bytes)
          return `data:image/jpeg;base64,${bytes.toString('base64')}`
        }))
        const completion = await dependencies.runVision({
          userId: job.data.userId,
          model,
          prompt: buildViralShotAnalysisPrompt({
            locale: job.data.locale,
            brief: replication.brief,
            videoMetadata: videoMetadataForPrompt(preprocessed.metadata),
            shots,
            previousShotContext: batchResults.at(-1)?.shots.at(-1) ?? null,
            subtitleContext: transcriptContextForShots(transcriptText, shots),
          }),
          imageUrls,
          options: {
            temperature: 0.1,
            projectId: replication.projectId || undefined,
            action: 'viral_shot_analysis',
          },
        })
        const batch = parseViralShotAnalysisBatch(getCompletionContent(completion), shots)
        applyTranscriptToShots(batch.shots, transcriptText)
        batchResults.push(batch)
      }

      const adaptiveCandidates = selectShotsForAdaptiveReview(batchResults)
      if (adaptiveCandidates.length > 0) {
        await dependencies.reportProgress(job, 81, {
          stage: 'viral_plot_review',
          stageLabel: '复核低置信度剧情镜头',
          displayMode: 'detail',
          reviewShotCount: adaptiveCandidates.length,
        })
        await extendExecutionLease(dependencies.prisma, dependencies, execution)
        const candidateShots = adaptiveCandidates.map((candidate) => {
          const shot = preprocessed.shots[candidate.shotIndex]
          if (!shot || shot.shotIndex !== candidate.shotIndex) {
            throw new Error(`Adaptive viral review shot ${candidate.shotIndex} is missing`)
          }
          return shot
        })
        const supplementalFrames = await (
          dependencies.extractReviewFrames ?? extractViralReviewFrames
        )({
          sourcePath,
          outputDirectory,
          videoStreamIndex: preprocessed.metadata.videoStreamIndex,
          shots: candidateShots,
        })
        const reviewedShots: ViralShotAnalysisBatch['shots'] = []
        for (
          let reviewOffset = 0;
          reviewOffset < candidateShots.length;
          reviewOffset += VIRAL_ADAPTIVE_REVIEW_BATCH_SIZE
        ) {
          await extendExecutionLease(dependencies.prisma, dependencies, execution)
          const shotBatch = candidateShots.slice(
            reviewOffset,
            reviewOffset + VIRAL_ADAPTIVE_REVIEW_BATCH_SIZE,
          )
          const reviewInputs = shotBatch.map((shot) => {
            const initialAnalysis = adaptiveCandidates.find(
              (candidate) => candidate.shotIndex === shot.shotIndex,
            )
            if (!initialAnalysis) {
              throw new Error(`Adaptive viral review analysis ${shot.shotIndex} is missing`)
            }
            const frames = framesForReviewShot(shot, supplementalFrames)
            return {
              shot,
              frames,
              initialAnalysis,
            }
          })
          const imageUrls = await Promise.all(reviewInputs.flatMap(({ frames }) =>
            frames.map(async (frame) => {
              const bytes = await dependencies.readFrame(frame.framePath)
              assertFrameSize(bytes)
              return `data:image/jpeg;base64,${bytes.toString('base64')}`
            }),
          ))
          const completion = await dependencies.runVision({
            userId: job.data.userId,
            model,
            prompt: buildViralShotReviewPrompt({
              locale: job.data.locale,
              videoMetadata: videoMetadataForPrompt(preprocessed.metadata),
              shots: reviewInputs.map(({ shot, frames, initialAnalysis }) => ({
                shotIndex: shot.shotIndex,
                startMs: shot.startMs,
                endMs: shot.endMs,
                frameTimestampsMs: frames.map((frame) => frame.timestampMs),
                transcriptText: audioTextForRange(
                  parseViralAudioCues(transcriptText),
                  shot.startMs,
                  shot.endMs,
                ),
                initialAnalysis,
              })),
            }),
            imageUrls,
            options: {
              temperature: 0,
              projectId: replication.projectId || undefined,
              action: 'viral_shot_review',
            },
          })
          const reviewed = parseViralShotAnalysisBatch(
            getCompletionContent(completion),
            shotBatch,
          )
          applyTranscriptToShots(reviewed.shots, transcriptText)
          reviewedShots.push(...reviewed.shots)
        }
        replaceReviewedShots(batchResults, reviewedShots)
      }

      await dependencies.reportProgress(job, 85, {
        stage: 'viral_report_aggregation', stageLabel: '汇总视频分析', displayMode: 'detail',
      })
      await extendExecutionLease(dependencies.prisma, dependencies, execution)
      const aggregation = await dependencies.runText({
        userId: job.data.userId,
        model,
        messages: [{
          role: 'user',
          content: buildViralReportAggregationPrompt({
            locale: job.data.locale,
            brief: replication.brief,
            durationMs: preprocessed.metadata.durationMs,
            batchResults,
          }),
        }],
        options: {
          temperature: 0.1,
          projectId: replication.projectId || undefined,
          action: 'viral_report_aggregation',
        },
      })
      const report = parseViralAnalysisReport(
        safeParseJson(getCompletionContent(aggregation)),
        preprocessed.metadata.durationMs,
      )
      if (!report.sourceStory) {
        throw new Error('Aggregated viral report is missing factual source story analysis')
      }
      assertAggregatedTimeline(report, batchResults)
      report.shots = batchResults.flatMap((batch) => batch.shots)
      applyTranscriptToShots(report.shots, transcriptText)
      const updated = await dependencies.prisma.viralReplication.updateMany({
        where: executionWhere(execution),
        data: {
          reportJson: report,
          transcriptText,
          durationMs: preprocessed.metadata.durationMs,
          status: VIRAL_REPLICATION_STATUS.REVIEW_READY,
          analysisExecutionToken: null,
          analysisExecutionExpiresAt: null,
        },
      })
      if (updated.count !== 1) throw new ViralAnalysisSupersededError()
      await dependencies.reportProgress(job, 96, {
        stage: 'viral_analysis_complete', stageLabel: '参考视频分析完成', displayMode: 'detail',
      })
      return { replicationId: replication.id, frameCount: preprocessed.shots.length }
    } catch (error: unknown) {
      const delayed = error instanceof DelayedError
        || (error instanceof Error && error.name === 'DelayedError')
      if (execution && !delayed && !(error instanceof ViralAnalysisSupersededError)) {
        await markFailed(dependencies, execution, error)
      }
      throw error
    } finally {
      if (tempDirectory) {
        try {
          await dependencies.removeTempDirectory(tempDirectory)
        } catch (cleanupError: unknown) {
          dependencies.warn('Failed to clean viral analysis temporary directory', cleanupError)
        }
      }
    }
  }
}

const defaultHandler = createViralReplicationAnalysisHandler(defaultDependencies)

export async function handleViralReplicationAnalysisTask(job: Job<TaskJobData>) {
  return await defaultHandler(job)
}
