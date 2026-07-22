import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import sharp from 'sharp'

import { requireProjectAuthLight, isErrorResponse } from '@/lib/api-auth'
import { ApiError, apiHandler } from '@/lib/api-errors'
import { ensureMediaObjectFromStorageKey } from '@/lib/media/service'
import { directorUploadPrefix } from '@/lib/novel-promotion/director-media'
import { uploadObject } from '@/lib/storage'

const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_AV_BYTES = 256 * 1024 * 1024

function extensionForMimeType(mimeType: string) {
  const extensions: Record<string, string> = {
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg',
    'audio/flac': 'flac',
  }
  return extensions[mimeType]
}

export const POST = apiHandler(async (
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) => {
  const { projectId } = await context.params
  const auth = await requireProjectAuthLight(projectId)
  if (isErrorResponse(auth)) return auth
  const formData = await request.formData().catch(() => null)
  const file = formData?.get('file')
  const mediaKind = file instanceof File
    ? file.type.startsWith('image/') ? 'image'
      : file.type.startsWith('video/') ? 'video'
        : file.type.startsWith('audio/') ? 'audio'
          : null
    : null
  const maxBytes = mediaKind === 'image' ? MAX_IMAGE_BYTES : MAX_AV_BYTES
  if (!(file instanceof File) || !mediaKind || file.size <= 0 || file.size > maxBytes) {
    throw new ApiError('INVALID_PARAMS', { code: 'STORYBOARD_DIRECTOR_UPLOAD_INVALID' })
  }
  const source = Buffer.from(await file.arrayBuffer())
  let bytes: Buffer<ArrayBufferLike> = source
  let mimeType = file.type
  let extension = extensionForMimeType(mimeType)
  let width: number | undefined
  let height: number | undefined
  if (mediaKind === 'image') {
    const normalized = await sharp(source)
      .rotate()
      .resize({ width: 4096, height: 4096, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 90 })
      .toBuffer({ resolveWithObject: true })
    bytes = normalized.data
    mimeType = 'image/webp'
    extension = 'webp'
    width = normalized.info.width
    height = normalized.info.height
  }
  if (!extension) {
    throw new ApiError('INVALID_PARAMS', { code: 'STORYBOARD_DIRECTOR_UPLOAD_FORMAT_UNSUPPORTED' })
  }
  const storageKey = `${directorUploadPrefix(auth.session.user.id, projectId)}${randomUUID()}.${extension}`
  await uploadObject(bytes, storageKey, 1, mimeType)
  const media = await ensureMediaObjectFromStorageKey(storageKey, {
    mimeType,
    sizeBytes: bytes.byteLength,
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
  })
  return NextResponse.json({
    mediaId: media.id,
    mediaUrl: media.url,
    ...(mediaKind === 'image' ? { imageUrl: media.url } : {}),
    mimeType,
    filename: file.name,
    width: media.width,
    height: media.height,
  })
})
