import { Worker, type Job } from 'bullmq'
import { logError as _ulogError } from '@/lib/logging/core'
import { prisma } from '@/lib/prisma'
import { queueRedis } from '@/lib/redis'
import { QUEUE_NAME } from '@/lib/task/queue-names'
import { TASK_TYPE, type TaskJobData } from '@/lib/task/types'
import { getUserWorkflowConcurrencyConfig } from '@/lib/config-service'
import { reportTaskProgress, withTaskLifecycle } from './shared'
import { withUserConcurrencyGate } from './user-concurrency-gate'
import {
  assertTaskActive,
  getProjectModels,
  resolveLipSyncVideoSource,
  resolveVideoSourceFromGeneration,
  toSignedUrlIfCos,
  uploadVideoSourceToCos,
} from './utils'
import {
  LTX_DIRECTOR_TIMELINE_VERSION,
  normalizeLtxDirectorGlobalPrompt,
  parseLtxDirectorTimelineSpec,
  type LtxDirectorTimelineSegmentSpec,
} from '@/lib/comfyui/ltx-director'
import { normalizeToBase64ForGeneration } from '@/lib/media/outbound-image'
import { resolveBuiltinCapabilitiesByModelKey } from '@/lib/model-capabilities/lookup'
import { parseModelKeyStrict } from '@/lib/model-config-contract'
import { isOwnedDirectorUploadStorageKey } from '@/lib/novel-promotion/director-media'
import { getProviderConfig } from '@/lib/api-config'
import { resolveVideoGenerationModel } from '@/lib/video/model-selection'
import { resolvePinnedVideoPrompt } from '@/lib/novel-promotion/video/panel-video-submission'
import {
  ensureMediaObjectFromStorageKey,
  getMediaObjectById,
  resolveStorageKeyFromMediaValue,
} from '@/lib/media/service'
import { deleteObject } from '@/lib/storage'
import { scheduleMediaCleanupCandidate } from '@/lib/media/deferred-cleanup'
import {
  buildLipSyncPanelPublishVoiceLineWhere,
  buildOwnedLipSyncVoiceLineWhere,
} from '@/lib/novel-promotion/lip-sync/voice-line-match'

type AnyObj = Record<string, unknown>
type VideoOptionValue = string | number | boolean
type VideoOptionMap = Record<string, VideoOptionValue>
type VideoGenerationMode = 'normal' | 'firstlastframe'
type PanelRecord = NonNullable<Awaited<ReturnType<typeof prisma.novelPromotionPanel.findUnique>>>

function toDurationMs(value: number | null | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return value > 1000 ? Math.round(value) : Math.round(value * 1000)
}

async function cleanupUnpublishedLipSyncResult(input: {
  storageKey: string
  mediaId?: string | null
}) {
  if (input.mediaId) {
    try {
      await prisma.mediaObject.deleteMany({ where: { id: input.mediaId } })
    } catch (error) {
      _ulogError('[VideoWorker] failed to clean unpublished lip-sync media row', {
        mediaId: input.mediaId,
        storageKey: input.storageKey,
        error,
      })
    }
  }

  try {
    await deleteObject(input.storageKey)
  } catch (error) {
    _ulogError('[VideoWorker] failed to clean unpublished lip-sync object', {
      storageKey: input.storageKey,
      error,
    })
  }
}

async function deferReplacedLipSyncVideoCleanup(input: {
  lipSyncVideoUrl: string | null
  lipSyncVideoMediaId: string | null
  replacementStorageKey: string
}) {
  try {
    const media = input.lipSyncVideoMediaId
      ? await getMediaObjectById(input.lipSyncVideoMediaId)
      : null
    const storageKey = media?.storageKey
      || await resolveStorageKeyFromMediaValue(input.lipSyncVideoUrl)
    if (!storageKey || storageKey === input.replacementStorageKey) return

    await scheduleMediaCleanupCandidate({
      storageKey,
      mediaId: input.lipSyncVideoMediaId,
      mediaKind: 'video',
      reason: 'panel_lip_sync_replaced',
    })
  } catch (error) {
    _ulogError('[VideoWorker] failed to defer replaced lip-sync video cleanup', {
      lipSyncVideoMediaId: input.lipSyncVideoMediaId,
      lipSyncVideoUrl: input.lipSyncVideoUrl,
      error,
    })
  }
}

