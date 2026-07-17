import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { isErrorResponse, requireProjectAuthLight } from '@/lib/api-auth'
import { apiHandler, ApiError, getRequestId } from '@/lib/api-errors'
import { createScopedLogger } from '@/lib/logging/core'
import { ensureMediaObjectFromStorageKey } from '@/lib/media/service'
import type { SixGridCellAspectRatio } from '@/lib/novel-promotion/six-grid/contracts'
import { loadOwnedSixGrid } from '@/lib/novel-promotion/six-grid/image-task-route'
import {
  SIX_GRID_UPLOAD_MAX_BYTES,
  SixGridUploadError,
} from '@/lib/novel-promotion/six-grid/upload-contract'
import {
  assertSixGridUploadAvailable,
  replaceSixGridSheet,
} from '@/lib/novel-promotion/six-grid/upload-service'
import { validateAndNormalizeSixGridUpload } from '@/lib/novel-promotion/six-grid/upload-validation'
import { uploadObject } from '@/lib/storage'

// Allows multipart field names, boundaries, and metadata without weakening the
// exact decoded file-size limit enforced after parsing.
const MULTIPART_ENVELOPE_ALLOWANCE_BYTES = 256 * 1024

const metadataSchema = z.object({
  episodeId: z.string().trim().min(1).max(200),
  storyboardId: z.string().trim().min(1).max(200),
  expectedSheetArtifactVersion: z.preprocess(
    (value) => typeof value === 'string' && value.trim().length === 0 ? undefined : value,
    z.coerce.number().int().nonnegative().refine(Number.isSafeInteger),
  ),
}).strict()

const uploadFields = [
  'file',
  'episodeId',
  'storyboardId',
  'expectedSheetArtifactVersion',
] as const

type UploadField = typeof uploadFields[number]

function invalidPayload(field: string): never {
  throw new ApiError('INVALID_PARAMS', {
    code: 'SIX_GRID_UPLOAD_PAYLOAD_INVALID',
    field,
  })
}

function hasMultipartBoundary(contentType: string | null): boolean {
  if (!contentType) return false
  const segments = contentType.split(';').map((segment) => segment.trim())
  if (segments[0]?.toLowerCase() !== 'multipart/form-data') return false

  const boundarySegments = segments.slice(1).filter((segment) => (
    segment.slice(0, segment.indexOf('=')).trim().toLowerCase() === 'boundary'
  ))
  if (boundarySegments.length !== 1) return false

  const boundarySegment = boundarySegments[0]
  const equalsIndex = boundarySegment.indexOf('=')
  const boundary = boundarySegment.slice(equalsIndex + 1).trim()
  if (!boundary) return false
  if (boundary.startsWith('"')) {
    return boundary.length > 2 && boundary.endsWith('"') && !boundary.slice(1, -1).includes('"')
  }
  return !/[\s"]/.test(boundary)
}

function assertMultipartPreflight(request: NextRequest): void {
  if (!hasMultipartBoundary(request.headers.get('content-type'))) invalidPayload('body')

  const rawContentLength = request.headers.get('content-length')
  if (rawContentLength === null || !/^\d+$/.test(rawContentLength)) {
    invalidPayload('content-length')
  }
  const contentLength = Number(rawContentLength)
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
    invalidPayload('content-length')
  }
  if (contentLength > SIX_GRID_UPLOAD_MAX_BYTES + MULTIPART_ENVELOPE_ALLOWANCE_BYTES) {
    throw new ApiError('INVALID_PARAMS', {
      code: 'SIX_GRID_UPLOAD_TOO_LARGE',
      field: 'content-length',
    })
  }
}

function mapSixGridUploadError(error: SixGridUploadError): ApiError {
  return new ApiError('INVALID_PARAMS', {
    code: error.code,
    field: 'file',
    ...(Object.keys(error.details).length > 0 ? { details: error.details } : {}),
  })
}

function logUnexpectedUploadError(input: {
  request: NextRequest
  projectId: string
  userId?: string
}): void {
  createScopedLogger({
    module: 'api.novel-promotion.six-grid-upload',
    action: 'six_grid.upload.internal_error',
    requestId: getRequestId(input.request),
    projectId: input.projectId,
    userId: input.userId,
  }).error({
    message: 'six-grid sheet upload failed',
    errorCode: 'INTERNAL_ERROR',
    error: { name: 'UnexpectedUploadError' },
  })
}

function singleFormValue(formData: FormData, field: UploadField): FormDataEntryValue {
  const values = formData.getAll(field)
  if (values.length !== 1) invalidPayload(field)
  return values[0]
}

async function parseUploadForm(request: NextRequest) {
  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    invalidPayload('body')
  }

  for (const field of formData.keys()) {
    if (!(uploadFields as readonly string[]).includes(field)) invalidPayload(field)
  }

  const file = singleFormValue(formData, 'file')
  if (!(file instanceof File)) invalidPayload('file')

  const metadata = metadataSchema.safeParse({
    episodeId: singleFormValue(formData, 'episodeId'),
    storyboardId: singleFormValue(formData, 'storyboardId'),
    expectedSheetArtifactVersion: singleFormValue(formData, 'expectedSheetArtifactVersion'),
  })
  if (!metadata.success) {
    invalidPayload(metadata.error.issues[0]?.path.join('.') || 'body')
  }

  return { file, ...metadata.data }
}

function scopedUploadKey(userId: string, projectId: string): string {
  return [
    'images',
    'six-grid',
    'uploads',
    encodeURIComponent(userId),
    encodeURIComponent(projectId),
    `${randomUUID()}.webp`,
  ].join('/')
}

export const POST = apiHandler(async (
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) => {
  const { projectId } = await context.params
  let userId: string | undefined
  try {
    const auth = await requireProjectAuthLight(projectId)
    if (isErrorResponse(auth)) return auth
    userId = auth.session.user.id

    assertMultipartPreflight(request)
    const payload = await parseUploadForm(request)
    if (payload.file.size > SIX_GRID_UPLOAD_MAX_BYTES) {
      throw new ApiError('INVALID_PARAMS', {
        code: 'SIX_GRID_UPLOAD_TOO_LARGE',
        field: 'file',
      })
    }

    const identity = {
      userId,
      projectId,
      episodeId: payload.episodeId,
      storyboardId: payload.storyboardId,
    }
    const storyboard = await loadOwnedSixGrid(identity)
    await assertSixGridUploadAvailable(identity)

    const source = Buffer.from(await payload.file.arrayBuffer())
    const normalized = await validateAndNormalizeSixGridUpload(
      source,
      storyboard.sixGridCellAspectRatio as SixGridCellAspectRatio,
    )

    const key = scopedUploadKey(identity.userId, projectId)
    await uploadObject(normalized.bytes, key, 1, 'image/webp')
    const media = await ensureMediaObjectFromStorageKey(key, {
      mimeType: 'image/webp',
      sizeBytes: normalized.sizeBytes,
      width: normalized.width,
      height: normalized.height,
    })
    const replacement = await replaceSixGridSheet({
      ...identity,
      expectedSheetArtifactVersion: payload.expectedSheetArtifactVersion,
      media: { id: media.id, url: media.url },
    })

    return NextResponse.json({
      sheetImageMediaId: replacement.mediaId,
      sheetImageUrl: replacement.url,
      width: normalized.width,
      height: normalized.height,
      sheetArtifactVersion: replacement.sheetArtifactVersion,
    })
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (error instanceof SixGridUploadError) throw mapSixGridUploadError(error)
    logUnexpectedUploadError({ request, projectId, userId })
    throw new ApiError('INTERNAL_ERROR')
  }
})
