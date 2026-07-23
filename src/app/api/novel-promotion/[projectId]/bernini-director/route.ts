import { NextRequest, NextResponse } from 'next/server'

import { requireProjectAuthLight, isErrorResponse } from '@/lib/api-auth'
import { ApiError, apiHandler, getRequestId } from '@/lib/api-errors'
import {
  collectBerniniDirectorMediaOrders,
  parseBerniniDirectorSpec,
  type BerniniDirectorSpec,
} from '@/lib/comfyui/bernini-director'
import { hasBerniniDirectorNode } from '@/lib/comfyui/bernini-director-contract'
import { mergeDirectorConfig } from '@/lib/comfyui/director-config-envelope'
import { isExecutableOwnedWorkflow } from '@/lib/comfyui/workflow-model-option'
import { parseModelKeyStrict } from '@/lib/model-config-contract'
import { isOwnedDirectorUploadStorageKey } from '@/lib/novel-promotion/director-media'
import { prisma } from '@/lib/prisma'
import { submitTask } from '@/lib/task/submitter'
import { TASK_TYPE } from '@/lib/task/types'
import { withTaskUiPayload } from '@/lib/task/ui-payload'
import { resolveRequiredTaskLocale } from '@/lib/task/resolve-locale'

interface RequestBody {
  storyboardId?: unknown
  videoModel?: unknown
  directorSpec?: unknown
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
          storyboards: {
            select: {
              panels: { select: { id: true, imageMediaId: true } },
            },
          },
        },
      },
    },
  })
  if (!storyboard) throw new ApiError('NOT_FOUND')
  return storyboard
}

async function normalizeSpec(input: {
  value: unknown
  projectId: string
  userId: string
  storyboard: Awaited<ReturnType<typeof loadOwnedStoryboard>>
}): Promise<BerniniDirectorSpec> {
  const parsed = parseBerniniDirectorSpec(input.value)
  if (!parsed || parsed.segments.length > 8 || parsed.splitStep >= parsed.steps
    || (parsed.runSelectEnabled && parsed.runSelection.length === 0)) {
    throw new ApiError('INVALID_PARAMS', { code: 'BERNINI_DIRECTOR_CONFIG_INVALID' })
  }
  const panelById = new Map(input.storyboard.episode.storyboards
    .flatMap((storyboard) => storyboard.panels)
    .map((panel) => [panel.id, panel]))
  for (const segment of parsed.segments) {
    if (segment.sourcePanelId && !panelById.get(segment.sourcePanelId)?.imageMediaId) {
      throw new ApiError('INVALID_PARAMS', { code: 'BERNINI_DIRECTOR_SOURCE_INVALID' })
    }
  }
  const orders = collectBerniniDirectorMediaOrders(parsed)
  const panelMediaIds = orders.imageKeys.flatMap((key) => {
    if (!key.startsWith('panel:')) return []
    const mediaId = panelById.get(key.slice(6))?.imageMediaId
    return mediaId ? [mediaId] : []
  })
  const explicitImageIds = orders.imageKeys
    .filter((key) => key.startsWith('media:'))
    .map((key) => key.slice(6))
  const allMediaIds = [...new Set([...panelMediaIds, ...explicitImageIds, ...orders.videoMediaIds])]
  const media = allMediaIds.length === 0 ? [] : await prisma.mediaObject.findMany({
    where: { id: { in: allMediaIds } },
    select: { id: true, storageKey: true, mimeType: true },
  })
  const mediaById = new Map(media.map((item) => [item.id, item]))
  for (const id of [...panelMediaIds, ...explicitImageIds]) {
    const item = mediaById.get(id)
    if (!item?.mimeType?.startsWith('image/')) {
      throw new ApiError('INVALID_PARAMS', { code: 'BERNINI_DIRECTOR_IMAGE_INVALID' })
    }
    if (explicitImageIds.includes(id)
      && !isOwnedDirectorUploadStorageKey(item.storageKey, input.userId, input.projectId)) {
      throw new ApiError('INVALID_PARAMS', { code: 'BERNINI_DIRECTOR_IMAGE_INVALID' })
    }
  }
  for (const id of orders.videoMediaIds) {
    const item = mediaById.get(id)
    if (!item?.mimeType?.startsWith('video/')
      || !isOwnedDirectorUploadStorageKey(item.storageKey, input.userId, input.projectId)) {
      throw new ApiError('INVALID_PARAMS', { code: 'BERNINI_DIRECTOR_VIDEO_INVALID' })
    }
  }
  const needsSourceVideo = ['default', 'v2v', 'vi2v', 'rv2v', 'ads2v', 'vrc2v', 'mv2v']
    .includes(parsed.taskType)
  if (needsSourceVideo && !parsed.sourceVideoMediaId) {
    throw new ApiError('INVALID_PARAMS', { code: 'BERNINI_DIRECTOR_SOURCE_VIDEO_REQUIRED' })
  }
  if (parsed.taskType === 'ads2v' && !parsed.globalReferenceVideoMediaId
    && !parsed.segments.every((segment) => segment.referenceVideoMediaId)) {
    throw new ApiError('INVALID_PARAMS', { code: 'BERNINI_DIRECTOR_REFERENCE_VIDEO_REQUIRED' })
  }
  if (['i2i', 'i2v'].includes(parsed.taskType)
    && parsed.segments.some((segment) => !segment.sourcePanelId && !segment.sourceMediaId)) {
    throw new ApiError('INVALID_PARAMS', { code: 'BERNINI_DIRECTOR_SOURCE_IMAGE_REQUIRED' })
  }
  return parsed
}