function extractGenerationOptions(payload: AnyObj): VideoOptionMap {
  const fromEnvelope = payload.generationOptions
  if (!fromEnvelope || typeof fromEnvelope !== 'object' || Array.isArray(fromEnvelope)) {
    return {}
  }

  const next: VideoOptionMap = {}
  for (const [key, value] of Object.entries(fromEnvelope as Record<string, unknown>)) {
    if (key === 'aspectRatio') continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      next[key] = value
    }
  }
  return next
}

async function fetchPanelByStoryboardIndex(
  storyboardId: string,
  panelIndex: number,
  projectId: string,
  userId: string,
) {
  return await prisma.novelPromotionPanel.findFirst({
    where: {
      storyboardId,
      panelIndex,
      storyboard: { episode: { novelPromotionProject: { projectId, project: { userId } } } },
    },
  })
}

async function fetchFramePanelById(panelId: string, projectId: string, userId: string) {
  return await prisma.novelPromotionPanel.findFirst({
    where: {
      id: panelId,
      storyboard: { episode: { novelPromotionProject: { projectId, project: { userId } } } },
    },
  })
}

async function fetchLastFramePanel(firstLastFramePayload: AnyObj, projectId: string, userId: string) {
  if (typeof firstLastFramePayload.sourcePanelId === 'string' && firstLastFramePayload.sourcePanelId) {
    return await fetchFramePanelById(firstLastFramePayload.sourcePanelId, projectId, userId)
  }
  if (
    typeof firstLastFramePayload.lastFrameStoryboardId === 'string'
    && firstLastFramePayload.lastFrameStoryboardId
    && firstLastFramePayload.lastFramePanelIndex !== undefined
  ) {
    return await fetchPanelByStoryboardIndex(
      firstLastFramePayload.lastFrameStoryboardId,
      Number(firstLastFramePayload.lastFramePanelIndex),
      projectId,
      userId,
    )
  }
  return null
}

async function getPanelForVideoTask(job: Job<TaskJobData>) {
  const payload = (job.data.payload || {}) as AnyObj

  // 优先使用 targetType=NovelPromotionPanel 直接定位
  if (job.data.targetType === 'NovelPromotionPanel') {
    const panel = await prisma.novelPromotionPanel.findUnique({ where: { id: job.data.targetId } })
    if (!panel) throw new Error('Panel not found')
    return panel
  }

  // 兜底：通过 storyboardId + panelIndex 定位
  const storyboardId = payload.storyboardId
  const panelIndex = payload.panelIndex
  if (typeof storyboardId !== 'string' || !storyboardId || panelIndex === undefined || panelIndex === null) {
    throw new Error('Missing storyboardId/panelIndex for video task')
  }

  const panel = await fetchPanelByStoryboardIndex(
    storyboardId,
    Number(panelIndex),
    job.data.projectId,
    job.data.userId,
  )
  if (!panel) throw new Error('Panel not found by storyboardId/panelIndex')
  return panel
}

