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
      episode: {
        select: {
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
  if (!parsed || parsed.segments.length === 0 || parsed.segments.length > 8 || parsed.fps > 240
    || parsed.segments.some((segment) => segment.durationSeconds > 60)) {
    throw new ApiError('INVALID_PARAMS', { code: 'STORYBOARD_DIRECTOR_CONFIG_INVALID' })
  }
  if ((parsed.motionSegments?.length ?? 0) > 8 || (parsed.audioSegments?.length ?? 0) > 8
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
      const panel = panelsById.get(sourcePanelId)
      if (!panel?.imageUrl) {
        throw new ApiError('INVALID_PARAMS', { code: 'STORYBOARD_DIRECTOR_SOURCE_INVALID' })
      }
      return {
        id: segment.id || `segment-${index + 1}`,
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
      if (!media || !media.mimeType?.startsWith('image/')
        || !isOwnedDirectorUploadStorageKey(media.storageKey, userId, projectId)) {
        throw new ApiError('INVALID_PARAMS', { code: 'STORYBOARD_DIRECTOR_SOURCE_INVALID' })
      }
      return {
        id: segment.id || `segment-${index + 1}`,
        sourceMediaId: media.id,
        sourceImageUrl: `/m/${encodeURIComponent(media.publicId)}`,
        prompt: segment.prompt,
        startSeconds,
        durationSeconds: segment.durationSeconds,
        guideStrength: segment.guideStrength ?? 1,
        ...(segment.isEndFrame ? { isEndFrame: true } : {}),
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
  const normalizeUploadedTrack = <T extends { sourceMediaId: string }>(
    segments: T[],
    mediaType: 'video' | 'audio',
  ) => segments.map((segment) => {
    const media = mediaById.get(segment.sourceMediaId)
    if (!media || !media.mimeType?.startsWith(`${mediaType}/`)
      || !isOwnedDirectorUploadStorageKey(media.storageKey, userId, projectId)) {
      throw new ApiError('INVALID_PARAMS', { code: 'STORYBOARD_DIRECTOR_SOURCE_INVALID' })
    }
    return { ...segment, sourceUrl: `/m/${encodeURIComponent(media.publicId)}` }
  })
  const motionSegments = normalizeUploadedTrack(parsed.motionSegments ?? [], 'video')
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
  const firstSource = positionedSegments[0]
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
    data: { directorConfigJson: JSON.stringify(savedSpec) },
  })
  return NextResponse.json({ storyboardId: storyboard.id, directorConfigJson: JSON.stringify(savedSpec) })
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
  const savedConfigJson = JSON.stringify(savedSpec)
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
