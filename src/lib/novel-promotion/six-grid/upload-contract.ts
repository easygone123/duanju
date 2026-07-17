import type { SixGridCellAspectRatio } from './contracts'
import {
  resolveStoryboardGridSpec,
  type StoryboardGridSpec,
} from '@/lib/novel-promotion/grid-storyboard/spec'

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
  readonly details: Readonly<Record<string, number | string>>

  constructor(code: SixGridUploadErrorCode, details: Record<string, number | string> = {}) {
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
  try {
    return expectedGridSheetRatio(resolveStoryboardGridSpec('six_grid', value))
  } catch {
    throw new SixGridUploadError('SIX_GRID_UPLOAD_IMAGE_INVALID')
  }
}

export function expectedGridSheetRatio(spec: StoryboardGridSpec): number {
  let canonical: StoryboardGridSpec
  try {
    canonical = resolveStoryboardGridSpec(spec.mode, spec.cellAspectRatio)
  } catch {
    throw new SixGridUploadError('SIX_GRID_UPLOAD_IMAGE_INVALID')
  }
  if (spec.columns !== canonical.columns
    || spec.rows !== canonical.rows
    || spec.panelCount !== canonical.panelCount
    || spec.sheetAspectRatio !== canonical.sheetAspectRatio) {
    throw new SixGridUploadError('SIX_GRID_UPLOAD_IMAGE_INVALID')
  }
  const [numerator, denominator] = canonical.sheetAspectRatio.split(':').map(Number)
  return numerator! / denominator!
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

export function isGridSheetRatioAllowed(
  actual: number,
  spec: StoryboardGridSpec,
): boolean {
  if (!Number.isFinite(actual) || actual <= 0) return false
  const expected = expectedGridSheetRatio(spec)
  const relativeDifference = Math.abs(actual - expected) / expected
  return relativeDifference <= SIX_GRID_UPLOAD_RATIO_TOLERANCE + Number.EPSILON
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}
