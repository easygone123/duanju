import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { apiHandler, ApiError, getRequestId } from '@/lib/api-errors'
import { isErrorResponse, requireProjectAuthLight } from '@/lib/api-auth'
import { submitTask } from '@/lib/task/submitter'
import { TASK_TYPE } from '@/lib/task/types'
import { resolveRequiredTaskLocale } from '@/lib/task/resolve-locale'
import { loadOwnedPublishedGenerationWorkflow, loadOwnedPublishedUpscaleWorkflow, loadOwnedSixGrid, finalizeSnapshot } from '@/lib/novel-promotion/six-grid/image-task-route'
import { resolveSheetAspectRatio, type SixGridImageTaskSnapshot } from '@/lib/workers/handlers/storyboard-sheet-task-handler'
import { resolveProjectImageTaskGenerationOptions } from '@/lib/config-service'
import { parseModelKeyStrict } from '@/lib/model-config-contract'

const schema = z.object({
  operation: z.enum(['generate', 'upscale']), episodeId: z.string().trim().min(1).max(200), storyboardId: z.string().trim().min(1).max(200),
  imageModel: z.string().trim().min(1).max(500).optional(), workflowId: z.string().trim().min(1).max(200).optional(), workflowVersionId: z.string().trim().min(1).max(200).optional(),
  prompt: z.string().max(50_000).optional(),
  locale: z.string().max(20).optional(), meta: z.object({ locale: z.string().max(20).optional() }).strict().optional(),
}).strict()

export const POST = apiHandler(async (request: NextRequest, context: { params: Promise<{ projectId: string }> }) => {
  const { projectId } = await context.params
  const auth = await requireProjectAuthLight(projectId)
  if (isErrorResponse(auth)) return auth
  const parsed = schema.safeParse(await request.json())
  if (!parsed.success) throw new ApiError('INVALID_PARAMS', { code: 'SIX_GRID_SHEET_PAYLOAD_INVALID', field: parsed.error.issues[0]?.path.join('.') || 'body' })
  const body = parsed.data
  const storyboard = await loadOwnedSixGrid({ userId: auth.session.user.id, projectId, episodeId: body.episodeId, storyboardId: body.storyboardId })
  const locale = resolveRequiredTaskLocale(request, body)
  const operation = body.operation === 'generate' ? 'generate' : 'sheet_upscale'
  let workflow: { workflow: { id: string }; version: { id: string } } | null = null
  if (operation === 'sheet_upscale') {
    if (!body.workflowId || !body.workflowVersionId) throw new ApiError('INVALID_PARAMS', { code: 'UPSCALE_WORKFLOW_REQUIRED', field: 'workflowId' })
    if (!storyboard.sheetImageMedia) throw new ApiError('INVALID_PARAMS', { code: 'SHEET_IMAGE_REQUIRED', field: 'storyboardId' })
    workflow = await loadOwnedPublishedUpscaleWorkflow({ userId: auth.session.user.id, workflowId: body.workflowId, workflowVersionId: body.workflowVersionId })
  }
  const model = operation === 'generate' ? (body.imageModel || storyboard.sheetModelSnapshot) : `comfyui::${workflow!.workflow.id}`
  const prompt = body.prompt ?? storyboard.sheetPromptSnapshot
  if (!model || !prompt) throw new ApiError('INVALID_PARAMS', { code: 'SIX_GRID_SHEET_SNAPSHOT_MISSING' })
  const parsedModel = parseModelKeyStrict(model)
  if (operation === 'generate' && parsedModel?.provider === 'comfyui') {
    workflow = await loadOwnedPublishedGenerationWorkflow({ userId: auth.session.user.id, workflowId: parsedModel.modelId })
  }
  const source = operation === 'sheet_upscale' ? storyboard.sheetImageMedia! : null
  const sheetAspectRatio = resolveSheetAspectRatio(storyboard.sixGridCellAspectRatio as '16:9' | '9:16')
  let resolvedGenerationOptions: Record<string, string | number | boolean> = { aspectRatio: sheetAspectRatio }
  if (operation === 'generate') {
    try {
      resolvedGenerationOptions = await resolveProjectImageTaskGenerationOptions({
        projectId, userId: auth.session.user.id, imageModel: model,
        taskSelections: { aspectRatio: sheetAspectRatio },
        comfyWorkflowVersionId: workflow?.version.id,
      })
    } catch (error) {
      throw new ApiError('INVALID_PARAMS', { code: 'SIX_GRID_SHEET_RATIO_UNSUPPORTED', field: 'generationOptions.aspectRatio', details: { message: error instanceof Error ? error.message : String(error) } })
    }
  }
  const snapshot: SixGridImageTaskSnapshot = {
    operation, projectId, episodeId: body.episodeId, storyboardId: storyboard.id, groupSequence: storyboard.groupSequence ?? 0,
    ...(source ? { sourceMediaId: source.id, sourceChecksum: source.sha256 || `media:${source.id}`, sourceVersion: source.updatedAt.toISOString() } : {}),
    ...(workflow ? { workflowId: workflow.workflow.id, workflowVersionId: workflow.version.id, workflowPurpose: operation === 'generate' ? 'generation' as const : 'upscale' as const } : {}),
    cellAspectRatio: storyboard.sixGridCellAspectRatio as '16:9' | '9:16', processingOrder: storyboard.sixGridProcessingOrder as SixGridImageTaskSnapshot['processingOrder'],
    expectedSheetArtifactVersion: storyboard.sheetArtifactVersion, promptSnapshot: prompt, modelSnapshot: model,
    optionsSnapshot: operation === 'generate' ? resolvedGenerationOptions : {}, locale,
    imageModel: model, generationOptions: operation === 'generate' ? resolvedGenerationOptions : {},
    ...(workflow ? { comfyWorkflowVersionId: workflow.version.id, comfyModelSnapshotVersion: 1 as const } : {}),
  }
  const { dedupeKey } = finalizeSnapshot(snapshot)
  const type = operation === 'generate' ? TASK_TYPE.STORYBOARD_SHEET_GENERATE : TASK_TYPE.STORYBOARD_SHEET_UPSCALE
  const result = await submitTask({ userId: auth.session.user.id, locale, requestId: getRequestId(request), projectId, episodeId: body.episodeId,
    type, targetType: 'NovelPromotionStoryboard', targetId: storyboard.id,
    payload: snapshot, dedupeKey })
  return NextResponse.json(result)
})
