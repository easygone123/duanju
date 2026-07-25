import { NextRequest, NextResponse } from 'next/server'

import { requireProjectAuthLight, isErrorResponse } from '@/lib/api-auth'
import { ApiError, apiHandler, getRequestId } from '@/lib/api-errors'
import { getProjectModelConfig } from '@/lib/config-service'
import {
  LTX_DIRECTOR_TIMELINE_VERSION,
  parseLtxDirectorTimelineSpec,
  resolveLtxDirectorAspectRatioFromDimensions,
  type LtxDirectorTimelineSpec,
} from '@/lib/comfyui/ltx-director'
import { hasLtxDirectorNode } from '@/lib/comfyui/ltx-director-contract'
import { mergeDirectorConfig } from '@/lib/comfyui/director-config-envelope'
import { isExecutableOwnedWorkflow } from '@/lib/comfyui/workflow-model-option'
import { parseModelKeyStrict } from '@/lib/model-config-contract'
import { isOwnedDirectorUploadStorageKey } from '@/lib/novel-promotion/director-media'
import { prisma } from '@/lib/prisma'
import { submitTask } from '@/lib/task/submitter'
import { TASK_TYPE } from '@/lib/task/types'
import { withTaskUiPayload } from '@/lib/task/ui-payload'
import { resolveRequiredTaskLocale } from '@/lib/task/resolve-locale'

interface DirectorRequestBody {
  storyboardId?: unknown
  videoModel?: unknown
  timelineSpec?: unknown
  locale?: unknown
}

async function loadOwnedStoryboard(projectId: string, userId: string, storyboardId: string) {
  const storyboard = await prisma.novelPromotionStoryboard.findFirst({
    where: {
      id: storyboardId,
      episode: { novelPromotionProject: { projectId, project: { userId } } },
    },
    select: {
      id: true,
      episodeId: true,
      directorVideoMediaId: true,
      directorConfigJson: true,
      episode: {
        select: {
          audioMediaId: true,
          novelPromotionProject: { select: { videoRatio: true } },
          storyboards: {
            orderBy: [{ groupSequence: 'asc' }, { createdAt: 'asc' }],
            select: {
              panels: {
                orderBy: { panelIndex: 'asc' },
                select: {
                  id: true,
                  imageUrl: true,
                  imageMedia: { select: { width: true, height: true } },
                },
              },
            },
          },
        },
      },
    },
  })
  if (!storyboard) throw new ApiError('NOT_FOUND')
  return storyboard
}

