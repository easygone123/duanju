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
      panels: {
        orderBy: { panelIndex: 'asc' },
        select: { id: true, imageUrl: true },
      },
    },
  })
  if (!storyboard) throw new ApiError('NOT_FOUND')
  if (storyboard.panels.length === 0 || storyboard.panels.length > 8
    || storyboard.panels.some((panel) => !panel.imageUrl)) {
    throw new ApiError('INVALID_PARAMS', { code: 'STORYBOARD_DIRECTOR_IMAGES_INVALID' })
  }
  return storyboard
}

function normalizeTimelineSpec(value: unknown, panelIds: string[]): LtxDirectorTimelineSpec {
  const parsed = parseLtxDirectorTimelineSpec(value)
  if (!parsed || parsed.segments.length !== panelIds.length || parsed.fps > 240
    || parsed.segments.some((segment) => segment.durationSeconds > 60)) {
    throw new ApiError('INVALID_PARAMS', { code: 'STORYBOARD_DIRECTOR_CONFIG_INVALID' })
  }
  const segmentPanelIds = parsed.segments.map((segment) => segment.panelId).filter(Boolean)
  if (segmentPanelIds.length > 0
    && (segmentPanelIds.length !== panelIds.length
      || segmentPanelIds.some((panelId, index) => panelId !== panelIds[index]))) {
    throw new ApiError('INVALID_PARAMS', { code: 'STORYBOARD_DIRECTOR_PANELS_CHANGED' })
  }
  return {
    ...parsed,
    version: LTX_DIRECTOR_TIMELINE_VERSION,
    segments: parsed.segments.map((segment, index) => ({
      ...segment,
      panelId: panelIds[index],
    })),
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
  const timelineSpec = normalizeTimelineSpec(body?.timelineSpec, storyboard.panels.map((panel) => panel.id))
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
  const timelineSpec = normalizeTimelineSpec(body?.timelineSpec, storyboard.panels.map((panel) => panel.id))
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
