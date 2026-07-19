import sharp from 'sharp'
import { DelayedError, type Job } from 'bullmq'
import { ApiError } from '@/lib/api-errors'
import { createScopedLogger } from '@/lib/logging/core'
import { withLogContext } from '@/lib/logging/context'
import { generateImage, generateVideo } from '@/lib/generator-api'
import { generateLipSync } from '@/lib/lipsync'
import {
  advanceExternalExecutionClock,
  externalPollProgress,
  pollAsyncTask,
  type ExternalExecutionClock,
} from '@/lib/async-poll'
import { getSignedUrl, toFetchableUrl } from '@/lib/storage'
import { initializeFonts, createLabelSVG } from '@/lib/fonts'
import { processMediaResult } from '@/lib/media-process'
import {
  getProjectModelConfig,
  resolveProjectComfyWorkflowVersion,
  getUserModelConfig,
  resolveProjectModelCapabilityGenerationOptions,
} from '@/lib/config-service'
import { TaskTerminatedError } from '@/lib/task/errors'
import { isTaskActive, touchTaskHeartbeat, trySetTaskExternalId } from '@/lib/task/service'
import { type TaskJobData } from '@/lib/task/types'
import { reportTaskProgress } from './shared'
import { prisma } from '@/lib/prisma'
import { parseModelKeyStrict } from '@/lib/model-config-contract'
import {
  resolveOwnedComfyMediaRefFromValue,
  type ResolveOwnedComfyMediaRefDependencies,
} from '@/lib/comfyui/media-ownership'
import type { ComfyMediaRef } from '@/lib/comfyui/types'
import type { ComfyProviderInvocation } from '@/lib/comfyui/provider'
import {
  hasTaskModelSnapshotFields,
  resolveImageTaskSnapshot,
  resolveVideoTaskSnapshot,
  type TaskModelSnapshot,
} from '@/lib/workers/task-model-snapshot'

const DEFAULT_POLL_TIMEOUT_MS = Number.parseInt(process.env.WORKER_EXTERNAL_TIMEOUT_MS || String(20 * 60 * 1000), 10)
const DEFAULT_POLL_INTERVAL_MS = Number.parseInt(process.env.WORKER_EXTERNAL_POLL_MS || '3000', 10)

/**
 * 查询 DB 中任务是否已有 externalId（服务重启后续接轮询用，避免重复提交外部 API）
 */
async function getTaskExistingExternalId(taskId: string): Promise<string | null> {
  try {
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      select: { externalId: true },
    })
    const val = task?.externalId?.trim()
    return val || null
  } catch {
    return null
  }
}

function scopedWorkerUtilLogger(job: Job<TaskJobData>, action: string) {
  return createScopedLogger({
    module: 'worker.utils',
    action,
    requestId: job.data.trace?.requestId || undefined,
    taskId: job.data.taskId,
    projectId: job.data.projectId,
    userId: job.data.userId,
  })
}