async function normalizeTimelineSpec(input: {
  value: unknown
  storyboard: Awaited<ReturnType<typeof loadOwnedStoryboard>>
  userId: string
  projectId: string
}): Promise<LtxDirectorTimelineSpec> {
  const { storyboard, userId, projectId } = input
  const allPanels = storyboard.episode.storyboards.flatMap((item) => item.panels)
  const panelsById = new Map(allPanels.map((panel) => [panel.id, panel]))
  const parsed = parseLtxDirectorTimelineSpec(input.value)
  if (!parsed || (parsed.segments.length === 0 && !parsed.retakeEnabled)
    || parsed.segments.length > 64 || parsed.fps > 240
    || parsed.segments.some((segment) => segment.durationSeconds > 600)) {
    throw new ApiError('INVALID_PARAMS', { code: 'STORYBOARD_DIRECTOR_CONFIG_INVALID' })
  }
  if ((parsed.motionSegments?.length ?? 0) > 64 || (parsed.audioSegments?.length ?? 0) > 64
    || parsed.motionSegments?.some((segment) => segment.durationSeconds > 600)
    || parsed.audioSegments?.some((segment) => segment.durationSeconds > 600)
    || (parsed.retakeEnabled && (!parsed.retakeVideoMediaId || !parsed.retakeDurationSeconds))) {
    throw new ApiError('INVALID_PARAMS', { code: 'STORYBOARD_DIRECTOR_TRACK_CONFIG_INVALID' })
  }
  const mediaIds = [...new Set([
    ...parsed.segments.flatMap((segment) => segment.sourceMediaId ? [segment.sourceMediaId] : []),
    ...(parsed.motionSegments ?? []).map((segment) => segment.sourceMediaId),
    ...(parsed.audioSegments ?? []).map((segment) => segment.sourceMediaId),
    ...(parsed.retakeVideoMediaId ? [parsed.retakeVideoMediaId] : []),
  ])]
  const uploadedMedia = mediaIds.length === 0 ? [] : await prisma.mediaObject.findMany({
    where: { id: { in: mediaIds } },
    select: { id: true, publicId: true, storageKey: true, mimeType: true, width: true, height: true },
  })
  const mediaById = new Map(uploadedMedia.map((media) => [media.id, media]))
  let sequentialCursor = 0
  const normalizedSegments = parsed.segments.map((segment, index) => {
    const startSeconds = segment.startSeconds ?? sequentialCursor
    sequentialCursor = Math.max(sequentialCursor, startSeconds + segment.durationSeconds)
    const sourcePanelId = segment.sourcePanelId || segment.panelId
    if (sourcePanelId) {
      if (segment.type !== 'image') {
        throw new ApiError('INVALID_PARAMS', { code: 'STORYBOARD_DIRECTOR_SOURCE_INVALID' })
      }
      const panel = panelsById.get(sourcePanelId)
      if (!panel?.imageUrl) {
        throw new ApiError('INVALID_PARAMS', { code: 'STORYBOARD_DIRECTOR_SOURCE_INVALID' })
      }
      return {
        id: segment.id || `segment-${index + 1}`,
        type: 'image' as const,
        sourcePanelId,
        prompt: segment.prompt,
        startSeconds,
        durationSeconds: segment.durationSeconds,
        guideStrength: segment.guideStrength ?? 1,
        ...(segment.isEndFrame ? { isEndFrame: true } : {}),
      }
    }
    if (segment.sourceMediaId) {
      const media = mediaById.get(segment.sourceMediaId)
      const expectedMediaType = segment.type === 'video' ? 'video' : 'image'
      if (!media || !media.mimeType?.startsWith(`${expectedMediaType}/`)
        || !isOwnedDirectorUploadStorageKey(media.storageKey, userId, projectId)) {
        throw new ApiError('INVALID_PARAMS', { code: 'STORYBOARD_DIRECTOR_SOURCE_INVALID' })
      }
      return {
        id: segment.id || `segment-${index + 1}`,
        type: segment.type,
        sourceMediaId: media.id,
        ...(segment.type === 'video'
          ? { sourceUrl: `/m/${encodeURIComponent(media.publicId)}` }
          : { sourceImageUrl: `/m/${encodeURIComponent(media.publicId)}` }),
        ...(segment.filename ? { filename: segment.filename } : {}),
        prompt: segment.prompt,
        startSeconds,
        durationSeconds: segment.durationSeconds,
        guideStrength: segment.guideStrength ?? 1,
        ...(segment.trimStartSeconds !== undefined ? { trimStartSeconds: segment.trimStartSeconds } : {}),
        ...(segment.mediaDurationSeconds !== undefined ? { mediaDurationSeconds: segment.mediaDurationSeconds } : {}),
        ...(segment.linkedAudio !== undefined ? { linkedAudio: segment.linkedAudio } : {}),
        ...(segment.isEndFrame ? { isEndFrame: true } : {}),
      }
    }
    if (segment.type === 'text') {
      return {
        id: segment.id || `segment-${index + 1}`,
        type: 'text' as const,
        prompt: segment.prompt,
        startSeconds,
        durationSeconds: segment.durationSeconds,
        guideStrength: 0,
      }
    }
    throw new ApiError('INVALID_PARAMS', { code: 'STORYBOARD_DIRECTOR_SOURCE_REQUIRED' })
  }).sort((left, right) => left.startSeconds - right.startSeconds)
  let timelineCursor = 0
  const positionedSegments = normalizedSegments.map((segment) => {
    const startSeconds = Math.max(timelineCursor, segment.startSeconds)
    timelineCursor = startSeconds + segment.durationSeconds
    return { ...segment, startSeconds }
  })
  const normalizeUploadedTrack = <T extends { sourceMediaId: string; sourceType?: 'image' | 'video' }>(
    segments: T[],
    mediaType: 'video' | 'audio' | 'mixed',
  ) => segments.map((segment) => {
    const media = mediaById.get(segment.sourceMediaId)
    const expectedType = mediaType === 'mixed' ? (segment.sourceType ?? 'video') : mediaType
    const isEpisodeAudio = expectedType === 'audio'
      && media?.id === storyboard.episode.audioMediaId
    if (!media || !media.mimeType?.startsWith(`${expectedType}/`)
      || (!isEpisodeAudio && !isOwnedDirectorUploadStorageKey(media.storageKey, userId, projectId))) {
      throw new ApiError('INVALID_PARAMS', { code: 'STORYBOARD_DIRECTOR_SOURCE_INVALID' })
    }
    return { ...segment, sourceUrl: `/m/${encodeURIComponent(media.publicId)}` }
  })
  const motionSegments = normalizeUploadedTrack(parsed.motionSegments ?? [], 'mixed')
  const audioSegments = normalizeUploadedTrack(parsed.audioSegments ?? [], 'audio')
  let retakeVideoUrl: string | undefined
  if (parsed.retakeVideoMediaId) {
    const media = mediaById.get(parsed.retakeVideoMediaId)
    if (!media || !media.mimeType?.startsWith('video/')
      || !isOwnedDirectorUploadStorageKey(media.storageKey, userId, projectId)) {
      throw new ApiError('INVALID_PARAMS', { code: 'STORYBOARD_DIRECTOR_RETAKE_SOURCE_INVALID' })
    }
    retakeVideoUrl = `/m/${encodeURIComponent(media.publicId)}`
  }
  timelineCursor = [...motionSegments, ...audioSegments].reduce((latest, segment) => Math.max(
    latest,
    segment.startSeconds + segment.durationSeconds,
  ), timelineCursor)
  if (new Set(positionedSegments.map((segment) => segment.id)).size !== positionedSegments.length) {
    throw new ApiError('INVALID_PARAMS', { code: 'STORYBOARD_DIRECTOR_SEGMENT_ID_DUPLICATE' })
  }
  const firstSource = positionedSegments.find((segment) => segment.type !== 'text')
  const firstPanelId = firstSource && 'sourcePanelId' in firstSource
    ? firstSource.sourcePanelId
    : null
  const firstMediaId = firstSource && 'sourceMediaId' in firstSource
    ? firstSource.sourceMediaId
    : null
  const firstSourceDimensions = firstPanelId
    ? panelsById.get(firstPanelId)?.imageMedia
    : firstMediaId
      ? mediaById.get(firstMediaId)
      : null
  const fallbackAspectRatio = parsed.aspectRatio
    || storyboard.episode.novelPromotionProject.videoRatio
    || '16:9'
  const detectedAspectRatio = resolveLtxDirectorAspectRatioFromDimensions(
    firstSourceDimensions?.width,
    firstSourceDimensions?.height,
    fallbackAspectRatio,
  )
  const hasRangeStart = parsed.rangeStartSeconds !== undefined
  const hasRangeEnd = parsed.rangeEndSeconds !== undefined
  if (hasRangeStart !== hasRangeEnd
    || (hasRangeStart && hasRangeEnd && (
      parsed.rangeEndSeconds! <= parsed.rangeStartSeconds!
      || parsed.rangeEndSeconds! > timelineCursor
    ))) {
    throw new ApiError('INVALID_PARAMS', { code: 'STORYBOARD_DIRECTOR_RANGE_INVALID' })
  }
  return {
    ...parsed,
    version: LTX_DIRECTOR_TIMELINE_VERSION,
    aspectRatio: detectedAspectRatio,
    resolutionPreset: parsed.resolutionPreset || '720p',
    segments: positionedSegments,
    motionSegments,
    audioSegments,
    ...(retakeVideoUrl ? { retakeVideoUrl } : {}),
  }
}