async function generateVideoForPanel(
  job: Job<TaskJobData>,
  panel: PanelRecord,
  payload: AnyObj,
  modelId: string,
  projectVideoRatio: string | null | undefined,
  generationOptions: VideoOptionMap,
): Promise<{ cosKey: string; generationMode: VideoGenerationMode; actualVideoTokens?: number }> {
  const firstLastFramePayload =
    typeof payload.firstLastFrame === 'object' && payload.firstLastFrame !== null
      ? (payload.firstLastFrame as AnyObj)
      : null
  let firstFramePanel = panel
  if (
    firstLastFramePayload
    && typeof firstLastFramePayload.firstFrameSourcePanelId === 'string'
    && firstLastFramePayload.firstFrameSourcePanelId
  ) {
    const trustedFirstFramePanel = await fetchFramePanelById(
      firstLastFramePayload.firstFrameSourcePanelId,
      job.data.projectId,
      job.data.userId,
    )
    if (!trustedFirstFramePanel) throw new Error('VIDEO_FIRST_FRAME_SOURCE_FORBIDDEN')
    firstFramePanel = trustedFirstFramePanel
  }
  if (!firstFramePanel.imageUrl) {
    throw new Error(`Panel ${firstFramePanel.id} has no imageUrl`)
  }
  const queuedPrompt = typeof payload.videoPrompt === 'string' ? payload.videoPrompt : null
  const prompt = resolvePinnedVideoPrompt({
    queuedPrompt,
    persistedPrompt: firstLastFramePayload ? panel.firstLastFramePrompt || panel.videoPrompt : panel.videoPrompt,
    persistedDescription: panel.description,
  })
  if (!prompt) {
    throw new Error(`Panel ${panel.id} has no video prompt`)
  }

  const model = modelId
  const isComfyModel = parseModelKeyStrict(model)?.provider === 'comfyui'
  let sourceImageInput = firstFramePanel.imageUrl
  if (!isComfyModel) {
    const sourceImageUrl = toSignedUrlIfCos(firstFramePanel.imageUrl, 3600)
    if (!sourceImageUrl) {
      throw new Error(`Panel ${firstFramePanel.id} image url invalid`)
    }
    sourceImageInput = await normalizeToBase64ForGeneration(sourceImageUrl)
  }

  let lastFrameImageBase64: string | undefined
  let lastFrameStorageValue: string | undefined
  const generationMode: VideoGenerationMode = firstLastFramePayload ? 'firstlastframe' : 'normal'
  const requestedGenerateAudio = typeof generationOptions.generateAudio === 'boolean'
    ? generationOptions.generateAudio
    : undefined

  if (firstLastFramePayload) {
    if (!isComfyModel) {
      const firstLastFrameCapabilities = resolveBuiltinCapabilitiesByModelKey('video', model)
      if (firstLastFrameCapabilities?.video?.firstlastframe !== true) {
        throw new Error(`VIDEO_FIRSTLASTFRAME_MODEL_UNSUPPORTED: ${model}`)
      }
    }
    const hasLastFrameReference = typeof firstLastFramePayload.sourcePanelId === 'string'
      || typeof firstLastFramePayload.lastFrameStoryboardId === 'string'
    if (hasLastFrameReference) {
      const lastPanel = await fetchLastFramePanel(firstLastFramePayload, job.data.projectId, job.data.userId)
      if (!lastPanel) throw new Error('VIDEO_LAST_FRAME_SOURCE_FORBIDDEN')
      if (lastPanel?.imageUrl) {
        lastFrameStorageValue = lastPanel.imageUrl
        if (!isComfyModel) {
          const lastFrameUrl = toSignedUrlIfCos(lastPanel.imageUrl, 3600)
          if (lastFrameUrl) {
            lastFrameImageBase64 = await normalizeToBase64ForGeneration(lastFrameUrl)
          }
        }
      }
    }
  }

  const generatedVideo = await resolveVideoSourceFromGeneration(job, {
    userId: job.data.userId,
    modelId: model,
    invocationKey: `${job.data.taskId}:panel:${panel.id}:video`,
    comfyWorkflowVersionId: typeof payload.comfyWorkflowVersionId === 'string'
      ? payload.comfyWorkflowVersionId
      : undefined,
    imageUrl: sourceImageInput,
    comfyFirstFrameSource: firstFramePanel.imageUrl,
    comfyLastFrameSource: lastFrameStorageValue,
    options: {
      prompt,
      ...(projectVideoRatio ? { aspectRatio: projectVideoRatio } : {}),
      ...generationOptions,
      generationMode,
      ...(typeof requestedGenerateAudio === 'boolean' ? { generateAudio: requestedGenerateAudio } : {}),
      ...(lastFrameImageBase64 ? { lastFrameImageUrl: lastFrameImageBase64 } : {}),
    },
  })

  let downloadHeaders: Record<string, string> | undefined
  const videoSource = generatedVideo.url
  if (generatedVideo.downloadHeaders) {
    downloadHeaders = generatedVideo.downloadHeaders
  } else if (typeof videoSource === 'string') {
    const parsedModel = parseModelKeyStrict(model)
    const isGoogleDownloadUrl = videoSource.includes('generativelanguage.googleapis.com/')
      && videoSource.includes('/files/')
      && videoSource.includes(':download')
    if (parsedModel?.provider === 'google' && isGoogleDownloadUrl) {
      const { apiKey } = await getProviderConfig(job.data.userId, 'google')
      downloadHeaders = { 'x-goog-api-key': apiKey }
    }
  }

  const cosKey = generatedVideo.storageKey
    ?? await uploadVideoSourceToCos(videoSource, 'panel-video', panel.id, downloadHeaders)
  return {
    cosKey,
    generationMode,
    ...(typeof generatedVideo.actualVideoTokens === 'number'
      ? { actualVideoTokens: generatedVideo.actualVideoTokens }
      : {}),
  }
}

