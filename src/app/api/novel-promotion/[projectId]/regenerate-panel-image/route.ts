import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireProjectAuthLight, isErrorResponse } from '@/lib/api-auth'
import { apiHandler, ApiError, getRequestId } from '@/lib/api-errors'
import { submitTask } from '@/lib/task/submitter'
import { resolveRequiredTaskLocale } from '@/lib/task/resolve-locale'
import { TASK_TYPE } from '@/lib/task/types'
import { buildDefaultTaskBillingInfo } from '@/lib/billing'
import { hasPanelImageOutput } from '@/lib/task/has-output'
import { withTaskUiPayload } from '@/lib/task/ui-payload'
import { buildImageBillingPayload, getProjectModelConfig } from '@/lib/config-service'
import { resolveModelSelection } from '@/lib/api-config'

const DEFAULT_CANDIDATE_COUNT = 1
const generationOptionsSchema = z.object({
  resolution: z.string().trim().min(1).max(64).optional(),
  aspectRatio: z.string().trim().regex(/^[1-9]\d{0,2}:[1-9]\d{0,2}$/).optional(),
}).strict()
const requestSchema = z.object({
  panelId: z.string().trim().min(1).max(200),
  count: z.number().int().min(1).max(4).optional(),
  imageModel: z.string().trim().min(1).max(500).optional(),
  generationOptions: generationOptionsSchema.optional(),
  locale: z.string().max(20).optional(),
  meta: z.object({ locale: z.string().max(20).optional() }).strict().optional(),
}).strict()

export const POST = apiHandler(async (
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) => {
  const { projectId } = await context.params

  const authResult = await requireProjectAuthLight(projectId)
  if (isErrorResponse(authResult)) return authResult
  const { session } = authResult

  const parsedBody = requestSchema.safeParse(await request.json())
  if (!parsedBody.success) throw new ApiError('INVALID_PARAMS', {
    code: 'PANEL_IMAGE_PAYLOAD_INVALID',
    field: parsedBody.error.issues[0]?.path.join('.') || 'body',
  })
  const body = parsedBody.data
  const locale = resolveRequiredTaskLocale(request, body)
  const panelId = body.panelId
  const count = body.count
  const candidateCount = Math.max(1, Math.min(4, Number(count ?? DEFAULT_CANDIDATE_COUNT)))

  const requestedImageModel = body.imageModel
  const projectModelConfig = await getProjectModelConfig(projectId, session.user.id, {
    imageModel: requestedImageModel,
  })
  if (!projectModelConfig.storyboardModel) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'STORYBOARD_MODEL_NOT_CONFIGURED'})
  }
  try {
    await resolveModelSelection(session.user.id, projectModelConfig.storyboardModel, 'image')
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Storyboard image model is invalid'
    throw new ApiError('INVALID_PARAMS', {
      code: 'STORYBOARD_MODEL_INVALID',
      message})
  }

  let billingPayload: Record<string, unknown>
  try {
    billingPayload = await buildImageBillingPayload({
      projectId,
      userId: session.user.id,
      imageModel: projectModelConfig.storyboardModel,
      projectModelConfig,
      taskSelections: body.generationOptions,
      basePayload: { ...body, candidateCount },
    })
  } catch (error) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'IMAGE_CAPABILITY_COMBINATION_UNSUPPORTED',
      field: 'generationOptions',
      details: { message: error instanceof Error ? error.message : String(error) },
    })
  }

  const hasOutputAtStart = await hasPanelImageOutput(panelId)

  const result = await submitTask({
    userId: session.user.id,
    locale,
    requestId: getRequestId(request),
    projectId,
    type: TASK_TYPE.IMAGE_PANEL,
    targetType: 'NovelPromotionPanel',
    targetId: panelId,
    payload: withTaskUiPayload(billingPayload, {
      intent: 'regenerate',
      hasOutputAtStart}),
    dedupeKey: `image_panel:${panelId}:${candidateCount}`,
    billingInfo: buildDefaultTaskBillingInfo(TASK_TYPE.IMAGE_PANEL, billingPayload)})

  return NextResponse.json(result)
})
