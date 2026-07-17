import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { apiHandler, ApiError, getRequestId } from '@/lib/api-errors'
import { isErrorResponse, requireProjectAuthLight } from '@/lib/api-auth'
import { submitTask } from '@/lib/task/submitter'
import { TASK_TYPE } from '@/lib/task/types'
import { resolveRequiredTaskLocale } from '@/lib/task/resolve-locale'
import { defaultGridCropRects, finalizeSnapshot, loadOwnedGridStoryboard, sourceForGridCrop } from '@/lib/novel-promotion/six-grid/image-task-route'
import type { SixGridImageTaskSnapshot } from '@/lib/workers/handlers/storyboard-sheet-task-handler'

const rect = z.object({ x: z.number().finite().min(0), y: z.number().finite().min(0), width: z.number().finite().positive(), height: z.number().finite().positive() }).strict()
  .refine((value) => value.x + value.width <= 1 && value.y + value.height <= 1, 'out of bounds')
const schema = z.object({ episodeId: z.string().trim().min(1).max(200), storyboardId: z.string().trim().min(1).max(200),
  cropRects: z.array(z.object({ cellIndex: z.number().int().min(0).max(5), normalizedCropRect: rect }).strict()).min(1).max(6).optional(),
  locale: z.string().max(20).optional(), meta: z.object({ locale: z.string().max(20).optional() }).strict().optional() }).strict()

export const POST = apiHandler(async (request: NextRequest, context: { params: Promise<{ projectId: string }> }) => {
  const { projectId } = await context.params
  const auth = await requireProjectAuthLight(projectId)
  if (isErrorResponse(auth)) return auth
  const parsed = schema.safeParse(await request.json())
  if (!parsed.success) throw new ApiError('INVALID_PARAMS', { code: 'SIX_GRID_CROP_PAYLOAD_INVALID', field: parsed.error.issues[0]?.path.join('.') || 'body' })
  const body = parsed.data
  const storyboard = await loadOwnedGridStoryboard({ userId: auth.session.user.id, projectId, episodeId: body.episodeId, storyboardId: body.storyboardId })
  const { order, media } = sourceForGridCrop(storyboard)
  const cropRectSource = body.cropRects ? 'manual' as const : 'auto' as const
  const cropRects = body.cropRects || defaultGridCropRects(storyboard.gridSpec)
  if (cropRects.length !== storyboard.gridSpec.panelCount
    || new Set(cropRects.map((item) => item.cellIndex)).size !== storyboard.gridSpec.panelCount
    || cropRects.some((item) => item.cellIndex < 0 || item.cellIndex >= storyboard.gridSpec.panelCount)) {
    throw new ApiError('INVALID_PARAMS', { code: 'SIX_GRID_CROP_INDEXES_INVALID', field: 'cropRects' })
  }
  const locale = resolveRequiredTaskLocale(request, body)
  const snapshot: SixGridImageTaskSnapshot = {
    operation: 'crop', projectId, episodeId: body.episodeId, storyboardId: storyboard.id, groupSequence: storyboard.groupSequence ?? 0,
    sourceMediaId: media.id, sourceChecksum: media.sha256 || `media:${media.id}`, sourceVersion: media.updatedAt.toISOString(),
    cellAspectRatio: storyboard.sixGridCellAspectRatio as '16:9' | '9:16', processingOrder: order,
    gridSpec: storyboard.gridSpec,
    expectedSheetArtifactVersion: storyboard.sheetArtifactVersion, cropRectSource, cropRects,
    promptSnapshot: storyboard.sheetPromptSnapshot || '', modelSnapshot: storyboard.sheetModelSnapshot || 'local:sharp', optionsSnapshot: {}, locale,
  }
  const { dedupeKey } = finalizeSnapshot(snapshot)
  const result = await submitTask({ userId: auth.session.user.id, locale, requestId: getRequestId(request), projectId, episodeId: body.episodeId,
    type: TASK_TYPE.STORYBOARD_SHEET_CROP, targetType: 'NovelPromotionStoryboard', targetId: storyboard.id, payload: snapshot, dedupeKey })
  return NextResponse.json(result)
})
