import { NextRequest, NextResponse } from 'next/server'
import { requireProjectAuthLight, isErrorResponse } from '@/lib/api-auth'
import { apiHandler, ApiError, getRequestId } from '@/lib/api-errors'
import { submitTask } from '@/lib/task/submitter'
import { resolveRequiredTaskLocale } from '@/lib/task/resolve-locale'
import { TASK_TYPE } from '@/lib/task/types'
import { buildDefaultTaskBillingInfo } from '@/lib/billing'
import { getProjectModelConfig } from '@/lib/config-service'
import { prisma } from '@/lib/prisma'
import { isGridStoryboardMode } from '@/lib/novel-promotion/grid-storyboard/spec'

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

  if (!storyboardId) {
    throw new ApiError('INVALID_PARAMS')
  }

  const storyboard = await prisma.novelPromotionStoryboard.findUnique({
    where: { id: storyboardId },
    select: {
      layoutMode: true,
      episode: { select: { novelPromotionProject: { select: { projectId: true } } } },
    },
  })
  if (!storyboard || storyboard.episode.novelPromotionProject.projectId !== projectId) {
    throw new ApiError('NOT_FOUND')
  }
  if (isGridStoryboardMode(storyboard.layoutMode)) {
    throw new ApiError('INVALID_PARAMS', { code: 'GRID_PANEL_COUNT_FIXED' })
  }

  const projectModelConfig = await getProjectModelConfig(projectId, session.user.id)
  const billingPayload = { ...body, ...(projectModelConfig.analysisModel ? { analysisModel: projectModelConfig.analysisModel } : {}) }

  const result = await submitTask({
    userId: session.user.id,
    locale,
    requestId: getRequestId(request),
    projectId,
    type: TASK_TYPE.REGENERATE_STORYBOARD_TEXT,
    targetType: 'NovelPromotionStoryboard',
    targetId: storyboardId,
    payload: billingPayload,
    dedupeKey: `regenerate_storyboard_text:${storyboardId}`,
    billingInfo: buildDefaultTaskBillingInfo(TASK_TYPE.REGENERATE_STORYBOARD_TEXT, billingPayload)
  })

  return NextResponse.json(result)
})
