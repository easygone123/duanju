import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import sharp from 'sharp'

import { requireProjectAuthLight, isErrorResponse } from '@/lib/api-auth'
import { ApiError, apiHandler } from '@/lib/api-errors'
import { ensureMediaObjectFromStorageKey } from '@/lib/media/service'
import { directorUploadPrefix } from '@/lib/novel-promotion/director-media'
import { uploadObject } from '@/lib/storage'

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

export const POST = apiHandler(async (
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) => {
  const { projectId } = await context.params
  const auth = await requireProjectAuthLight(projectId)
  if (isErrorResponse(auth)) return auth
  const formData = await request.formData().catch(() => null)
  const file = formData?.get('file')
  if (!(file instanceof File) || !file.type.startsWith('image/') || file.size <= 0
    || file.size > MAX_UPLOAD_BYTES) {
    throw new ApiError('INVALID_PARAMS', { code: 'STORYBOARD_DIRECTOR_UPLOAD_INVALID' })
  }
  const normalized = await sharp(Buffer.from(await file.arrayBuffer()))
    .rotate()
    .resize({ width: 4096, height: 4096, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 90 })
    .toBuffer({ resolveWithObject: true })
  const storageKey = `${directorUploadPrefix(auth.session.user.id, projectId)}${randomUUID()}.webp`
  await uploadObject(normalized.data, storageKey, 1, 'image/webp')
  const media = await ensureMediaObjectFromStorageKey(storageKey, {
    mimeType: 'image/webp',
    sizeBytes: normalized.data.byteLength,
    width: normalized.info.width,
    height: normalized.info.height,
  })
  return NextResponse.json({
    mediaId: media.id,
    imageUrl: media.url,
    width: media.width,
    height: media.height,
  })
})