async function handleVideoPanelTask(job: Job<TaskJobData>) {
  const payload = (job.data.payload || {}) as AnyObj
  const projectModels = await getProjectModels(job.data.projectId, job.data.userId)

  const modelId = resolveVideoGenerationModel(payload)
  if (!modelId) throw new Error('VIDEO_MODEL_REQUIRED: payload video model is required')

  const panel = await getPanelForVideoTask(job)

  const generationOptions = extractGenerationOptions(payload)

  await reportTaskProgress(job, 10, {
    stage: 'generate_panel_video',
    panelId: panel.id,
  })

  const { cosKey, generationMode, actualVideoTokens } = await generateVideoForPanel(
    job,
    panel,
    payload,
    modelId,
    projectModels.videoRatio,
    generationOptions,
  )
  const videoMedia = await ensureMediaObjectFromStorageKey(cosKey)

  await assertTaskActive(job, 'persist_panel_video')
  await prisma.novelPromotionPanel.update({
    where: { id: panel.id },
    data: {
      videoUrl: cosKey,
      videoMediaId: videoMedia.id,
      videoGenerationMode: generationMode,
    },
  })

  return {
    panelId: panel.id,
    videoUrl: videoMedia.url,
    videoMediaId: videoMedia.id,
    ...(typeof actualVideoTokens === 'number' ? { actualVideoTokens } : {}),
  }
}

function positiveDuration(...values: Array<number | null | undefined>) {
  return values.find((value): value is number => (
    typeof value === 'number' && Number.isFinite(value) && value > 0
  )) ?? 3
}

