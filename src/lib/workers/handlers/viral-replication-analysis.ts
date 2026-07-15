import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import type { Job } from 'bullmq'

import { getCompletionContent } from '@/lib/llm/completion-parts'
import { safeParseJson } from '@/lib/json-repair'
import { stablePublicIdFromStorageKey } from '@/lib/media/hash'
import {
  runModelGatewayTextCompletion,
  runModelGatewayVisionCompletion,
} from '@/lib/model-gateway/llm'
import { prisma } from '@/lib/prisma'
import { getObjectStream, uploadObject } from '@/lib/storage'
import type { TaskJobData } from '@/lib/task/types'
import { VIRAL_REPLICATION_STATUS } from '@/lib/viral-replication/constants'
import { parseViralAnalysisReport } from '@/lib/viral-replication/contracts'
import { buildAnalysisBatches, preprocessViralVideo } from '@/lib/viral-replication/preprocess'
import {
  buildViralReportAggregationPrompt,
  buildViralShotAnalysisPrompt,
  parseViralShotAnalysisBatch,
  type ViralShotAnalysisBatch,
} from '@/lib/viral-replication/prompts'
import { reportTaskProgress } from '@/lib/workers/shared'

type ReplicationRecord = {
  id: string
  userId: string
  projectId: string | null
  brief: string
  status: string
  sourceVideoMediaId: string | null
  analysisModelSnapshot: string | null
  sourceVideoMedia: { id: string; storageKey: string } | null
}

type AnalysisPrisma = {
  viralReplication: {
    findFirst(args: Record<string, unknown>): Promise<ReplicationRecord | null>
    updateMany(args: Record<string, unknown>): Promise<{ count: number }>
  }
  mediaObject: {
    create(args: Record<string, unknown>): Promise<{ id: string }>
  }
  viralReplicationFrame: {
    create(args: Record<string, unknown>): Promise<unknown>
  }
}

type VisionCompletion = Awaited<ReturnType<typeof runModelGatewayVisionCompletion>>
type TextCompletion = Awaited<ReturnType<typeof runModelGatewayTextCompletion>>

export type ViralReplicationAnalysisDependencies = {
  prisma: AnalysisPrisma
  getObjectStream(storageKey: string): Promise<NodeJS.ReadableStream>
  preprocess: typeof preprocessViralVideo
  uploadObject(body: Buffer, key: string, maxRetries?: number, contentType?: string): Promise<string>
  runVision(input: Parameters<typeof runModelGatewayVisionCompletion>[0]): Promise<VisionCompletion>
  runText(input: Parameters<typeof runModelGatewayTextCompletion>[0]): Promise<TextCompletion>
  reportProgress(
    job: Job<TaskJobData>,
    progress: number,
    payload?: Record<string, unknown>,
  ): Promise<unknown>
  makeTempDirectory(): Promise<string>
  removeTempDirectory(directory: string): Promise<void>
}

const defaultDependencies: ViralReplicationAnalysisDependencies = {
  prisma: prisma as unknown as AnalysisPrisma,
  getObjectStream,
  preprocess: preprocessViralVideo,
  uploadObject,
  runVision: runModelGatewayVisionCompletion,
  runText: runModelGatewayTextCompletion,
  reportProgress: reportTaskProgress,
  makeTempDirectory: async () => await fs.mkdtemp(path.join(os.tmpdir(), 'viral-analysis-')),
  removeTempDirectory: async (directory) => await fs.rm(directory, { recursive: true, force: true }),
}

