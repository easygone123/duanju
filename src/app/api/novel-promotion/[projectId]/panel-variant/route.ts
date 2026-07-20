import { NextRequest, NextResponse } from 'next/server'
import { requireProjectAuthLight, isErrorResponse } from '@/lib/api-auth'
import { apiHandler, ApiError, getRequestId } from '@/lib/api-errors'
import { buildDefaultTaskBillingInfo } from '@/lib/billing'
import { getProjectModelConfig, buildImageBillingPayload } from '@/lib/config-service'
import { prisma } from '@/lib/prisma'
import { submitTask } from '@/lib/task/submitter'
import { resolveRequiredTaskLocale } from '@/lib/task/resolve-locale'
import { TASK_TYPE } from '@/lib/task/types'
import { isGridStoryboardMode } from '@/lib/novel-promotion/grid-storyboard/spec'
import { detachVoiceLinesBeforePanelRemoval } from '@/lib/novel-promotion/narration/orphaning'

function createPanelVariantId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `panel-variant-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

async function rollbackCreatedVariantPanel(params: {
  panelId: string
  storyboardId: string
  panelIndex: number
}) {
  await prisma.$transaction(async (tx) => {
    await detachVoiceLinesBeforePanelRemoval({ tx, panelIds: [params.panelId] })
    await tx.novelPromotionPanel.delete({
      where: { id: params.panelId },
    })

    const maxPanel = await tx.novelPromotionPanel.findFirst({
      where: { storyboardId: params.storyboardId },
      orderBy: { panelIndex: 'desc' },
      select: { panelIndex: true },
    })
    const maxPanelIndex = maxPanel?.panelIndex ?? -1
    const offset = maxPanelIndex + 1000

    await tx.novelPromotionPanel.updateMany({
      where: {
        storyboardId: params.storyboardId,
        panelIndex: { gt: params.panelIndex },
      },
      data: {
        panelIndex: { increment: offset },
        panelNumber: { increment: offset },
      },
    })

    await tx.novelPromotionPanel.updateMany({
      where: {
        storyboardId: params.storyboardId,
        panelIndex: { gt: params.panelIndex + offset },
      },
      data: {
        panelIndex: { decrement: offset + 1 },
        panelNumber: { decrement: offset + 1 },
      },
    })

    const panelCount = await tx.novelPromotionPanel.count({
      where: { storyboardId: params.storyboardId },
    })

    await tx.novelPromotionStoryboard.update({
      where: { id: params.storyboardId },
      data: { panelCount },
    })
  })
}

export const POST = apiHandler(async (
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) => {
  const { projectId } = await context.params

  const authResult = await requireProjectAuthLight(projectId)
  if (isErrorResponse(authResult)) return authResult
  const { session } = authResult

  const body = await request.json()
  const locale = resolveRequiredTaskLocale(request, body)
  const storyboardId = body?.storyboardId
  const insertAfterPanelId = body?.insertAfterPanelId
  const sourcePanelId = body?.sourcePanelId
  const variant = body?.variant

  if (!storyboardId || !insertAfterPanelId || !sourcePanelId) {
    throw new ApiError('INVALID_PARAMS')
  }

  if (!variant || !variant.video_prompt) {
    throw new ApiError('INVALID_PARAMS')
  }

  const storyboard = await prisma.novelPromotionStoryboard.findUnique({
    where: { id: storyboardId },
    select: {
      id: true,
      layoutMode: true,
      episode: {
        select: {
          novelPromotionProject: {
            select: {
              projectId: true,
            },
          },
        },
      },
    },
  })
  if (!storyboard || storyboard.episode.novelPromotionProject.projectId !== projectId) {
    throw new ApiError('NOT_FOUND')
  }
  if (isGridStoryboardMode(storyboard.layoutMode)) {
    throw new ApiError('INVALID_PARAMS', { code: 'GRID_PANEL_COUNT_FIXED' })
  }

  const sourcePanel = await prisma.novelPromotionPanel.findUnique({ where: { id: sourcePanelId } })
  if (!sourcePanel || sourcePanel.storyboardId !== storyboardId) {
    throw new ApiError('INVALID_PARAMS')
  }

  const insertAfter = await prisma.novelPromotionPanel.findUnique({ where: { id: insertAfterPanelId } })
  if (!insertAfter || insertAfter.storyboardId !== storyboardId) {
    throw new ApiError('INVALID_PARAMS')
  }

  const projectModelConfig = await getProjectModelConfig(projectId, session.user.id)
  const imageModel = projectModelConfig.storyboardModel
  const createdPanelId = createPanelVariantId()

  let billingPayload: Record<string, unknown>
  try {
    billingPayload = await buildImageBillingPayload({
      projectId,
      userId: session.user.id,
      imageModel,
      projectModelConfig,
      basePayload: { ...body, newPanelId: createdPanelId },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Image model capability not configured'
    throw new ApiError('INVALID_PARAMS', {
      code: 'IMAGE_MODEL_CAPABILITY_NOT_CONFIGURED',
      message,
    })
  }

  const createdPanel = await prisma.$transaction(async (tx) => {
    const affectedPanels = await tx.novelPromotionPanel.findMany({
      where: { storyboardId, panelIndex: { gt: insertAfter.panelIndex } },
      select: { id: true, panelIndex: true },
      orderBy: { panelIndex: 'asc' },
    })

    for (const panel of affectedPanels) {
      await tx.novelPromotionPanel.update({
        where: { id: panel.id },
        data: { panelIndex: -(panel.panelIndex + 1) },
      })
    }

    for (const panel of affectedPanels) {
      await tx.novelPromotionPanel.update({
        where: { id: panel.id },
        data: { panelIndex: panel.panelIndex + 1 },
      })
    }

    const created = await tx.novelPromotionPanel.create({
      data: {
        id: createdPanelId,
        storyboardId,
        panelIndex: insertAfter.panelIndex + 1,
        panelNumber: insertAfter.panelIndex + 2,
        shotType: variant.shot_type || sourcePanel.shotType,
        cameraMove: variant.camera_move || sourcePanel.cameraMove,
        description: variant.description || sourcePanel.description,
        videoPrompt: variant.video_prompt || sourcePanel.videoPrompt,
        location: variant.location || sourcePanel.location,
        characters: variant.characters ? JSON.stringify(variant.characters) : sourcePanel.characters,
        srtSegment: sourcePanel.srtSegment,
        duration: sourcePanel.duration,
      },
    })

    const panelCount = await tx.novelPromotionPanel.count({
      where: { storyboardId },
    })

    await tx.novelPromotionStoryboard.update({
      where: { id: storyboardId },
      data: { panelCount },
    })

    return created
  })

  let result: Awaited<ReturnType<typeof submitTask>>
  try {
    result = await submitTask({
      userId: session.user.id,
      locale,
      requestId: getRequestId(request),
      projectId,
      type: TASK_TYPE.PANEL_VARIANT,
      targetType: 'NovelPromotionPanel',
      targetId: createdPanel.id,
      payload: billingPayload,
      dedupeKey: `panel_variant:${storyboardId}:${insertAfterPanelId}:${sourcePanelId}`,
      billingInfo: buildDefaultTaskBillingInfo(TASK_TYPE.PANEL_VARIANT, billingPayload),
    })
  } catch (error) {
    await rollbackCreatedVariantPanel({
      panelId: createdPanel.id,
      storyboardId,
      panelIndex: createdPanel.panelIndex,
    })
    throw error
  }

  return NextResponse.json({ ...result, panelId: createdPanel.id })
})