async function handleStoryboardDirectorVideoTask(job: Job<TaskJobData>) {
  const payload = (job.data.payload || {}) as AnyObj
  const storyboard = await prisma.novelPromotionStoryboard.findFirst({
    where: {
      id: job.data.targetId,
      episodeId: job.data.episodeId || undefined,
      episode: {
        novelPromotionProject: {
          projectId: job.data.projectId,
          project: { userId: job.data.userId },
        },
      },
    },
    include: {
      clip: true,
      episode: { include: { novelPromotionProject: true } },
      panels: { orderBy: { panelIndex: 'asc' } },
    },
  })
  if (!storyboard) throw new Error('STORYBOARD_DIRECTOR_NOT_FOUND')
  const modelId = typeof payload.videoModel === 'string' ? payload.videoModel : ''
  const workflowVersionId = typeof payload.comfyWorkflowVersionId === 'string'
    ? payload.comfyWorkflowVersionId
    : undefined
  if (parseModelKeyStrict(modelId)?.provider !== 'comfyui' || !workflowVersionId) {
    throw new Error('STORYBOARD_DIRECTOR_MODEL_INVALID')
  }
  const savedTimeline = parseLtxDirectorTimelineSpec(payload.timelineSpec)
    ?? parseLtxDirectorTimelineSpec(storyboard.directorConfigJson)
  const fallbackPanels = storyboard.panels.filter((panel) => Boolean(panel.imageUrl))
  if (!savedTimeline && (fallbackPanels.length === 0 || fallbackPanels.length > 8)) {
    throw new Error('STORYBOARD_DIRECTOR_IMAGES_INVALID')
  }
  let fallbackCursor = 0
  const fallbackSegments = fallbackPanels.map((panel) => {
    const durationSeconds = positiveDuration(panel.durationOverride, panel.estimatedDuration, panel.duration)
    const segment = {
      id: `panel-${panel.id}`,
      sourcePanelId: panel.id,
      prompt: panel.videoPrompt?.trim() || panel.description?.trim() || panel.imagePrompt?.trim() || '',
      startSeconds: fallbackCursor,
      durationSeconds,
      guideStrength: 1,
    }
    fallbackCursor += durationSeconds
    return segment
  })
  const timelineSegments: LtxDirectorTimelineSegmentSpec[] = savedTimeline?.segments ?? fallbackSegments
  if (timelineSegments.length === 0 || timelineSegments.length > 8) {
    throw new Error('STORYBOARD_DIRECTOR_IMAGES_INVALID')
  }
  const sourcePanelIds = [...new Set(timelineSegments.flatMap((segment) => {
    const panelId = segment.sourcePanelId || segment.panelId
    return panelId ? [panelId] : []
  }))]
  const sourcePanels = sourcePanelIds.length === 0 ? [] : await prisma.novelPromotionPanel.findMany({
    where: { id: { in: sourcePanelIds }, storyboard: { episodeId: storyboard.episodeId } },
  })
  const sourcePanelsById = new Map(sourcePanels.map((panel) => [panel.id, panel]))
  const sourceMediaIds = [...new Set([
    ...timelineSegments.flatMap((segment) => segment.sourceMediaId ? [segment.sourceMediaId] : []),
    ...(savedTimeline?.motionSegments ?? []).map((segment) => segment.sourceMediaId),
    ...(savedTimeline?.audioSegments ?? []).map((segment) => segment.sourceMediaId),
    ...(savedTimeline?.retakeVideoMediaId ? [savedTimeline.retakeVideoMediaId] : []),
  ])]
  const sourceMedia = await Promise.all(sourceMediaIds.map((mediaId) => getMediaObjectById(mediaId)))
  const sourceMediaById = new Map(sourceMedia.flatMap((media) => media ? [[media.id, media]] : []))
  const sourceImages = timelineSegments.map((segment) => {
    const panelId = segment.sourcePanelId || segment.panelId
    if (panelId) {
      const panel = sourcePanelsById.get(panelId)
      if (!panel?.imageUrl) throw new Error('STORYBOARD_DIRECTOR_SOURCE_INVALID')
      return panel.imageUrl
    }
    if (segment.sourceMediaId) {
      const media = sourceMediaById.get(segment.sourceMediaId)
      if (!media?.storageKey || !media.mimeType?.startsWith('image/')
        || !isOwnedDirectorUploadStorageKey(media.storageKey, job.data.userId, job.data.projectId)) {
        throw new Error('STORYBOARD_DIRECTOR_SOURCE_INVALID')
      }
      return media.url
    }
    throw new Error('STORYBOARD_DIRECTOR_SOURCE_REQUIRED')
  })
  const resolveDirectorMediaRefs = (
    ids: string[],
    mediaType: 'video' | 'audio',
  ) => ids.map((mediaId) => {
    const media = sourceMediaById.get(mediaId)
    if (!media?.storageKey || !media.mimeType?.startsWith(`${mediaType}/`)
      || !isOwnedDirectorUploadStorageKey(media.storageKey, job.data.userId, job.data.projectId)) {
      throw new Error('STORYBOARD_DIRECTOR_SOURCE_INVALID')
    }
    return {
      storageKey: media.storageKey,
      mimeType: media.mimeType,
      filename: media.storageKey.split('/').pop(),
    }
  })
  const directorVideos = resolveDirectorMediaRefs(
    (savedTimeline?.motionSegments ?? []).map((segment) => segment.sourceMediaId),
    'video',
  )
  const directorAudios = resolveDirectorMediaRefs(
    (savedTimeline?.audioSegments ?? []).map((segment) => segment.sourceMediaId),
    'audio',
  )
  const directorRetakeVideos = savedTimeline?.retakeVideoMediaId
    ? resolveDirectorMediaRefs([savedTimeline.retakeVideoMediaId], 'video')
    : []
  const fps = savedTimeline?.fps
    ?? (typeof payload.fps === 'number' && Number.isFinite(payload.fps) && payload.fps > 0
      ? payload.fps
      : 24)
  const fallbackGlobalPrompt = [
    storyboard.episode.novelPromotionProject.artStylePrompt,
    storyboard.continuityAnchor,
    storyboard.clip.summary,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => normalizeLtxDirectorGlobalPrompt(value))
    .filter(Boolean)
    .join('\n')
  const segments = timelineSegments.map((segment) => ({
    ...segment,
    guideStrength: segment.guideStrength ?? 1,
  }))
  const totalDuration = segments.reduce((latest, segment) => Math.max(
    latest,
    (segment.startSeconds ?? latest) + segment.durationSeconds,
  ), 0)
  const generationDuration = savedTimeline?.rangeStartSeconds !== undefined
    && savedTimeline.rangeEndSeconds !== undefined
    ? savedTimeline.rangeEndSeconds - savedTimeline.rangeStartSeconds
    : totalDuration
  const prompt = JSON.stringify({
    ...(savedTimeline ?? {}),
    version: LTX_DIRECTOR_TIMELINE_VERSION,
    fps,
    globalPrompt: savedTimeline?.globalPrompt ?? fallbackGlobalPrompt,
    videoModel: modelId,
    aspectRatio: savedTimeline?.aspectRatio
      ?? storyboard.episode.novelPromotionProject.videoRatio
      ?? '16:9',
    segments,
  })
  await reportTaskProgress(job, 15, {
    stage: 'build_ltx_director_timeline',
    storyboardId: storyboard.id,
    segmentCount: segments.length,
  })
  const source = await resolveVideoSourceFromGeneration(job, {
    userId: job.data.userId,
    modelId,
    invocationKey: `${job.data.taskId}:storyboard:${storyboard.id}:ltx-director`,
    comfyWorkflowVersionId: workflowVersionId,
    imageUrl: sourceImages[0]!,
    comfyReferenceImages: sourceImages,
    comfyReferenceImagesOnly: true,
    comfyVariables: {
      directorVideos,
      directorAudios,
      directorRetakeVideos,
    },
    options: {
      prompt,
      duration: generationDuration,
      fps,
      aspectRatio: storyboard.episode.novelPromotionProject.videoRatio,
    },
    pollProgress: { start: 25, end: 92 },
  })
  const storageKey = source.storageKey
    ?? await uploadVideoSourceToCos(source.url, 'storyboard-director', storyboard.id, source.downloadHeaders)
  const videoMedia = await ensureMediaObjectFromStorageKey(storageKey)
  await assertTaskActive(job, 'persist_storyboard_director_video')
  await prisma.novelPromotionStoryboard.update({
    where: { id: storyboard.id },
    data: { directorVideoUrl: storageKey, directorVideoMediaId: videoMedia.id },
  })
  return {
    storyboardId: storyboard.id,
    directorVideoUrl: videoMedia.url,
    directorVideoMediaId: videoMedia.id,
  }
}

