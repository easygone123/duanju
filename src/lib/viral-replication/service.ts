import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import type { Locale } from '@/i18n/routing'
import { ApiError } from '@/lib/api-errors'
import { stablePublicIdFromStorageKey } from '@/lib/media/hash'
import { prisma } from '@/lib/prisma'
import { deleteObject, uploadObjectStream } from '@/lib/storage'
import { submitTask } from '@/lib/task/submitter'
import { TASK_TYPE } from '@/lib/task/types'
import {
  VIRAL_REPLICATION_STATUS,
  VIRAL_STORYBOARD_GENERATION_FAILED,
} from './constants'
import { FfmpegBoundaryError, probeVideo } from './ffmpeg'
import { readOwnedViralReplication } from './ownership'
import { writeRequestBodyToTempFile } from './temp-file'
import { cleanupUploadTempFile } from './temp-cleanup'
import {
  ViralUploadValidationError,
  validateViralUploadPrefix,
  validateViralVideoMetadata,
} from './upload-validation'

const BRIEF_MUTABLE_STATUSES = [
  VIRAL_REPLICATION_STATUS.UPLOADING,
  VIRAL_REPLICATION_STATUS.REVIEW_READY,
  VIRAL_REPLICATION_STATUS.FAILED,
]
const SUBMIT_FAILURE_MESSAGE = '爆款复刻分析任务提交失败，请稍后重试'
const GENERATION_SUBMIT_FAILURE_MESSAGE = '爆款复刻分镜生成任务提交失败，请稍后重试'
const DEFAULT_UPLOAD_LOCK_TTL_MS = 15 * 60 * 1_000

type UploadVideoInput = {
  id: string
  userId: string
  request: Request
  mimeType: string
  locale: Locale
  maxBytes?: number
  tempRoot?: string
  now?: Date
  lockTtlMs?: number
}

function formatTimestamp(date: Date): string {
  const part = (value: number) => String(value).padStart(2, '0')
  return `${date.getUTCFullYear()}${part(date.getUTCMonth() + 1)}${part(date.getUTCDate())}-${part(date.getUTCHours())}${part(date.getUTCMinutes())}${part(date.getUTCSeconds())}`
}

function mediaUrl(publicId: string): string {
  return `/m/${encodeURIComponent(publicId)}`
}

function serializeDetail<T extends {
  errorMessage?: string | null
  sourceVideoMedia?: { publicId: string; sizeBytes: bigint | number | null } | null
}>(replication: T) {
  const { sourceVideoMedia, errorMessage, ...rest } = replication
  return {
    ...rest,
    errorMessage: errorMessage ?? null,
    sourceVideo: sourceVideoMedia
      ? {
          ...sourceVideoMedia,
          sizeBytes: sourceVideoMedia.sizeBytes == null ? null : Number(sourceVideoMedia.sizeBytes),
          url: mediaUrl(sourceVideoMedia.publicId),
        }
      : null,
  }
}

export async function createViralReplication(input: {
  userId: string
  brief: string
  videoRatio: string
  artStyle: string
}) {
  return prisma.viralReplication.create({
    data: {
      ...input,
      status: VIRAL_REPLICATION_STATUS.UPLOADING,
    },
    select: {
      id: true, brief: true, videoRatio: true, artStyle: true, status: true, createdAt: true, updatedAt: true,
    },
  })
}

export async function getOwnedViralReplicationDetail(id: string, userId: string) {
  return serializeDetail(await readOwnedViralReplication(id, userId))
}

export async function updateViralReplicationBrief(input: { id: string; userId: string; brief: string }) {
  const result = await prisma.viralReplication.updateMany({
    where: {
      id: input.id,
      userId: input.userId,
      status: { in: BRIEF_MUTABLE_STATUSES },
    },
    data: { brief: input.brief },
  })
  if (result.count !== 1) {
    await readOwnedViralReplication(input.id, input.userId)
    throw new ApiError('INVALID_PARAMS', { code: 'VIRAL_REPLICATION_BRIEF_LOCKED', field: 'brief' })
  }
  return getOwnedViralReplicationDetail(input.id, input.userId)
}

function requireDraftTargets(replication: Awaited<ReturnType<typeof readOwnedViralReplication>>) {
  const projectId = replication.project?.id
  const episodeId = replication.episode?.id
  const sourceVideoMediaId = replication.sourceVideoMedia?.id
  if (!projectId || !episodeId || !sourceVideoMediaId) {
    throw new ApiError('INVALID_PARAMS', { code: 'VIRAL_REPLICATION_DRAFT_INCOMPLETE' })
  }
  return { projectId, episodeId, sourceVideoMediaId }
}

