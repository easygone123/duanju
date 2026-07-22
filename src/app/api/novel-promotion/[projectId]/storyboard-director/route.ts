import { NextRequest, NextResponse } from 'next/server'

import { requireProjectAuthLight, isErrorResponse } from '@/lib/api-auth'
import { ApiError, apiHandler, getRequestId } from '@/lib/api-errors'
import { getProjectModelConfig, resolveProjectComfyWorkflowVersion } from '@/lib/config-service'
import { hasLtxDirectorNode } from '@/lib/comfyui/ltx-director-contract'
import { parseModelKeyStrict } from '@/lib/model-config-contract'
import { prisma } from '@/lib/prisma'
import { submitTask } from '@/lib/task/submitter'
import { TASK_TYPE } from '@/lib/task/types'
import { withTaskUiPayload } from '@/lib/task/ui-payload'
import { resolveRequiredTaskLocale } from '@/lib/task/resolve-locale'

export const POST = apiHandler(async (
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) => {
  const { projectId } = await context.params
  const authResult = await requireProjectAuthLight(projectId)
  if (isErrorResponse(authResult)) return authResult
  const { session } = authResult
  const body = await request.json().catch(() => null) as { storyboardId?: unknown; fps?: unknown } | null
  const storyboardId = typeof body?.storyboardId === 'string' ? body.storyboardId : ''
  if (!storyboardId) throw new ApiError('INVALID_PARAMS', { code: 'STORYBOARD_DIRECTOR_REQUIRED' })

  const storyboard = await prisma.novelPromotionStoryboard.findFirst({
    where: {
      id: storyboardId,
      episode: { novelPromotionProject: { projectId, project: { userId: session.user.id } } },
    },
    select: {
      id: true,
      episodeId: true,
      updatedAt: true,
      directorVideoMediaId: true,
      panels: { orderBy: { panelIndex: 'asc' }, select: { imageUrl: true } },
    },
  })
  if (!storyboard) throw new ApiError('NOT_FOUND')
  if (storyboard.panels.length === 0 || storyboard.panels.length > 8
    || storyboard.panels.some((panel) => !panel.imageUrl)) {
    throw new ApiError('INVALID_PARAMS', { code: 'STORYBOARD_DIRECTOR_IMAGES_INVALID' })
  }
  const config = await getProjectModelConfig(projectId, session.user.id)
  const model = config.videoModel
  const parsed = parseModelKeyStrict(model)
  if (!model || parsed?.provider !== 'comfyui') {
    throw new ApiError('INVALID_PARAMS', { code: 'STORYBOARD_DIRECTOR_MODEL_INVALID' })
  }
  const workflowVersionId = resolveProjectComfyWorkflowVersion(config, model, 'video')
  if (!workflowVersionId) {
    throw new ApiError('INVALID_PARAMS', { code: 'STORYBOARD_DIRECTOR_MODEL_INVALID' })
  }
  const version = await prisma.comfyWorkflowVersion.findFirst({
    where: {
      id: workflowVersionId,
      workflowId: parsed.modelId,
      publishedAt: { not: null },
      lastSuccessfulTestAt: { not: null },
      workflow: { userId: session.user.id, mediaType: 'video', status: 'published' },
    },
    select: { apiFormatJson: true },
  })
  if (!version || !hasLtxDirectorNode(version.apiFormatJson)) {
    throw new ApiError('INVALID_PARAMS', { code: 'STORYBOARD_DIRECTOR_NODE_REQUIRED' })
  }
  const fps = typeof body?.fps === 'number' && Number.isFinite(body.fps)
    && body.fps >= 1 && body.fps <= 240 ? body.fps : 24
  const payload = withTaskUiPayload({
    videoModel: model,
    comfyWorkflowVersionId: workflowVersionId,
    comfyModelSnapshotVersion: 1,
    fps,
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
    dedupeKey: `storyboard_director:${storyboard.id}:${storyboard.updatedAt.getTime()}`,
    billingInfo: null,
  })
  return NextResponse.json({ task })
})