async function resolveWorkflow(userId: string, requestedModel: unknown) {
  const model = typeof requestedModel === 'string' ? requestedModel.trim() : ''
  const parsed = parseModelKeyStrict(model)
  if (parsed?.provider !== 'comfyui') {
    throw new ApiError('INVALID_PARAMS', { code: 'BERNINI_DIRECTOR_MODEL_INVALID' })
  }
  const workflow = await prisma.comfyWorkflow.findFirst({
    where: {
      id: parsed.modelId,
      userId,
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
  if (!workflow || !isExecutableOwnedWorkflow(workflow, userId)
    || workflow.currentVersion?.purpose !== 'generation'
    || !hasBerniniDirectorNode(workflow.currentVersion.apiFormatJson)) {
    throw new ApiError('INVALID_PARAMS', { code: 'BERNINI_DIRECTOR_MODEL_INVALID' })
  }
  return { model, workflowVersionId: workflow.currentVersion.id }
}

async function prepare(request: NextRequest, projectId: string, body: RequestBody | null) {
  const auth = await requireProjectAuthLight(projectId)
  if (isErrorResponse(auth)) return auth
  const storyboardId = typeof body?.storyboardId === 'string' ? body.storyboardId : ''
  if (!storyboardId) throw new ApiError('INVALID_PARAMS', { code: 'BERNINI_DIRECTOR_REQUIRED' })
  const storyboard = await loadOwnedStoryboard(projectId, auth.session.user.id, storyboardId)
  const spec = await normalizeSpec({
    value: body?.directorSpec,
    projectId,
    userId: auth.session.user.id,
    storyboard,
  })
  const workflow = await resolveWorkflow(auth.session.user.id, body?.videoModel ?? spec.videoModel)
  return { auth, storyboard, spec: { ...spec, videoModel: workflow.model }, ...workflow }
}

export const PUT = apiHandler(async (request: NextRequest, context: { params: Promise<{ projectId: string }> }) => {
  const { projectId } = await context.params
  const body = await request.json().catch(() => null) as RequestBody | null
  const prepared = await prepare(request, projectId, body)
  if (prepared instanceof Response) return prepared
  const directorConfigJson = mergeDirectorConfig(
    prepared.storyboard.directorConfigJson, 'bernini', prepared.spec,
  )
  await prisma.novelPromotionStoryboard.update({
    where: { id: prepared.storyboard.id },
    data: { directorConfigJson },
  })
  return NextResponse.json({ storyboardId: prepared.storyboard.id, directorConfigJson })
})

export const POST = apiHandler(async (request: NextRequest, context: { params: Promise<{ projectId: string }> }) => {
  const { projectId } = await context.params
  const body = await request.json().catch(() => null) as RequestBody | null
  const prepared = await prepare(request, projectId, body)
  if (prepared instanceof Response) return prepared
  const directorConfigJson = mergeDirectorConfig(
    prepared.storyboard.directorConfigJson, 'bernini', prepared.spec,
  )
  const savedStoryboard = await prisma.novelPromotionStoryboard.update({
    where: { id: prepared.storyboard.id },
    data: { directorConfigJson },
    select: { updatedAt: true },
  })
  const task = await submitTask({
    userId: prepared.auth.session.user.id,
    locale: resolveRequiredTaskLocale(request, body),
    requestId: getRequestId(request),
    projectId,
    episodeId: prepared.storyboard.episodeId,
    type: TASK_TYPE.STORYBOARD_DIRECTOR_VIDEO,
    targetType: 'NovelPromotionStoryboard',
    targetId: prepared.storyboard.id,
    payload: withTaskUiPayload({
      directorEngine: 'bernini',
      videoModel: prepared.model,
      comfyWorkflowVersionId: prepared.workflowVersionId,
      comfyModelSnapshotVersion: 1,
      directorSpec: prepared.spec,
    }, { hasOutputAtStart: Boolean(prepared.storyboard.directorVideoMediaId) }),
    dedupeKey: `bernini_director:${prepared.storyboard.id}:${savedStoryboard.updatedAt.getTime()}`,
    billingInfo: null,
  })
  return NextResponse.json({ task, directorConfigJson })
})