function shouldRetryStoryboardGeneration(replication: Awaited<ReturnType<typeof readOwnedViralReplication>>) {
  return Boolean(replication.reportJson) && (
    replication.errorMessage === VIRAL_STORYBOARD_GENERATION_FAILED
    || replication.errorMessage === GENERATION_SUBMIT_FAILURE_MESSAGE
  )
}

async function retryViralStoryboardGeneration(input: {
  id: string
  userId: string
  locale: Locale
  projectId: string
  episodeId: string
}) {
  const prepared = await prisma.$transaction(async (tx) => {
    const preference = await tx.userPreference.findUnique({ where: { userId: input.userId } })
    if (!preference?.analysisModel) {
      throw new ApiError('INVALID_PARAMS', {
        code: 'ANALYSIS_MODEL_REQUIRED',
        field: 'analysisModel',
      })
    }
    const updated = await tx.viralReplication.updateMany({
      where: {
        id: input.id,
        userId: input.userId,
        status: VIRAL_REPLICATION_STATUS.FAILED,
        projectId: input.projectId,
        episodeId: input.episodeId,
      },
      data: {
        status: VIRAL_REPLICATION_STATUS.GENERATING,
        analysisModelSnapshot: preference.analysisModel,
        errorMessage: null,
      },
    })
    if (updated.count !== 1) {
      throw new ApiError('INVALID_PARAMS', { code: 'VIRAL_RETRY_CONFLICT' })
    }
    return { analysisModelSnapshot: preference.analysisModel }
  })

  try {
    const task = await submitTask({
      userId: input.userId,
      locale: input.locale,
      projectId: input.projectId,
      episodeId: input.episodeId,
      type: TASK_TYPE.VIRAL_STORYBOARD_GENERATION,
      targetType: 'ViralReplication',
      targetId: input.id,
      dedupeKey: `viral_storyboard_generation:${input.id}`,
      maxAttempts: 1,
      payload: { analysisModelSnapshot: prepared.analysisModelSnapshot },
    })
    return { id: input.id, status: VIRAL_REPLICATION_STATUS.GENERATING, taskId: task.taskId }
  } catch {
    await prisma.viralReplication.updateMany({
      where: {
        id: input.id,
        userId: input.userId,
        status: VIRAL_REPLICATION_STATUS.GENERATING,
      },
      data: {
        status: VIRAL_REPLICATION_STATUS.FAILED,
        errorMessage: GENERATION_SUBMIT_FAILURE_MESSAGE,
      },
    })
    return { id: input.id, status: VIRAL_REPLICATION_STATUS.FAILED, taskId: null }
  }
}

export async function retryViralReplication(input: {
  id: string
  userId: string
  locale: Locale
}) {
  const replication = await readOwnedViralReplication(input.id, input.userId)
  if (replication.status !== VIRAL_REPLICATION_STATUS.FAILED) {
    throw new ApiError('INVALID_PARAMS', { code: 'VIRAL_RETRY_NOT_ALLOWED' })
  }
  const targets = requireDraftTargets(replication)
  if (shouldRetryStoryboardGeneration(replication)) {
    return retryViralStoryboardGeneration({
      ...input,
      projectId: targets.projectId,
      episodeId: targets.episodeId,
    })
  }
  const prepared = await prisma.$transaction(async (tx) => {
    const preference = await tx.userPreference.findUnique({ where: { userId: input.userId } })
    if (!preference?.analysisModel) {
      throw new ApiError('INVALID_PARAMS', {
        code: 'ANALYSIS_MODEL_REQUIRED',
        field: 'analysisModel',
      })
    }
    const updated = await tx.viralReplication.updateMany({
      where: {
        id: input.id,
        userId: input.userId,
        status: VIRAL_REPLICATION_STATUS.FAILED,
        projectId: targets.projectId,
        episodeId: targets.episodeId,
        sourceVideoMediaId: targets.sourceVideoMediaId,
      },
      data: {
        status: VIRAL_REPLICATION_STATUS.ANALYZING,
        analysisModelSnapshot: preference.analysisModel,
        analysisExecutionTaskId: null,
        analysisExecutionToken: null,
        analysisExecutionExpiresAt: null,
        transcriptText: null,
        reportJson: Prisma.DbNull,
        errorMessage: null,
        confirmedAt: null,
      },
    })
    if (updated.count !== 1) {
      throw new ApiError('INVALID_PARAMS', { code: 'VIRAL_RETRY_CONFLICT' })
    }
    await tx.viralReplicationFrame.deleteMany({ where: { replicationId: input.id } })
    return { analysisModelSnapshot: preference.analysisModel }
  })

  try {
    const task = await submitTask({
      userId: input.userId,
      locale: input.locale,
      projectId: targets.projectId,
      episodeId: targets.episodeId,
      type: TASK_TYPE.VIRAL_VIDEO_ANALYSIS,
      targetType: 'ViralReplication',
      targetId: input.id,
      dedupeKey: `viral_video_analysis:${input.id}`,
      maxAttempts: 1,
      payload: {
        sourceVideoMediaId: targets.sourceVideoMediaId,
        analysisModelSnapshot: prepared.analysisModelSnapshot,
      },
    })
    return { id: input.id, status: VIRAL_REPLICATION_STATUS.ANALYZING, taskId: task.taskId }
  } catch {
    await prisma.viralReplication.updateMany({
      where: { id: input.id, userId: input.userId, status: VIRAL_REPLICATION_STATUS.ANALYZING },
      data: { status: VIRAL_REPLICATION_STATUS.FAILED, errorMessage: SUBMIT_FAILURE_MESSAGE },
    })
    return { id: input.id, status: VIRAL_REPLICATION_STATUS.FAILED, taskId: null }
  }
}

