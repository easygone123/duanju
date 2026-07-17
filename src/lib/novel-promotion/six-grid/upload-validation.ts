import sharp from 'sharp'
import type { SixGridCellAspectRatio } from './contracts'
import {
  SIX_GRID_UPLOAD_MAX_BYTES,
  SIX_GRID_UPLOAD_MAX_DIMENSION,
  SIX_GRID_UPLOAD_MAX_PIXELS,
  SixGridUploadError,
  isSixGridSheetRatioAllowed,
  sheetRatio,
  type NormalizedSixGridUpload,
} from './upload-contract'

const ALLOWED_FORMATS = new Set(['png', 'jpeg', 'webp'])

export async function validateAndNormalizeSixGridUpload(
  source: Buffer,
  cellAspectRatio: SixGridCellAspectRatio,
): Promise<NormalizedSixGridUpload> {
  if (source.byteLength === 0) {
    throw new SixGridUploadError('SIX_GRID_UPLOAD_IMAGE_INVALID')
  }
  if (source.byteLength > SIX_GRID_UPLOAD_MAX_BYTES) {
    throw new SixGridUploadError('SIX_GRID_UPLOAD_TOO_LARGE')
  }

  try {
    const metadata = await sharp(source, {
      failOn: 'error',
      limitInputPixels: false,
    }).metadata()
    if (!metadata.format || !ALLOWED_FORMATS.has(metadata.format)) {
      throw new SixGridUploadError('SIX_GRID_UPLOAD_IMAGE_INVALID')
    }
    assertDecodedSize(metadata.width, metadata.height)

    const normalized = await sharp(source, {
      failOn: 'error',
      limitInputPixels: SIX_GRID_UPLOAD_MAX_PIXELS,
    }).rotate().webp({ quality: 95 }).toBuffer({ resolveWithObject: true })
    const { width, height } = normalized.info
    assertDecodedSize(width, height)

    const actualRatio = sheetRatio(width, height)
    if (!isSixGridSheetRatioAllowed(actualRatio, cellAspectRatio)) {
      throw new SixGridUploadError('SIX_GRID_UPLOAD_RATIO_INVALID', {
        width,
        height,
        actualRatio,
      })
    }

    return {
      bytes: normalized.data,
      width,
      height,
      sizeBytes: normalized.data.byteLength,
      mimeType: 'image/webp',
    }
  } catch (error) {
    if (error instanceof SixGridUploadError) throw error
    throw new SixGridUploadError('SIX_GRID_UPLOAD_IMAGE_INVALID')
  }
}

function assertDecodedSize(width: number | undefined, height: number | undefined): void {
  if (width === undefined || height === undefined
    || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || width <= 0 || height <= 0) {
    throw new SixGridUploadError('SIX_GRID_UPLOAD_IMAGE_INVALID')
  }
  if (width > SIX_GRID_UPLOAD_MAX_DIMENSION
    || height > SIX_GRID_UPLOAD_MAX_DIMENSION
    || width * height > SIX_GRID_UPLOAD_MAX_PIXELS) {
    throw new SixGridUploadError('SIX_GRID_UPLOAD_TOO_LARGE')
  }
}