async function resolveDirectorWorkflow(input: {
  projectId: string
  userId: string
  requestedModel: unknown
}) {
  let model = typeof input.requestedModel === 'string' ? input.requestedModel.trim() : ''
  if (!model) {
    const config = await getProjectModelConfig(input.projectId, input.userId)
    model = config.videoModel || ''
  }
  const parsed = parseModelKeyStrict(model)
  if (parsed?.provider !== 'comfyui') {
    throw new ApiError('INVALID_PARAMS', { code: 'STORYBOARD_DIRECTOR_MODEL_INVALID' })
  }
  const workflow = await prisma.comfyWorkflow.findFirst({
    where: {
      id: parsed.modelId,
      userId: input.userId,
      mediaType: 'video',
      status: 'published',
      currentVersionId: { not: null },
    },
    select: {
      id: true,
      mediaType: true,
      currentVersionId: true,
      currentVersion: {
        select: {
          id: true,
          purpose: true,
          publishedAt: true,
          contentHash: true,
          lastSuccessfulTestAt: true,
          apiFormatJson: true,
          lastTestConnection: { select: { userId: true } },
        },
      },
    },
  })
  if (!workflow || !isExecutableOwnedWorkflow(workflow, input.userId)
    || workflow.currentVersion?.purpose !== 'generation'
    || !hasLtxDirectorNode(workflow.currentVersion.apiFormatJson)) {
    throw new ApiError('INVALID_PARAMS', { code: 'STORYBOARD_DIRECTOR_MODEL_INVALID' })
  }
  return { model, workflowVersionId: workflow.currentVersion.id }
}

