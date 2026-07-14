import {
  VIRAL_VIDEO_MAX_DURATION_MS,
  VIRAL_VIDEO_MIN_DURATION_MS,
} from './constants'
import {
  isAllowedViralVideoMajorBrand,
  isSupportedMp4FormatName,
  type VideoMetadata,
} from './ffmpeg'

export type ViralUploadValidationErrorCode =
  | 'INVALID_MEDIA_HEADER'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'UNSUPPORTED_CONTAINER'
  | 'UNSUPPORTED_CONTAINER_BRAND'
  | 'INVALID_VIDEO_DURATION'

export class ViralUploadValidationError extends Error {
  readonly code: ViralUploadValidationErrorCode

  constructor(code: ViralUploadValidationErrorCode, message: string) {
    super(message)
    this.name = 'ViralUploadValidationError'
    this.code = code
  }
}

const ALLOWED_DECLARED_MIME_TYPES = new Set([
  'application/mp4',
  'video/mov',
  'video/mp4',
  'video/quicktime',
  'video/x-quicktime',
])

export function hasIsoBaseMediaFtypSignature(prefix: Uint8Array): boolean {
  if (prefix.byteLength < 12) return false
  const view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength)
  const boxSize = view.getUint32(0, false)
  if (boxSize < 12) return false
  return prefix[4] === 0x66
    && prefix[5] === 0x74
    && prefix[6] === 0x79
    && prefix[7] === 0x70
}

export function parseIsoBaseMediaMajorBrand(prefix: Uint8Array): string | null {
  if (!hasIsoBaseMediaFtypSignature(prefix)) return null
  return String.fromCharCode(prefix[8], prefix[9], prefix[10], prefix[11])
}

export function validateDeclaredVideoMime(mimeType: string): void {
  const normalized = mimeType.split(';', 1)[0].trim().toLowerCase()
  if (!ALLOWED_DECLARED_MIME_TYPES.has(normalized)) {
    throw new ViralUploadValidationError(
      'UNSUPPORTED_MEDIA_TYPE',
      `Declared media type must be an MP4 or MOV MIME type; received ${mimeType || 'empty'}`,
    )
  }
}

export function validateViralUploadPrefix(prefix: Uint8Array, mimeType: string): void {
  validateDeclaredVideoMime(mimeType)
  const majorBrand = parseIsoBaseMediaMajorBrand(prefix)
  if (!majorBrand) {
    throw new ViralUploadValidationError(
      'INVALID_MEDIA_HEADER',
      'Upload does not contain an ISO base media ftyp signature',
    )
  }
  if (!isAllowedViralVideoMajorBrand(majorBrand)) {
    throw new ViralUploadValidationError(
      'UNSUPPORTED_CONTAINER_BRAND',
      `Unsupported video container major brand: ${JSON.stringify(majorBrand)}`,
    )
  }
}

export const validateVideoUpload = validateViralUploadPrefix

export function validateViralDuration(durationMs: number): void {
  if (
    !Number.isSafeInteger(durationMs)
    || durationMs < VIRAL_VIDEO_MIN_DURATION_MS
    || durationMs > VIRAL_VIDEO_MAX_DURATION_MS
  ) {
    throw new ViralUploadValidationError(
      'INVALID_VIDEO_DURATION',
      `Video duration must be between ${VIRAL_VIDEO_MIN_DURATION_MS} and ${VIRAL_VIDEO_MAX_DURATION_MS} ms inclusive`,
    )
  }
}

export function validateViralVideoMetadata(
  metadata: Pick<VideoMetadata, 'durationMs' | 'formatName' | 'majorBrand'>,
): void {
  if (!isSupportedMp4FormatName(metadata.formatName)) {
    throw new ViralUploadValidationError(
      'UNSUPPORTED_CONTAINER',
      `Unsupported video container: ${metadata.formatName}`,
    )
  }
  if (!isAllowedViralVideoMajorBrand(metadata.majorBrand)) {
    throw new ViralUploadValidationError(
      'UNSUPPORTED_CONTAINER_BRAND',
      `Unsupported video container major brand: ${JSON.stringify(metadata.majorBrand)}`,
    )
  }
  validateViralDuration(metadata.durationMs)
}
