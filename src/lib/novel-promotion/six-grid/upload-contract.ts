import type { SixGridCellAspectRatio } from './contracts'

export const SIX_GRID_UPLOAD_RATIO_TOLERANCE = 0.03
export const SIX_GRID_UPLOAD_MAX_BYTES = 25 * 1024 * 1024
export const SIX_GRID_UPLOAD_MAX_PIXELS = 80_000_000
export const SIX_GRID_UPLOAD_MAX_DIMENSION = 16_384

export type SixGridUploadErrorCode =
  | 'SIX_GRID_UPLOAD_IMAGE_INVALID'
  | 'SIX_GRID_UPLOAD_TOO_LARGE'
  | 'SIX_GRID_UPLOAD_RATIO_INVALID'

export class SixGridUploadError extends Error {
  readonly code: SixGridUploadErrorCode
  readonly details: Readonly<Record<string, number>>

  constructor(code: SixGridUploadErrorCode, details: Record<string, number> = {}) {
    super(code)
    this.name = 'SixGridUploadError'
    this.code = code
    this.details = Object.freeze({ ...details })
  }
}

export type NormalizedSixGridUpload = {
  bytes: Buffer
  width: number
  height: number
  sizeBytes: number
  mimeType: 'image/webp'
}

export function expectedSixGridSheetRatio(value: SixGridCellAspectRatio): number {
  switch (value) {
    case '16:9':
      return 8 / 3
    case '9:16':
      return 27 / 32
    default:
      throw new SixGridUploadError('SIX_GRID_UPLOAD_IMAGE_INVALID')
  }
}

export function sheetRatio(width: number, height: number): number {
  if (!isPositiveSafeInteger(width) || !isPositiveSafeInteger(height)) {
    throw new SixGridUploadError('SIX_GRID_UPLOAD_IMAGE_INVALID')
  }
  return width / height
}

export function isSixGridSheetRatioAllowed(
  actual: number,
  cellRatio: SixGridCellAspectRatio,
): boolean {
  if (!Number.isFinite(actual) || actual <= 0) return false
  const expected = expectedSixGridSheetRatio(cellRatio)
  const relativeDifference = Math.abs(actual - expected) / expected
  return relativeDifference <= SIX_GRID_UPLOAD_RATIO_TOLERANCE + Number.EPSILON
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}
