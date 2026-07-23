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

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
  avi: 'video/x-msvideo', m4v: 'video/x-m4v', wav: 'audio/wav', mp3: 'audio/mpeg',
  ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac',
}

function extensionForMimeType(mimeType: string) {
  const extensions: Record<string, string> = {
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'video/x-matroska': 'mkv',
    'video/x-msvideo': 'avi',
    'video/x-m4v': 'm4v',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'audio/webm': 'webm',
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
  const inferredMimeType = file instanceof File
    ? file.type || MIME_BY_EXTENSION[file.name.split('.').pop()?.toLowerCase() || ''] || ''
    : ''
  const mediaKind = file instanceof File
    ? inferredMimeType.startsWith('image/') ? 'image'
      : inferredMimeType.startsWith('video/') ? 'video'
        : inferredMimeType.startsWith('audio/') ? 'audio'
          : null
    : null
  const maxBytes = mediaKind === 'image' ? MAX_IMAGE_BYTES : MAX_AV_BYTES
  if (!(file instanceof File) || !mediaKind || file.size <= 0 || file.size > maxBytes) {
    throw new ApiError('INVALID_PARAMS', { code: 'STORYBOARD_DIRECTOR_UPLOAD_INVALID' })
  }
  const source = Buffer.from(await file.arrayBuffer())
  let bytes: Buffer<ArrayBufferLike> = source
  let mimeType = inferredMimeType
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