export async function generateViralReplication(input: {
  id: string
  userId: string
  locale: Locale
  brief: string
}) {
  const replication = await readOwnedViralReplication(input.id, input.userId)
  if (replication.status !== VIRAL_REPLICATION_STATUS.REVIEW_READY || !replication.reportJson) {
    throw new ApiError('INVALID_PARAMS', { code: 'VIRAL_GENERATE_NOT_ALLOWED' })
  }
  const targets = requireDraftTargets(replication)
  const prepared = await prisma.$transaction(async (tx) => {
    const preference = await tx.userPreference.findUnique({ where: { userId: input.userId } })
    if (!preference?.analysisModel) {
      throw new ApiError('INVALID_PARAMS', {
        code: 'ANALYSIS_MODEL_REQUIRED',
        field: 'analysisModel',
      })
    }
    const updated = await tx.viralReplication.updateMany({
      where: {
        id: input.id,
        userId: input.userId,
        status: VIRAL_REPLICATION_STATUS.REVIEW_READY,
        projectId: targets.projectId,
        episodeId: targets.episodeId,
      },
      data: {
        brief: input.brief,
        status: VIRAL_REPLICATION_STATUS.GENERATING,
        analysisModelSnapshot: preference.analysisModel,
        confirmedAt: new Date(),
        errorMessage: null,
      },
    })
    if (updated.count !== 1) {
      throw new ApiError('INVALID_PARAMS', { code: 'VIRAL_GENERATE_CONFLICT' })
    }
    return { analysisModelSnapshot: preference.analysisModel }
  })

  try {
    const task = await submitTask({
      userId: input.userId,
      locale: input.locale,
      projectId: targets.projectId,
      episodeId: targets.episodeId,
      type: TASK_TYPE.VIRAL_STORYBOARD_GENERATION,
      targetType: 'ViralReplication',
      targetId: input.id,
      dedupeKey: `viral_storyboard_generation:${input.id}`,
      maxAttempts: 1,
      payload: { analysisModelSnapshot: prepared.analysisModelSnapshot },
    })
    return { id: input.id, status: VIRAL_REPLICATION_STATUS.GENERATING, taskId: task.taskId }
  } catch {
    await prisma.viralReplication.updateMany({
      where: { id: input.id, userId: input.userId, status: VIRAL_REPLICATION_STATUS.GENERATING },
      data: {
        status: VIRAL_REPLICATION_STATUS.FAILED,
        errorMessage: GENERATION_SUBMIT_FAILURE_MESSAGE,
      },
    })
    return { id: input.id, status: VIRAL_REPLICATION_STATUS.FAILED, taskId: null }
  }
}

async function releaseUploadLock(id: string, userId: string, lockToken: string): Promise<void> {
  try {
    await prisma.viralReplication.updateMany({
      where: { id, userId, status: VIRAL_REPLICATION_STATUS.UPLOADING, uploadLockToken: lockToken },
      data: { uploadLockToken: null, uploadLockExpiresAt: null },
    })
  } catch {
    // Preserve the original upload failure; a stale lock can be repaired explicitly.
  }
}

