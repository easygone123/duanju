import { NextRequest, NextResponse } from 'next/server'

import { isErrorResponse, requireProjectAuthLight } from '@/lib/api-auth'
import { ApiError, apiHandler } from '@/lib/api-errors'
import {
  externalStoryboardImportSchema,
  importExternalGridStoryboards,
} from '@/lib/novel-promotion/external-storyboard-import'

/**
 * Import storyboard planning produced by an external analysis model. The
 * imported groups intentionally contain no generated media; the normal grid
 * upload route remains the only way to attach and crop a finished 2x2 or 3x2
 * sheet.
 */
export const POST = apiHandler(async (
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) => {
  const { projectId } = await context.params
  const auth = await requireProjectAuthLight(projectId)
  if (isErrorResponse(auth)) return auth

  const parsed = externalStoryboardImportSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'GRID_IMPORT_PAYLOAD_INVALID',
      field: parsed.error.issues[0]?.path.join('.') || 'body',
    })
  }
  const imported = await importExternalGridStoryboards({
    userId: auth.session.user.id,
    projectId,
    data: parsed.data,
  })

  return NextResponse.json({ success: true, ...imported })
})
