import { NextRequest, NextResponse } from 'next/server'

import { requireProjectAuthLight, isErrorResponse } from '@/lib/api-auth'
import { ApiError, apiHandler, getRequestId } from '@/lib/api-errors'
import { getProjectModelConfig } from '@/lib/config-service'
import {
  LTX_DIRECTOR_TIMELINE_VERSION,
  parseLtxDirectorTimelineSpec,
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
          storyboards: {
            orderBy: [{ groupSequence: 'asc' }, { createdAt: 'asc' }],
            select: {
              panels: {
                orderBy: { panelIndex: 'asc' },
                select: { id: true, imageUrl: true },
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
  const mediaIds = [...new Set(parsed.segments.flatMap((segment) => (
    segment.sourceMediaId ? [segment.sourceMediaId] : []
  )))]
  const uploadedMedia = mediaIds.length === 0 ? [] : await prisma.mediaObject.findMany({
    where: { id: { in: mediaIds } },
    select: { id: true, publicId: true, storageKey: true, mimeType: true },
  })
  const mediaById = new Map(uploadedMedia.map((media) => [media.id, media]))
  const normalizedSegments = parsed.segments.map((segment, index) => {
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
        durationSeconds: segment.durationSeconds,
        guideStrength: segment.guideStrength ?? 1,
        ...(segment.isEndFrame ? { isEndFrame: true } : {}),
      }
    }
    throw new ApiError('INVALID_PARAMS', { code: 'STORYBOARD_DIRECTOR_SOURCE_REQUIRED' })
  })
  if (new Set(normalizedSegments.map((segment) => segment.id)).size !== normalizedSegments.length) {
    throw new ApiError('INVALID_PARAMS', { code: 'STORYBOARD_DIRECTOR_SEGMENT_ID_DUPLICATE' })
  }
  return {
    ...parsed,
    version: LTX_DIRECTOR_TIMELINE_VERSION,
    segments: normalizedSegments,
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