function requirePayloadString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Viral analysis payload is missing ${key}`)
  }
  return value.trim()
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

async function markFailed(
  dependencies: ViralReplicationAnalysisDependencies,
  job: Job<TaskJobData>,
): Promise<void> {
  try {
    await dependencies.prisma.viralReplication.updateMany({
      where: { id: job.data.targetId, userId: job.data.userId },
      data: { status: VIRAL_REPLICATION_STATUS.FAILED },
    })
  } catch {
    // Preserve the analysis error; task lifecycle records the primary failure.
  }
}

export function createViralReplicationAnalysisHandler(
  dependencies: ViralReplicationAnalysisDependencies,
) {
  return async function viralReplicationAnalysisHandler(job: Job<TaskJobData>) {
    let tempDirectory: string | null = null
    try {
      if (job.data.targetType !== 'ViralReplication') {
        throw new Error('Viral analysis task target type is invalid')
      }
      const payload = (job.data.payload || {}) as Record<string, unknown>
      const payloadMediaId = requirePayloadString(payload, 'sourceVideoMediaId')
      const payloadModel = requirePayloadString(payload, 'analysisModelSnapshot')
      const replication = await dependencies.prisma.viralReplication.findFirst({
        where: { id: job.data.targetId, userId: job.data.userId },
        select: {
          id: true,
          userId: true,
          projectId: true,
          brief: true,
          status: true,
          sourceVideoMediaId: true,
          analysisModelSnapshot: true,
          sourceVideoMedia: { select: { id: true, storageKey: true } },
        },
      })
      if (!replication) throw new Error('Viral replication not found for task owner')
      if (
        !replication.sourceVideoMedia
        || replication.sourceVideoMediaId !== payloadMediaId
        || replication.sourceVideoMedia.id !== payloadMediaId
      ) {
        throw new Error('Viral analysis source video does not match the task payload')
      }
      if (
        !replication.analysisModelSnapshot
        || replication.analysisModelSnapshot !== payloadModel
      ) {
        throw new Error('Viral analysis model snapshot does not match the task payload')
      }

      const model = replication.analysisModelSnapshot
      tempDirectory = await dependencies.makeTempDirectory()
      const sourcePath = path.join(tempDirectory, 'source-video')
      const outputDirectory = path.join(tempDirectory, 'frames')

      await dependencies.reportProgress(job, 10, {
        stage: 'viral_preprocess',
        stageLabel: '预处理参考视频',
        displayMode: 'detail',
      })
      const sourceStream = await dependencies.getObjectStream(replication.sourceVideoMedia.storageKey)
      await pipeline(sourceStream as Readable, createWriteStream(sourcePath, { flags: 'wx' }))
      const preprocessed = await dependencies.preprocess({ sourcePath, outputDirectory })
      await dependencies.reportProgress(job, 35, {
        stage: 'viral_preprocess',
        stageLabel: '参考视频预处理完成',
        displayMode: 'detail',
        frameCount: preprocessed.shots.length,
      })

      const persistedFrames: Array<{ shot: (typeof preprocessed.shots)[number]; bytes: Buffer }> = []
      for (const shot of preprocessed.shots) {
        const bytes = await fs.readFile(shot.framePath)
        const requestedKey = `viral-replications/${replication.id}/frames/${String(shot.shotIndex).padStart(3, '0')}-${randomUUID()}.jpg`
        const storageKey = await dependencies.uploadObject(bytes, requestedKey, 1, 'image/jpeg')
        const media = await dependencies.prisma.mediaObject.create({
          data: {
            publicId: stablePublicIdFromStorageKey(storageKey),
            storageKey,
            mimeType: 'image/jpeg',
            sizeBytes: BigInt(bytes.length),
          },
          select: { id: true },
        })
        await dependencies.prisma.viralReplicationFrame.create({
          data: {
            replicationId: replication.id,
            mediaId: media.id,
            shotIndex: shot.shotIndex,
            timestampMs: shot.representativeMs,
            startMs: shot.startMs,
            endMs: shot.endMs,
          },
        })
        persistedFrames.push({ shot, bytes })
      }

      const frameBatches = buildAnalysisBatches(persistedFrames)
      const batchResults: ViralShotAnalysisBatch[] = []
      for (const [batchIndex, batch] of frameBatches.entries()) {
        await dependencies.reportProgress(
          job,
          45 + Math.floor((batchIndex / Math.max(frameBatches.length, 1)) * 35),
          {
            stage: 'viral_vision_analysis',
            stageLabel: '分析镜头语言',
            displayMode: 'detail',
            batchIndex: batchIndex + 1,
            batchCount: frameBatches.length,
          },
        )
        const shots = batch.map(({ shot }) => shot)
        const completion = await dependencies.runVision({
          userId: job.data.userId,
          model,
          prompt: buildViralShotAnalysisPrompt({
            locale: job.data.locale,
            brief: replication.brief,
            videoMetadata: videoMetadataForPrompt(preprocessed.metadata),
            shots,
            subtitleContext: preprocessed.transcriptText,
          }),
          imageUrls: batch.map(({ bytes }) => `data:image/jpeg;base64,${bytes.toString('base64')}`),
          options: {
            temperature: 0.1,
            projectId: replication.projectId || undefined,
            action: 'viral_shot_analysis',
          },
        })
        batchResults.push(parseViralShotAnalysisBatch(getCompletionContent(completion), shots))
      }

      await dependencies.reportProgress(job, 85, {
        stage: 'viral_report_aggregation',
        stageLabel: '汇总视频分析',
        displayMode: 'detail',
      })
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
      const updated = await dependencies.prisma.viralReplication.updateMany({
        where: { id: replication.id, userId: job.data.userId },
        data: {
          reportJson: report,
          transcriptText: preprocessed.transcriptText,
          durationMs: preprocessed.metadata.durationMs,
          status: VIRAL_REPLICATION_STATUS.REVIEW_READY,
        },
      })
      if (updated.count !== 1) throw new Error('Viral replication disappeared before analysis completion')
      await dependencies.reportProgress(job, 96, {
        stage: 'viral_analysis_complete',
        stageLabel: '参考视频分析完成',
        displayMode: 'detail',
      })
      return { replicationId: replication.id, frameCount: persistedFrames.length }
    } catch (error: unknown) {
      await markFailed(dependencies, job)
      throw error
    } finally {
      if (tempDirectory) await dependencies.removeTempDirectory(tempDirectory)
    }
  }
}

const defaultHandler = createViralReplicationAnalysisHandler(defaultDependencies)

export async function handleViralReplicationAnalysisTask(job: Job<TaskJobData>) {
  return await defaultHandler(job)
}