export function parseJsonArray(value: unknown): string[] {
  if (!value) return []
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  if (typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

export async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

export async function buildComfyProviderInvocation(
  input: {
    userId: string
    projectId: string
    taskId: string
    modelKey: string
    invocationKey: string
    workflowVersionId?: string
    inputImages?: string[]
    firstFrame?: string
    lastFrame?: string
  },
  mediaDependencies?: ResolveOwnedComfyMediaRefDependencies,
): Promise<ComfyProviderInvocation | undefined> {
  if (parseModelKeyStrict(input.modelKey)?.provider !== 'comfyui') return undefined
  if (!input.invocationKey.trim()) throw new Error('COMFY_INVOCATION_KEY_REQUIRED')
  const resolveImage = async (value: string, variableName: string): Promise<ComfyMediaRef> => {
    const ref = await resolveOwnedComfyMediaRefFromValue({
      userId: input.userId,
      projectId: input.projectId,
      value,
      mediaType: 'image',
    }, mediaDependencies)
    if (!ref) {
      throw new ApiError('INVALID_PARAMS', {
        code: 'COMFY_MEDIA_NOT_OWNED',
        field: variableName,
        mediaType: 'image',
        message: 'COMFY_MEDIA_NOT_OWNED',
      })
    }
    return ref
  }
  const inputImages = input.inputImages?.length
    ? await Promise.all(input.inputImages.map((value) => resolveImage(value, 'referenceImages')))
    : undefined
  const firstFrame = input.firstFrame ? await resolveImage(input.firstFrame, 'firstFrame') : undefined
  const lastFrame = input.lastFrame ? await resolveImage(input.lastFrame, 'lastFrame') : undefined
  return {
    context: {
      projectId: input.projectId,
      taskId: input.taskId,
      invocationKey: input.invocationKey,
    },
    ...(input.workflowVersionId ? { workflowVersionId: input.workflowVersionId } : {}),
    ...(inputImages ? { inputImages } : {}),
    ...(firstFrame ? { firstFrame } : {}),
    ...(lastFrame ? { lastFrame } : {}),
  }
}

export async function assertTaskActive(job: Job<TaskJobData>, stage: string) {
  const active = await isTaskActive(job.data.taskId)
  if (active) return
  throw new TaskTerminatedError(job.data.taskId, `Task terminated during ${stage}`)
}

function normalizeExternalId(result: {
  async?: boolean
  externalId?: string
  requestId?: string
  endpoint?: string
}, mediaType: 'IMAGE' | 'VIDEO') {
  if (!result.async) return null
  const externalId = typeof result.externalId === 'string' ? result.externalId.trim() : ''
  if (externalId) return externalId
  throw new Error(`ASYNC_EXTERNAL_ID_MISSING: async ${mediaType} task returned without standard externalId`)
}

export async function waitExternalResult(
  job: Job<TaskJobData>,
  externalId: string,
  userId: string,
  opts?: {
    timeoutMs?: number
    intervalMs?: number
    progressStart?: number
    progressEnd?: number
    capacityWaitBaseMs?: number
    capacityWaitJitter?: () => number
  },
) {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS
  const intervalMs = opts?.intervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const progressStart = opts?.progressStart ?? 40
  const progressEnd = opts?.progressEnd ?? 90
  const startAt = Date.now()
  const executionClock: ExternalExecutionClock = {}
  const logger = scopedWorkerUtilLogger(job, 'worker.external.poll')

  logger.info({
    message: 'external poll started',
    details: {
      externalId,
      timeoutMs,
      intervalMs,
    },
  })

  await trySetTaskExternalId(job.data.taskId, externalId)

  while (true) {
    await assertTaskActive(job, 'polling_external')
    const status = await pollAsyncTask(externalId, userId)

    if (status.status === 'completed') {
      await clearComfyCapacityResumeMarker(job)
      const url = status.resultUrl || status.imageUrl || status.videoUrl
      if (!url) {
        throw new Error(`External task completed but no result URL: ${externalId}`)
      }
      logger.info({
        message: 'external poll completed',
        durationMs: Date.now() - startAt,
        details: {
          externalId,
        },
      })
      return {
        url,
        status,
        ...(typeof status.actualVideoTokens === 'number' ? { actualVideoTokens: status.actualVideoTokens } : {}),
        ...(status.downloadHeaders ? { downloadHeaders: status.downloadHeaders } : {}),
      }
    }

    if (status.status === 'failed') {
      await clearComfyCapacityResumeMarker(job)
      const failureMessage = status.errorCode && !status.error?.includes(status.errorCode)
        ? `${status.errorCode}: ${status.error || 'ComfyUI generation failed'}`
        : status.error || `External task failed: ${externalId}`
      logger.error({
        message: failureMessage,
        errorCode: status.errorCode || 'EXTERNAL_ERROR',
        retryable: true,
        durationMs: Date.now() - startAt,
        details: {
          externalId,
        },
      })
      throw new Error(failureMessage)
    }

    if (status.waitingForCapacity === true) {
      const progressUpdate = externalPollProgress({
        result: status, executionElapsed: null, timeoutMs, progressStart, progressEnd,
      })
      await reportTaskProgress(job, progressUpdate.progress, {
        stage: progressUpdate.stage,
        externalId,
        waitingForCapacity: true,
      })
      await yieldComfyCapacityWait(job, externalId, opts)
    }

    await clearComfyCapacityResumeMarker(job)

    const executionElapsed = advanceExternalExecutionClock(executionClock, status, Date.now())
    if (executionElapsed !== null && executionElapsed > timeoutMs) break
    const progressUpdate = externalPollProgress({
      result: status, executionElapsed, timeoutMs, progressStart, progressEnd,
    })
    await reportTaskProgress(job, progressUpdate.progress, {
      stage: progressUpdate.stage,
      externalId,
      ...(status.waitingForCapacity === true ? { waitingForCapacity: true } : {}),
    })
    await assertTaskActive(job, 'polling_external_wait')
    await sleep(intervalMs)
  }

  logger.error({
    message: 'external task polling timeout',
    errorCode: 'GENERATION_TIMEOUT',
    retryable: true,
    durationMs: Date.now() - startAt,
    details: {
      externalId,
      timeoutMs,
    },
  })
  throw new Error(`External task polling timeout (${Math.round(timeoutMs / 1000)}s): ${externalId}`)
}

async function yieldComfyCapacityWait(
  job: Job<TaskJobData>,
  externalId: string,
  opts: { capacityWaitBaseMs?: number; capacityWaitJitter?: () => number } | undefined,
): Promise<never> {
  const configured = opts?.capacityWaitBaseMs
    ?? Number.parseInt(process.env.COMFY_CAPACITY_RETRY_MS || '3000', 10)
  const baseMs = Number.isFinite(configured) ? Math.max(1_000, Math.min(30_000, configured)) : 3_000
  const random = Math.max(0, Math.min(1, opts?.capacityWaitJitter?.() ?? Math.random()))
  const delayMs = baseMs + Math.floor(baseMs * 0.25 * random)
  if (typeof job.moveToDelayed !== 'function' || typeof job.updateData !== 'function' || !job.token) {
    throw new Error('COMFY_CAPACITY_DELAY_UNAVAILABLE')
  }
  const previousData = job.data
  const nextData: TaskJobData = {
    ...previousData,
    comfyCapacityResume: {
      version: 1,
      taskId: previousData.taskId,
      externalId,
    },
  }
  await job.updateData(nextData)
  await touchTaskHeartbeat(previousData.taskId)
  try {
    await job.moveToDelayed(Date.now() + delayMs, job.token)
  } catch (error) {
    await job.updateData(previousData)
    throw error
  }
  throw new DelayedError()
}

async function clearComfyCapacityResumeMarker(job: Job<TaskJobData>) {
  if (!job.data.comfyCapacityResume || typeof job.updateData !== 'function') return
  const nextData = { ...job.data }
  delete nextData.comfyCapacityResume
  await job.updateData(nextData)
}

async function resolveImageGenerationSnapshot(
  job: Job<TaskJobData>,
  params: { modelId: string; comfyWorkflowVersionId?: string },
): Promise<TaskModelSnapshot> {
  const payload = job.data.payload
  const payloadRecord = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {}
  const hasMarker = Object.prototype.hasOwnProperty.call(payloadRecord, 'comfyModelSnapshotVersion')
  const payloadModel = payloadRecord.imageModel
  const needsLegacyComfyPin = !hasMarker
    && typeof payloadModel === 'string'
    && parseModelKeyStrict(payloadModel)?.provider === 'comfyui'
    && !Object.prototype.hasOwnProperty.call(payloadRecord, 'comfyWorkflowVersionId')
  if (hasTaskModelSnapshotFields(payload, 'image') && !needsLegacyComfyPin) {
    return resolveImageTaskSnapshot(payload, { model: params.modelId })
  }
  let legacyVersionId = params.comfyWorkflowVersionId
  if (!legacyVersionId) {
    const config = await getProjectModelConfig(job.data.projectId, job.data.userId)
    const matchesCurrentImageModel = [
      config.characterModel,
      config.locationModel,
      config.storyboardModel,
      config.editModel,
    ].includes(params.modelId)
    legacyVersionId = matchesCurrentImageModel
      ? resolveProjectComfyWorkflowVersion(config, params.modelId, 'image') ?? undefined
      : undefined
  }
  return resolveImageTaskSnapshot(payload, {
    model: params.modelId,
    comfyWorkflowVersionId: legacyVersionId,
  })
}

async function resolveVideoGenerationSnapshot(
  job: Job<TaskJobData>,
  params: { modelId: string; comfyWorkflowVersionId?: string },
): Promise<TaskModelSnapshot> {
  const payload = job.data.payload
  const payloadRecord = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {}
  const hasMarker = Object.prototype.hasOwnProperty.call(payloadRecord, 'comfyModelSnapshotVersion')
  const payloadModel = payloadRecord.videoModel
  const needsLegacyComfyPin = !hasMarker
    && typeof payloadModel === 'string'
    && parseModelKeyStrict(payloadModel)?.provider === 'comfyui'
    && !Object.prototype.hasOwnProperty.call(payloadRecord, 'comfyWorkflowVersionId')
  if (hasTaskModelSnapshotFields(payload, 'video') && !needsLegacyComfyPin) {
    return resolveVideoTaskSnapshot(payload, { model: params.modelId })
  }
  let legacyVersionId = params.comfyWorkflowVersionId
  if (!legacyVersionId) {
    const config = await getProjectModelConfig(job.data.projectId, job.data.userId)
    legacyVersionId = config.videoModel === params.modelId
      ? resolveProjectComfyWorkflowVersion(config, params.modelId, 'video') ?? undefined
      : undefined
  }
  return resolveVideoTaskSnapshot(payload, {
    model: params.modelId,
    comfyWorkflowVersionId: legacyVersionId,
  })
}

export async function resolveImageSourceFromGeneration(
  job: Job<TaskJobData>,
  params: {
    userId: string
    modelId: string
    invocationKey: string
    comfyWorkflowVersionId?: string
    prompt: string
    options?: {
      referenceImages?: string[]
      aspectRatio?: string
      resolution?: string
      size?: string
      provider?: string
    }
    allowTaskExternalIdResume?: boolean
    preferComfyStorageKey?: boolean
    comfyReferenceImages?: string[]
    pollProgress?: { start?: number; end?: number }
  },
): Promise<string> {
  const snapshot = await resolveImageGenerationSnapshot(job, params)
  const logger = scopedWorkerUtilLogger(job, 'worker.image.generate_source')
  const startedAt = Date.now()
  const allowTaskExternalIdResume = params.allowTaskExternalIdResume !== false
  const isComfyInvocation = parseModelKeyStrict(snapshot.model)?.provider === 'comfyui'

  // 服务重启续接：若 DB 中已有 externalId，直接恢复轮询，不重新提交外部 API
  if (allowTaskExternalIdResume && !isComfyInvocation) {
    const resumeExternalId = await getTaskExistingExternalId(job.data.taskId)
    if (resumeExternalId) {
      logger.info({
        message: 'image source generation resumed from existing external id',
        details: { externalId: resumeExternalId },
      })
      const polled = await waitExternalResult(job, resumeExternalId, params.userId, {
        progressStart: params.pollProgress?.start ?? 40,
        progressEnd: params.pollProgress?.end ?? 92,
      })
      return polled.url
    }
  }

  logger.info({
    message: 'image source generation started',
    provider: params.options?.provider || undefined,
    details: {
      model: snapshot.model,
    },
  })

  const runtimeSelections: Record<string, string | number | boolean> = {}
  if (typeof params.options?.resolution === 'string') {
    runtimeSelections.resolution = params.options.resolution
  }

  const capabilityOptions = await resolveProjectModelCapabilityGenerationOptions({
    projectId: job.data.projectId,
    userId: params.userId,
    modelType: 'image',
    modelKey: snapshot.model,
    runtimeSelections,
  })

  logger.info({
    message: 'image source generation calling generateImage',
    details: {
      model: snapshot.model,
      referenceImageCount: params.options?.referenceImages?.length ?? 0,
      capabilityOptions,
      optionKeys: Object.keys(params.options || {}),
    },
  })

  const comfy = await buildComfyProviderInvocation({
    userId: params.userId,
    projectId: job.data.projectId,
    taskId: job.data.taskId,
    modelKey: snapshot.model,
    invocationKey: params.invocationKey,
    workflowVersionId: snapshot.comfyWorkflowVersionId,
    inputImages: params.comfyReferenceImages ?? params.options?.referenceImages,
  })

  const result = await withLogContext(
    { projectId: job.data.projectId, taskId: job.data.taskId, userId: params.userId },
    () => generateImage(params.userId, snapshot.model, params.prompt, {
      ...params.options,
      ...capabilityOptions,
      ...(comfy ? { comfy } : {}),
    }),
  )
  if (!result.success) {
    throw new Error(result.error || 'Image generation failed')
  }

  if (result.imageUrl) {
    logger.info({
      message: 'image source generation completed',
      provider: params.options?.provider || undefined,
      durationMs: Date.now() - startedAt,
    })
    return result.imageUrl
  }
  if (result.imageBase64) {
    logger.info({
      message: 'image source generation completed (base64)',
      provider: params.options?.provider || undefined,
      durationMs: Date.now() - startedAt,
    })
    return `data:image/png;base64,${result.imageBase64}`
  }

  const externalId = normalizeExternalId(result, 'IMAGE')
  if (!externalId) {
    throw new Error('Image generation returned no image and no external id')
  }

  const polled = await waitExternalResult(job, externalId, params.userId, {
    progressStart: params.pollProgress?.start ?? 40,
    progressEnd: params.pollProgress?.end ?? 92,
  })
  logger.info({
    message: 'image source generation completed (async)',
    provider: params.options?.provider || undefined,
    durationMs: Date.now() - startedAt,
    details: {
      externalId,
    },
  })
  return isComfyInvocation && params.preferComfyStorageKey && polled.status.resultStorageKey
    ? polled.status.resultStorageKey
    : polled.url
}

/**
 * 多图版本：一次生成调用返回所有图片 URL 数组。
 *
 * - 接口返回多张（result.imageUrls）→ 返回完整列表
 * - 接口只返回单张（result.imageUrl / result.imageBase64）→ 封装成 [url] 保持接口一致
 * - 异步任务：轮询结果只有一个 URL，封装成 [url]
 *
 * 现有代码请继续使用 resolveImageSourceFromGeneration（取第一张），
 * 只有需要利用多图结果时才调用此函数。
 */
export async function resolveImageSourcesFromGeneration(
  job: Job<TaskJobData>,
  params: {
    userId: string
    modelId: string
    comfyWorkflowVersionId?: string
    invocationKey: string
    prompt: string
    options?: {
      referenceImages?: string[]
      aspectRatio?: string
      resolution?: string
      size?: string
      provider?: string
    }
    allowTaskExternalIdResume?: boolean
    comfyReferenceImages?: string[]
    pollProgress?: { start?: number; end?: number }
  },
): Promise<string[]> {
  const snapshot = await resolveImageGenerationSnapshot(job, params)
  const logger = scopedWorkerUtilLogger(job, 'worker.image.generate_sources')
  const startedAt = Date.now()
  const allowTaskExternalIdResume = params.allowTaskExternalIdResume !== false
  const isComfyInvocation = parseModelKeyStrict(snapshot.model)?.provider === 'comfyui'

  // 服务重启续接：若 DB 中已有 externalId，直接恢复轮询（异步只有一张）
  if (allowTaskExternalIdResume && !isComfyInvocation) {
    const resumeExternalId = await getTaskExistingExternalId(job.data.taskId)
    if (resumeExternalId) {
      logger.info({
        message: 'image sources generation resumed from existing external id',
        details: { externalId: resumeExternalId },
      })
      const polled = await waitExternalResult(job, resumeExternalId, params.userId, {
        progressStart: params.pollProgress?.start ?? 40,
        progressEnd: params.pollProgress?.end ?? 92,
      })
      return polled.status.resultUrls?.length ? polled.status.resultUrls : [polled.url]
    }
  }

  logger.info({
    message: 'image sources generation started',
    provider: params.options?.provider || undefined,
    details: { model: snapshot.model },
  })

  const runtimeSelections: Record<string, string | number | boolean> = {}
  if (typeof params.options?.resolution === 'string') {
    runtimeSelections.resolution = params.options.resolution
  }

  const capabilityOptions = await resolveProjectModelCapabilityGenerationOptions({
    projectId: job.data.projectId,
    userId: params.userId,
    modelType: 'image',
    modelKey: snapshot.model,
    runtimeSelections,
  })

  const comfy = await buildComfyProviderInvocation({
    userId: params.userId,
    projectId: job.data.projectId,
    taskId: job.data.taskId,
    modelKey: snapshot.model,
    invocationKey: params.invocationKey,
    workflowVersionId: snapshot.comfyWorkflowVersionId,
    inputImages: params.comfyReferenceImages ?? params.options?.referenceImages,
  })

  const result = await withLogContext(
    { projectId: job.data.projectId, taskId: job.data.taskId, userId: params.userId },
    () => generateImage(params.userId, snapshot.model, params.prompt, {
      ...params.options,
      ...capabilityOptions,
      ...(comfy ? { comfy } : {}),
    }),
  )
  if (!result.success) {
    throw new Error(result.error || 'Image generation failed')
  }

  // 优先使用多图列表
  if (result.imageUrls && result.imageUrls.length > 0) {
    logger.info({
      message: 'image sources generation completed (multi-image)',
      provider: params.options?.provider || undefined,
      durationMs: Date.now() - startedAt,
      details: { count: result.imageUrls.length },
    })
    return result.imageUrls
  }

  if (result.imageUrl) {
    logger.info({
      message: 'image sources generation completed (single url)',
      provider: params.options?.provider || undefined,
      durationMs: Date.now() - startedAt,
    })
    return [result.imageUrl]
  }

  if (result.imageBase64) {
    logger.info({
      message: 'image sources generation completed (base64)',
      provider: params.options?.provider || undefined,
      durationMs: Date.now() - startedAt,
    })
    return [`data:image/png;base64,${result.imageBase64}`]
  }

  const externalId = normalizeExternalId(result, 'IMAGE')
  if (!externalId) {
    throw new Error('Image generation returned no image and no external id')
  }

  const polled = await waitExternalResult(job, externalId, params.userId, {
    progressStart: params.pollProgress?.start ?? 40,
    progressEnd: params.pollProgress?.end ?? 92,
  })
  logger.info({
    message: 'image sources generation completed (async)',
    provider: params.options?.provider || undefined,
    durationMs: Date.now() - startedAt,
    details: { externalId },
  })
  return polled.status.resultUrls?.length ? polled.status.resultUrls : [polled.url]
}

export async function resolveVideoSourceFromGeneration(
  job: Job<TaskJobData>,
  params: {
    userId: string
    modelId: string
    invocationKey: string
    comfyWorkflowVersionId?: string
    imageUrl: string
    comfyFirstFrameSource?: string
    comfyLastFrameSource?: string
    options?: {
      prompt?: string
      duration?: number
      fps?: number
      resolution?: string
      aspectRatio?: string
      generateAudio?: boolean
      lastFrameImageUrl?: string
      generationMode?: 'normal' | 'firstlastframe'
      [key: string]: string | number | boolean | undefined
    }
    pollProgress?: { start?: number; end?: number }
  },
): Promise<{
  url: string
  storageKey?: string
  actualVideoTokens?: number
  downloadHeaders?: Record<string, string>
}> {
  const snapshot = await resolveVideoGenerationSnapshot(job, params)
  const logger = scopedWorkerUtilLogger(job, 'worker.video.generate_source')
  const startedAt = Date.now()
  const isComfyInvocation = parseModelKeyStrict(snapshot.model)?.provider === 'comfyui'

  // 服务重启续接：若 DB 中已有 externalId，直接恢复轮询，不重新提交外部 API（避免重复扣费）
  const resumeExternalId = isComfyInvocation ? null : await getTaskExistingExternalId(job.data.taskId)
  if (resumeExternalId) {
    logger.info({
      message: 'video source generation resumed from existing external id',
      details: { externalId: resumeExternalId, model: snapshot.model },
    })
    const polled = await waitExternalResult(job, resumeExternalId, params.userId, {
      progressStart: params.pollProgress?.start ?? 45,
      progressEnd: params.pollProgress?.end ?? 94,
    })
    logger.info({
      message: 'video source generation completed (resumed)',
      durationMs: Date.now() - startedAt,
      details: { externalId: resumeExternalId },
    })
    return {
      url: polled.url,
      ...(typeof polled.actualVideoTokens === 'number' ? { actualVideoTokens: polled.actualVideoTokens } : {}),
      ...(polled.downloadHeaders ? { downloadHeaders: polled.downloadHeaders } : {}),
    }
  }

  logger.info({
    message: 'video source generation started',
    details: {
      model: snapshot.model,
    },
  })

  const runtimeSelections: Record<string, string | number | boolean> = {}
  if (typeof params.options?.duration === 'number') {
    runtimeSelections.duration = params.options.duration
  }
  if (typeof params.options?.resolution === 'string') {
    runtimeSelections.resolution = params.options.resolution
  }
  if (
    params.options?.generationMode === 'normal'
    || params.options?.generationMode === 'firstlastframe'
  ) {
    runtimeSelections.generationMode = params.options.generationMode
  }
  if (typeof params.options?.generateAudio === 'boolean') {
    runtimeSelections.generateAudio = params.options.generateAudio
  }

  const capabilityOptions = await resolveProjectModelCapabilityGenerationOptions({
    projectId: job.data.projectId,
    userId: params.userId,
    modelType: 'video',
    modelKey: snapshot.model,
    runtimeSelections,
  })

  const providerCapabilityOptions: Record<string, string | number | boolean> = { ...capabilityOptions }
  delete providerCapabilityOptions.generationMode
  const providerRequestOptions: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(params.options || {})) {
    if (key === 'generationMode' || value === undefined) continue
    providerRequestOptions[key] = value
  }

  const comfy = await buildComfyProviderInvocation({
    userId: params.userId,
    projectId: job.data.projectId,
    taskId: job.data.taskId,
    modelKey: snapshot.model,
    invocationKey: params.invocationKey,
    workflowVersionId: snapshot.comfyWorkflowVersionId,
    firstFrame: params.comfyFirstFrameSource ?? params.imageUrl,
    lastFrame: params.comfyLastFrameSource ?? params.options?.lastFrameImageUrl,
  })

  const result = await withLogContext(
    { projectId: job.data.projectId, taskId: job.data.taskId, userId: params.userId },
    () => generateVideo(params.userId, snapshot.model, params.imageUrl, {
      ...providerRequestOptions,
      ...providerCapabilityOptions,
      ...(comfy ? { comfy } : {}),
    }),
  )
  if (!result.success) {
    throw new Error(result.error || 'Video generation failed')
  }

  if (result.videoUrl) {
    logger.info({
      message: 'video source generation completed',
      durationMs: Date.now() - startedAt,
    })
    return { url: result.videoUrl }
  }

  const externalId = normalizeExternalId(result, 'VIDEO')
  if (!externalId) {
    throw new Error('Video generation returned no video and no external id')
  }

  const polled = await waitExternalResult(job, externalId, params.userId, {
    progressStart: params.pollProgress?.start ?? 45,
    progressEnd: params.pollProgress?.end ?? 94,
  })
  logger.info({
    message: 'video source generation completed (async)',
    durationMs: Date.now() - startedAt,
    details: {
      externalId,
    },
  })
  return {
    url: polled.url,
    ...(isComfyInvocation && polled.status.resultStorageKey
      ? { storageKey: polled.status.resultStorageKey }
      : {}),
    ...(typeof polled.actualVideoTokens === 'number' ? { actualVideoTokens: polled.actualVideoTokens } : {}),
    ...(polled.downloadHeaders ? { downloadHeaders: polled.downloadHeaders } : {}),
  }
}

export async function resolveLipSyncVideoSource(
  job: Job<TaskJobData>,
  params: {
    userId: string
    videoUrl: string
    audioUrl: string
    audioDurationMs?: number | null
    videoDurationMs?: number | null
    modelKey?: string
    pollProgress?: { start?: number; end?: number }
  },
): Promise<string> {
  const logger = scopedWorkerUtilLogger(job, 'worker.video.lip_sync')
  const startedAt = Date.now()

  // 服务重启续接：若 DB 中已有 externalId，直接恢复轮询，不重新提交（避免重复扣费）
  const resumeExternalId = await getTaskExistingExternalId(job.data.taskId)
  if (resumeExternalId) {
    logger.info({
      message: 'lip sync generation resumed from existing external id',
      details: { externalId: resumeExternalId },
    })
    const polled = await waitExternalResult(job, resumeExternalId, params.userId, {
      progressStart: params.pollProgress?.start ?? 45,
      progressEnd: params.pollProgress?.end ?? 94,
    })
    logger.info({
      message: 'lip sync generation completed (resumed)',
      durationMs: Date.now() - startedAt,
      details: { externalId: resumeExternalId },
    })
    return polled.url
  }

  logger.info({
    message: 'lip sync generation started',
  })

  const result = await generateLipSync(
    {
      videoUrl: params.videoUrl,
      audioUrl: params.audioUrl,
      audioDurationMs: params.audioDurationMs,
      videoDurationMs: params.videoDurationMs,
    },
    params.userId,
    params.modelKey,
  )

  if (!result.requestId) {
    throw new Error('Lip sync request id missing')
  }

  const externalId = typeof result.externalId === 'string'
    ? result.externalId.trim()
    : ''
  if (!externalId) {
    throw new Error('Lip sync external id missing')
  }

  const polled = await waitExternalResult(job, externalId, params.userId, {
    progressStart: params.pollProgress?.start ?? 45,
    progressEnd: params.pollProgress?.end ?? 94,
  })

  logger.info({
    message: 'lip sync generation completed',
    durationMs: Date.now() - startedAt,
    details: {
      externalId,
    },
  })

  return polled.url
}

/**
 * 裁掉图片顶部的黑边标签区域，返回纯净内容的 base64 data URL
 * 用于改图前去除旧黑边，避免 AI 参考图携带黑边导致叠加
 */
export async function stripLabelBar(imageSource: string): Promise<string> {
  const response = await fetch(toFetchableUrl(imageSource))
  if (!response.ok) {
    throw new Error(`Failed to download image for strip: ${response.status}`)
  }
  const raw = Buffer.from(await response.arrayBuffer())
  const meta = await sharp(raw).metadata()
  const w = meta.width || 2160
  const h = meta.height || 2160
  const fontSize = Math.floor(h * 0.04)
  const pad = Math.floor(fontSize * 0.5)
  const barH = fontSize + pad * 2

  const cropped = await sharp(raw)
    .extract({ left: 0, top: barH, width: w, height: h - barH })
    .jpeg({ quality: 95, mozjpeg: true })
    .toBuffer()

  return `data:image/jpeg;base64,${cropped.toString('base64')}`
}

export async function withLabelBar(imageSource: string, labelText: string): Promise<Buffer> {
  await initializeFonts()

  const response = await fetch(toFetchableUrl(imageSource))
  if (!response.ok) {
    throw new Error(`Failed to download image: ${response.status}`)
  }

  const raw = Buffer.from(await response.arrayBuffer())
  const meta = await sharp(raw).metadata()
  const width = meta.width || 2160
  const height = meta.height || 2160
  const fontSize = Math.floor(height * 0.04)
  const pad = Math.floor(fontSize * 0.5)
  const barHeight = fontSize + pad * 2
  const svg = await createLabelSVG(width, barHeight, fontSize, pad, labelText)

  return await sharp(raw)
    .extend({ top: barHeight, bottom: 0, left: 0, right: 0, background: { r: 0, g: 0, b: 0, alpha: 1 } })
    .composite([{ input: svg, top: 0, left: 0 }])
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer()
}

export async function uploadImageSourceToCos(source: string | Buffer, keyPrefix: string, targetId: string) {
  return await processMediaResult({
    source,
    type: 'image',
    keyPrefix,
    targetId,
  })
}

export async function uploadVideoSourceToCos(
  source: string | Buffer,
  keyPrefix: string,
  targetId: string,
  downloadHeaders?: Record<string, string>,
) {
  return await processMediaResult({
    source,
    type: 'video',
    keyPrefix,
    targetId,
    downloadHeaders,
  })
}

export async function uploadAudioSourceToCos(source: string | Buffer, keyPrefix: string, targetId: string) {
  return await processMediaResult({
    source,
    type: 'audio',
    keyPrefix,
    targetId,
  })
}

export function toSignedUrlIfCos(keyOrUrl: string | null | undefined, ttlSeconds = 3600) {
  if (!keyOrUrl) return null
  return keyOrUrl.startsWith('images/') || keyOrUrl.startsWith('voice/') || keyOrUrl.startsWith('video/')
    ? getSignedUrl(keyOrUrl, ttlSeconds)
    : keyOrUrl
}

export async function getProjectModels(projectId: string, userId: string) {
  return await getProjectModelConfig(projectId, userId)
}

export async function getUserModels(userId: string) {
  return await getUserModelConfig(userId)
}