async function handleLipSyncTask(job: Job<TaskJobData>) {
  const payload = (job.data.payload || {}) as AnyObj
  const lipSyncModel = typeof payload.lipSyncModel === 'string' && payload.lipSyncModel.trim()
    ? payload.lipSyncModel.trim()
    : undefined

  let panel: PanelRecord | null = null
  if (job.data.targetType === 'NovelPromotionPanel') {
    panel = await fetchFramePanelById(job.data.targetId, job.data.projectId, job.data.userId)
  }

  if (
    !panel &&
    typeof payload.storyboardId === 'string' &&
    payload.storyboardId &&
    payload.panelIndex !== undefined
  ) {
    panel = await fetchPanelByStoryboardIndex(
      payload.storyboardId,
      Number(payload.panelIndex),
      job.data.projectId,
      job.data.userId,
    )
  }

  if (!panel) throw new Error('Lip-sync panel not found')
  if (!panel.videoUrl) throw new Error('Panel has no base video')

  const voiceLineId = typeof payload.voiceLineId === 'string' ? payload.voiceLineId : null
  if (!voiceLineId) throw new Error('Lip-sync task missing voiceLineId')

  const voiceLine = await prisma.novelPromotionVoiceLine.findFirst({
    where: buildOwnedLipSyncVoiceLineWhere({
      voiceLineId,
      panel,
      projectId: job.data.projectId,
      userId: job.data.userId,
    }),
  })
  if (!voiceLine || !voiceLine.enabled || !voiceLine.audioUrl) {
    throw new Error('Voice line or audioUrl not found')
  }
  const voiceLineAudioUrl = voiceLine.audioUrl

  const signedVideoUrl = toSignedUrlIfCos(panel.videoUrl, 7200)
  const signedAudioUrl = toSignedUrlIfCos(voiceLineAudioUrl, 7200)

  if (!signedVideoUrl || !signedAudioUrl) {
    throw new Error('Lip-sync input media url invalid')
  }

  await reportTaskProgress(job, 25, { stage: 'submit_lip_sync' })

  const source = await resolveLipSyncVideoSource(job, {
    userId: job.data.userId,
    videoUrl: signedVideoUrl,
    audioUrl: signedAudioUrl,
    audioDurationMs: typeof voiceLine.audioDuration === 'number' ? voiceLine.audioDuration : undefined,
    videoDurationMs: toDurationMs(panel.duration),
    modelKey: lipSyncModel,
  })

  const currentVoiceLine = await prisma.novelPromotionVoiceLine.findFirst({
    where: {
      ...buildOwnedLipSyncVoiceLineWhere({
        voiceLineId: voiceLine.id,
        panel,
        projectId: job.data.projectId,
        userId: job.data.userId,
      }),
      lineType: voiceLine.lineType,
      audioUrl: voiceLineAudioUrl,
    },
    select: { id: true },
  })
  if (!currentVoiceLine) {
    throw new Error('LIP_SYNC_INPUT_STALE')
  }

  await reportTaskProgress(job, 93, { stage: 'persist_lip_sync' })

  const cosKey = await uploadVideoSourceToCos(
    source,
    'lip-sync',
    `${panel.id}-${job.data.taskId}`,
  )
  let lipSyncVideoMedia: Awaited<ReturnType<typeof ensureMediaObjectFromStorageKey>> | null = null
  let published = false
  try {
    lipSyncVideoMedia = await ensureMediaObjectFromStorageKey(cosKey)

    await assertTaskActive(job, 'persist_lip_sync_video')
    const data = {
      lipSyncVideoUrl: cosKey,
      lipSyncVideoMediaId: lipSyncVideoMedia.id,
      lipSyncTaskId: null,
    }
    const persisted = await prisma.novelPromotionPanel.updateMany({
      where: {
        id: panel.id,
        videoUrl: panel.videoUrl,
        lipSyncVideoUrl: panel.lipSyncVideoUrl,
        lipSyncVideoMediaId: panel.lipSyncVideoMediaId,
        ...buildLipSyncPanelPublishVoiceLineWhere({
          voiceLineId: voiceLine.id,
          panel,
          projectId: job.data.projectId,
          userId: job.data.userId,
          lineType: voiceLine.lineType,
          audioUrl: voiceLineAudioUrl,
        }),
      },
      data,
    })
    if (persisted.count === 0) {
      throw new Error('LIP_SYNC_INPUT_STALE')
    }
    published = true
  } catch (error) {
    if (!published) {
      await cleanupUnpublishedLipSyncResult({
        storageKey: cosKey,
        mediaId: lipSyncVideoMedia?.id,
      })
    }
    throw error
  }

  await deferReplacedLipSyncVideoCleanup({
    lipSyncVideoUrl: panel.lipSyncVideoUrl,
    lipSyncVideoMediaId: panel.lipSyncVideoMediaId,
    replacementStorageKey: cosKey,
  })

  return {
    panelId: panel.id,
    voiceLineId,
    lipSyncVideoUrl: lipSyncVideoMedia.url,
    lipSyncVideoMediaId: lipSyncVideoMedia.id,
  }
}

async function processVideoTask(job: Job<TaskJobData>) {
  await reportTaskProgress(job, 5, { stage: 'received' })

  switch (job.data.type) {
    case TASK_TYPE.VIDEO_PANEL:
      return await handleVideoPanelTask(job)
    case TASK_TYPE.STORYBOARD_DIRECTOR_VIDEO:
      return await handleStoryboardDirectorVideoTask(job)
    case TASK_TYPE.LIP_SYNC:
      return await handleLipSyncTask(job)
    default:
      throw new Error(`Unsupported video task type: ${job.data.type}`)
  }
}

export function createVideoWorker() {
  return new Worker<TaskJobData>(
    QUEUE_NAME.VIDEO,
    async (job) => await withTaskLifecycle(job, async (taskJob) => {
      const workflowConcurrency = await getUserWorkflowConcurrencyConfig(taskJob.data.userId)
      return await withUserConcurrencyGate({
        scope: 'video',
        userId: taskJob.data.userId,
        limit: workflowConcurrency.video,
        run: async () => await processVideoTask(taskJob),
      })
    }),
    {
      connection: queueRedis,
      concurrency: Number.parseInt(process.env.QUEUE_CONCURRENCY_VIDEO || '4', 10) || 4,
    },
  )
}