export async function uploadViralReplicationVideo(input: UploadVideoInput) {
  const replication = await readOwnedViralReplication(input.id, input.userId)
  if (replication.status !== VIRAL_REPLICATION_STATUS.UPLOADING) {
    throw new ApiError('INVALID_PARAMS', { code: 'VIRAL_UPLOAD_NOT_ALLOWED' })
  }
  const preference = await prisma.userPreference.findUnique({ where: { userId: input.userId } })
  if (!preference?.analysisModel) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'ANALYSIS_MODEL_REQUIRED',
      field: 'analysisModel',
    })
  }

  const uploadNow = input.now ?? new Date()
  const lockTtlMs = input.lockTtlMs ?? DEFAULT_UPLOAD_LOCK_TTL_MS
  const lockToken = randomUUID()
  const lockExpiresAt = new Date(uploadNow.getTime() + lockTtlMs)
  const acquired = await prisma.viralReplication.updateMany({
    where: {
      id: input.id,
      userId: input.userId,
      status: VIRAL_REPLICATION_STATUS.UPLOADING,
      projectId: null,
      sourceVideoMediaId: null,
      OR: [
        { uploadLockToken: null },
        { uploadLockExpiresAt: { lte: uploadNow } },
      ],
    },
    data: { uploadLockToken: lockToken, uploadLockExpiresAt: lockExpiresAt },
  })
  if (acquired.count !== 1) {
    throw new ApiError('INVALID_PARAMS', { code: 'VIRAL_UPLOAD_CONFLICT' })
  }

  let tempFile: Awaited<ReturnType<typeof writeRequestBodyToTempFile>> | null = null
  let compensationStorageKey: string | null = null
  let committed = false
  let primaryFailure: unknown

  try {
    try {
      tempFile = await writeRequestBodyToTempFile(input.request.body, {
        maxBytes: input.maxBytes,
        tempRoot: input.tempRoot,
        prefix: 'viral-upload',
      })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('exceeds maximum size')) {
        throw new ApiError('INVALID_PARAMS', { code: 'VIRAL_VIDEO_TOO_LARGE', field: 'video' })
      }
      if (message === 'Request body is required') {
        throw new ApiError('INVALID_PARAMS', { code: 'VIRAL_VIDEO_REQUIRED', field: 'video' })
      }
      throw error
    }

    const handle = await fs.open(tempFile.filePath, 'r')
    let prefix: Buffer
    try {
      prefix = Buffer.alloc(Math.min(64, tempFile.sizeBytes))
      await handle.read(prefix, 0, prefix.length, 0)
    } finally {
      await handle.close()
    }
    let metadata: Awaited<ReturnType<typeof probeVideo>>
    try {
      validateViralUploadPrefix(prefix, input.mimeType)
      metadata = await probeVideo(tempFile.filePath)
      validateViralVideoMetadata(metadata)
    } catch (error: unknown) {
      if (error instanceof ViralUploadValidationError) {
        throw new ApiError('INVALID_PARAMS', { code: error.code, field: 'video' })
      }
      if (
        error instanceof FfmpegBoundaryError
        && ['COMMAND_FAILED', 'FFPROBE_MALFORMED_JSON', 'FFPROBE_NO_VIDEO', 'FFPROBE_INVALID_VIDEO', 'FFPROBE_INVALID_DURATION', 'UNSUPPORTED_CONTAINER', 'UNSUPPORTED_CONTAINER_BRAND'].includes(error.code)
      ) {
        throw new ApiError('INVALID_PARAMS', { code: error.code, field: 'video' })
      }
      throw error
    }

    const normalizedMime = input.mimeType.split(';', 1)[0].trim().toLowerCase()
    const extension = normalizedMime.includes('quicktime') || normalizedMime.endsWith('/mov') ? 'mov' : 'mp4'
    const requestedStorageKey = `viral-replications/${input.id}/${randomUUID()}.${extension}`
    compensationStorageKey = requestedStorageKey
    const storageKey = await uploadObjectStream(
      () => createReadStream(tempFile!.filePath),
      requestedStorageKey,
      tempFile.sizeBytes,
      normalizedMime,
    )
    compensationStorageKey = storageKey

    const publicId = stablePublicIdFromStorageKey(storageKey)
    const created = await prisma.$transaction(async (tx) => {
      const transactionPreference = await tx.userPreference.findUnique({ where: { userId: input.userId } })
      if (!transactionPreference?.analysisModel) {
        throw new ApiError('INVALID_PARAMS', {
          code: 'ANALYSIS_MODEL_REQUIRED',
          field: 'analysisModel',
        })
      }
      const media = await tx.mediaObject.create({
        data: {
          publicId,
          storageKey,
          mimeType: normalizedMime,
          sizeBytes: BigInt(tempFile!.sizeBytes),
          width: metadata.width,
          height: metadata.height,
          durationMs: metadata.durationMs,
        },
      })
      const project = await tx.project.create({
        data: {
          name: `爆款复刻-${formatTimestamp(uploadNow)}`,
          userId: input.userId,
        },
      })
      const novelProject = await tx.novelPromotionProject.create({
        data: {
          projectId: project.id,
          analysisModel: transactionPreference.analysisModel,
          characterModel: transactionPreference.characterModel,
          locationModel: transactionPreference.locationModel,
          storyboardModel: transactionPreference.storyboardModel,
          editModel: transactionPreference.editModel,
          videoModel: transactionPreference.videoModel,
          audioModel: transactionPreference.audioModel,
          videoRatio: replication.videoRatio,
          videoResolution: transactionPreference.videoResolution,
          imageResolution: transactionPreference.imageResolution,
          artStyle: replication.artStyle,
          ttsRate: transactionPreference.ttsRate,
        },
      })
      const episode = await tx.novelPromotionEpisode.create({
        data: {
          novelPromotionProjectId: novelProject.id,
          episodeNumber: 1,
          name: '第 1 集',
          audioMediaId: metadata.hasAudio ? media.id : null,
        },
      })
      const linked = await tx.viralReplication.updateMany({
        where: {
          id: input.id,
          userId: input.userId,
          status: VIRAL_REPLICATION_STATUS.UPLOADING,
          uploadLockToken: lockToken,
          projectId: null,
          sourceVideoMediaId: null,
        },
        data: {
          projectId: project.id,
          episodeId: episode.id,
          sourceVideoMediaId: media.id,
          analysisModelSnapshot: transactionPreference.analysisModel,
          durationMs: metadata.durationMs,
          status: VIRAL_REPLICATION_STATUS.ANALYZING,
          errorMessage: null,
          uploadLockToken: null,
          uploadLockExpiresAt: null,
        },
      })
      if (linked.count !== 1) {
        throw new ApiError('INVALID_PARAMS', { code: 'VIRAL_UPLOAD_CONFLICT' })
      }
      return { project, episode, media, analysisModelSnapshot: transactionPreference.analysisModel }
    })
    committed = true

    const baseResult = {
      id: input.id,
      projectId: created.project.id,
      episodeId: created.episode.id,
      sourceVideoMediaId: created.media.id,
    }
    try {
      const task = await submitTask({
        userId: input.userId,
        locale: input.locale,
        projectId: created.project.id,
        episodeId: created.episode.id,
        type: TASK_TYPE.VIRAL_VIDEO_ANALYSIS,
        targetType: 'ViralReplication',
        targetId: input.id,
        maxAttempts: 1,
        payload: {
          sourceVideoMediaId: created.media.id,
          analysisModelSnapshot: created.analysisModelSnapshot,
        },
      })
      return { ...baseResult, status: VIRAL_REPLICATION_STATUS.ANALYZING, taskId: task.taskId }
    } catch {
      await prisma.viralReplication.update({
        where: { id: input.id },
        data: { status: VIRAL_REPLICATION_STATUS.FAILED, errorMessage: SUBMIT_FAILURE_MESSAGE },
      })
      return { ...baseResult, status: VIRAL_REPLICATION_STATUS.FAILED, taskId: null }
    }
  } catch (error: unknown) {
    primaryFailure = error
    if (compensationStorageKey && !committed) {
      try {
        await deleteObject(compensationStorageKey)
      } catch {
        // Best-effort compensation must not mask the database/upload error.
      }
    }
    if (!committed) await releaseUploadLock(input.id, input.userId, lockToken)
    throw error
  } finally {
    if (tempFile) {
      const preserveExistingOutcome = committed || primaryFailure !== undefined
      await cleanupUploadTempFile(tempFile.cleanup, preserveExistingOutcome, {
        context: {
          replicationId: input.id,
          outcome: committed ? 'committed' : 'primary_failure',
        },
      })
    }
  }
}