export const PUT = apiHandler(async (
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) => {
  const { projectId } = await context.params
  const authResult = await requireProjectAuthLight(projectId)
  if (isErrorResponse(authResult)) return authResult
  const body = await request.json().catch(() => null) as DirectorRequestBody | null
  const storyboardId = typeof body?.storyboardId === 'string' ? body.storyboardId : ''
  if (!storyboardId) throw new ApiError('INVALID_PARAMS', { code: 'STORYBOARD_DIRECTOR_REQUIRED' })
  const storyboard = await loadOwnedStoryboard(projectId, authResult.session.user.id, storyboardId)
  const timelineSpec = await normalizeTimelineSpec({
    value: body?.timelineSpec,
    storyboard,
    userId: authResult.session.user.id,
    projectId,
  })
  const { model } = await resolveDirectorWorkflow({
    projectId,
    userId: authResult.session.user.id,
    requestedModel: body?.videoModel ?? timelineSpec.videoModel,
  })
  const savedSpec = { ...timelineSpec, videoModel: model }
  await prisma.novelPromotionStoryboard.update({
    where: { id: storyboard.id },
    data: { directorConfigJson: mergeDirectorConfig(storyboard.directorConfigJson, 'ltx', savedSpec) },
  })
  return NextResponse.json({
    storyboardId: storyboard.id,
    directorConfigJson: mergeDirectorConfig(storyboard.directorConfigJson, 'ltx', savedSpec),
  })
})

export const POST = apiHandler(async (
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) => {
  const { projectId } = await context.params
  const authResult = await requireProjectAuthLight(projectId)
  if (isErrorResponse(authResult)) return authResult
  const { session } = authResult
  const body = await request.json().catch(() => null) as DirectorRequestBody | null
  const storyboardId = typeof body?.storyboardId === 'string' ? body.storyboardId : ''
  if (!storyboardId) throw new ApiError('INVALID_PARAMS', { code: 'STORYBOARD_DIRECTOR_REQUIRED' })
  const storyboard = await loadOwnedStoryboard(projectId, session.user.id, storyboardId)
  const timelineSpec = await normalizeTimelineSpec({
    value: body?.timelineSpec,
    storyboard,
    userId: session.user.id,
    projectId,
  })
  const { model, workflowVersionId } = await resolveDirectorWorkflow({
    projectId,
    userId: session.user.id,
    requestedModel: body?.videoModel ?? timelineSpec.videoModel,
  })
  const savedSpec = { ...timelineSpec, videoModel: model }
  const savedConfigJson = mergeDirectorConfig(storyboard.directorConfigJson, 'ltx', savedSpec)
  const savedStoryboard = await prisma.novelPromotionStoryboard.update({
    where: { id: storyboard.id },
    data: { directorConfigJson: savedConfigJson },
    select: { updatedAt: true },
  })
  const payload = withTaskUiPayload({
    videoModel: model,
    comfyWorkflowVersionId: workflowVersionId,
    comfyModelSnapshotVersion: 1,
    timelineSpec: savedSpec,
  }, { hasOutputAtStart: Boolean(storyboard.directorVideoMediaId) })
  const task = await submitTask({
    userId: session.user.id,
    locale: resolveRequiredTaskLocale(request, body),
    requestId: getRequestId(request),
    projectId,
    episodeId: storyboard.episodeId,
    type: TASK_TYPE.STORYBOARD_DIRECTOR_VIDEO,
    targetType: 'NovelPromotionStoryboard',
    targetId: storyboard.id,
    payload,
    dedupeKey: `storyboard_director:${storyboard.id}:${savedStoryboard.updatedAt.getTime()}`,
    billingInfo: null,
  })
  return NextResponse.json({ task, directorConfigJson: savedConfigJson })
})
