import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { apiHandler, ApiError, getRequestId } from '@/lib/api-errors'
import { isErrorResponse, requireProjectAuthLight } from '@/lib/api-auth'
import { submitTask } from '@/lib/task/submitter'
import { TASK_TYPE } from '@/lib/task/types'
import { resolveRequiredTaskLocale } from '@/lib/task/resolve-locale'
import { finalizeSnapshot, loadOwnedPublishedUpscaleWorkflow, loadOwnedSixGrid } from '@/lib/novel-promotion/six-grid/image-task-route'
import type { SixGridImageTaskSnapshot } from '@/lib/workers/handlers/storyboard-sheet-task-handler'

const schema = z.object({ episodeId: z.string().trim().min(1).max(200), storyboardId: z.string().trim().min(1).max(200), panelId: z.string().trim().min(1).max(200),
  workflowId: z.string().trim().min(1).max(200), workflowVersionId: z.string().trim().min(1).max(200), generationOptions: z.object({ resolution: z.string().trim().min(1).max(64).optional() }).strict().optional(),
  locale: z.string().max(20).optional(), meta: z.object({ locale: z.string().max(20).optional() }).strict().optional() }).strict()

export const POST = apiHandler(async (request: NextRequest, context: { params: Promise<{ projectId: string }> }) => {
  const { projectId } = await context.params
  const auth = await requireProjectAuthLight(projectId)
  if (isErrorResponse(auth)) return auth
  const parsed = schema.safeParse(await request.json())
  if (!parsed.success) throw new ApiError('INVALID_PARAMS', { code: 'SIX_GRID_PANEL_UPSCALE_PAYLOAD_INVALID', field: parsed.error.issues[0]?.path.join('.') || 'body' })
  const body = parsed.data
  const storyboard = await loadOwnedSixGrid({ userId: auth.session.user.id, projectId, episodeId: body.episodeId, storyboardId: body.storyboardId })
  const panel = storyboard.panels.find((item) => item.id === body.panelId)
  if (!panel) throw new ApiError('NOT_FOUND')
  if (!panel.croppedImageMediaId || panel.imageMediaId !== panel.croppedImageMediaId || !panel.imageMedia) throw new ApiError('INVALID_PARAMS', { code: 'PANEL_CROP_SOURCE_REQUIRED', field: 'panelId' })
  const workflow = await loadOwnedPublishedUpscaleWorkflow({ userId: auth.session.user.id, workflowId: body.workflowId, workflowVersionId: body.workflowVersionId })
  const locale = resolveRequiredTaskLocale(request, body)
  const source = panel.imageMedia
  const snapshot: SixGridImageTaskSnapshot = {
    operation: 'panel_upscale', projectId, episodeId: body.episodeId, storyboardId: storyboard.id, groupSequence: storyboard.groupSequence ?? 0, panelId: panel.id,
    sourceMediaId: source.id, sourceChecksum: source.sha256 || `media:${source.id}`, sourceVersion: source.updatedAt.toISOString(),
    workflowId: workflow.workflow.id, workflowVersionId: workflow.version.id, workflowPurpose: 'upscale',
    cellAspectRatio: storyboard.sixGridCellAspectRatio as '16:9' | '9:16', processingOrder: storyboard.sixGridProcessingOrder as SixGridImageTaskSnapshot['processingOrder'],
    expectedSheetArtifactVersion: storyboard.sheetArtifactVersion, promptSnapshot: '', modelSnapshot: `comfyui::${workflow.workflow.id}`,
    optionsSnapshot: body.generationOptions || {}, locale,
  }
  const { dedupeKey } = finalizeSnapshot(snapshot)
  const result = await submitTask({ userId: auth.session.user.id, locale, requestId: getRequestId(request), projectId, episodeId: body.episodeId,
    type: TASK_TYPE.STORYBOARD_PANEL_UPSCALE, targetType: 'NovelPromotionPanel', targetId: panel.id, payload: snapshot, dedupeKey })
  return NextResponse.json(result)
})
