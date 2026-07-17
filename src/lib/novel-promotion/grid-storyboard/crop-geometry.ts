import type { NormalizedCropRect } from '@/lib/novel-promotion/six-grid/contracts'
import {
  resolveStoryboardGridSpec,
  type StoryboardGridSpec,
} from './spec'

export type ImageDimensions = { width: number; height: number }
export type PixelRect = { x: number; y: number; width: number; height: number }
export type GridPixelRect = PixelRect & { cellIndex: number }

const NORMALIZED_BOUNDARY_EPSILON = 1e-12
const CONTINUOUS_ASPECT_RELATIVE_EPSILON = 1e-9

export function assertCanonicalGridSpec(spec: StoryboardGridSpec): void {
  let canonical: StoryboardGridSpec
  try {
    canonical = resolveStoryboardGridSpec(spec.mode, spec.cellAspectRatio)
  } catch {
    throw new Error('STORYBOARD_GRID_SPEC_INVALID')
  }
  if (spec.columns !== canonical.columns
    || spec.rows !== canonical.rows
    || spec.panelCount !== canonical.panelCount
    || spec.sheetAspectRatio !== canonical.sheetAspectRatio) {
    throw new Error('STORYBOARD_GRID_SPEC_INVALID')
  }
}

export function computeGridPixelRects(
  dimensions: ImageDimensions,
  spec: StoryboardGridSpec,
): GridPixelRect[] {
  assertCanonicalGridSpec(spec)
  validateDimensions(dimensions, spec)
  const xs = Array.from(
    { length: spec.columns + 1 },
    (_, index) => Math.round(index * dimensions.width / spec.columns),
  )
  const ys = Array.from(
    { length: spec.rows + 1 },
    (_, index) => Math.round(index * dimensions.height / spec.rows),
  )

  return Array.from({ length: spec.panelCount }, (_, cellIndex) => {
    const column = cellIndex % spec.columns
    const row = Math.floor(cellIndex / spec.columns)
    return {
      cellIndex,
      x: xs[column]!,
      y: ys[row]!,
      width: xs[column + 1]! - xs[column]!,
      height: ys[row + 1]! - ys[row]!,
    }
  })
}

export function validateManualGridCrop(input: {
  cellIndex: number
  normalizedCropRect: NormalizedCropRect
  spec: StoryboardGridSpec
  dimensions: ImageDimensions
}): PixelRect {
  assertCanonicalGridSpec(input.spec)
  if (!Number.isInteger(input.cellIndex)
    || input.cellIndex < 0
    || input.cellIndex >= input.spec.panelCount) {
    throw new Error('GRID_CELL_INDEX_INVALID')
  }
  const [numerator, denominator] = parseAspectRatio(input.spec.cellAspectRatio)
  const cell = computeGridPixelRects(input.dimensions, input.spec)[input.cellIndex]!
  validateNormalizedRect(input.normalizedCropRect)
  const cellLeft = cell.x / input.dimensions.width
  const cellTop = cell.y / input.dimensions.height
  const cellRight = (cell.x + cell.width) / input.dimensions.width
  const cellBottom = (cell.y + cell.height) / input.dimensions.height
  const cropRight = input.normalizedCropRect.x + input.normalizedCropRect.width
  const cropBottom = input.normalizedCropRect.y + input.normalizedCropRect.height
  if (input.normalizedCropRect.x < cellLeft - NORMALIZED_BOUNDARY_EPSILON
    || input.normalizedCropRect.y < cellTop - NORMALIZED_BOUNDARY_EPSILON
    || cropRight > cellRight + NORMALIZED_BOUNDARY_EPSILON
    || cropBottom > cellBottom + NORMALIZED_BOUNDARY_EPSILON) {
    throw new Error('CROP_OUT_OF_CELL')
  }

  const continuousWidth = input.normalizedCropRect.width * input.dimensions.width
  const continuousHeight = input.normalizedCropRect.height * input.dimensions.height
  const continuousLeft = continuousWidth * denominator
  const continuousRight = continuousHeight * numerator
  const aspectScale = Math.max(continuousLeft, continuousRight, 1)
  if (Math.abs(continuousLeft - continuousRight) > aspectScale * CONTINUOUS_ASPECT_RELATIVE_EPSILON) {
    throw new Error('CROP_ASPECT_RATIO_MISMATCH')
  }

  const rect = normalizedRectToPixel(input.normalizedCropRect, input.dimensions)
  if (rect.x < cell.x
    || rect.y < cell.y
    || rect.x + rect.width > cell.x + cell.width
    || rect.y + rect.height > cell.y + cell.height) {
    throw new Error('CROP_OUT_OF_CELL')
  }
  if (rect.width < numerator || rect.height < denominator) {
    throw new Error('CROP_ASPECT_RATIO_TOO_SMALL')
  }
  if (Math.abs(rect.width * denominator - rect.height * numerator) > Math.max(numerator, denominator)) {
    throw new Error('CROP_ASPECT_RATIO_MISMATCH')
  }
  return rect
}

export function pixelRectToNormalized(
  rect: PixelRect,
  dimensions: ImageDimensions,
): NormalizedCropRect {
  validateBasicDimensions(dimensions)
  validatePixelRect(rect, dimensions)
  return {
    x: rect.x / dimensions.width,
    y: rect.y / dimensions.height,
    width: rect.width / dimensions.width,
    height: rect.height / dimensions.height,
  }
}

export function normalizedRectToPixel(
  rect: NormalizedCropRect,
  dimensions: ImageDimensions,
): PixelRect {
  validateBasicDimensions(dimensions)
  validateNormalizedRect(rect)
  const x = Math.round(rect.x * dimensions.width)
  const y = Math.round(rect.y * dimensions.height)
  const right = Math.round((rect.x + rect.width) * dimensions.width)
  const bottom = Math.round((rect.y + rect.height) * dimensions.height)
  const pixelRect = { x, y, width: right - x, height: bottom - y }
  validatePixelRect(pixelRect, dimensions)
  return pixelRect
}

function parseAspectRatio(value: unknown): readonly [number, number] {
  if (value === '16:9') return [16, 9]
  if (value === '9:16') return [9, 16]
  throw new Error('CROP_ASPECT_RATIO_INVALID')
}

function validateNormalizedRect(rect: NormalizedCropRect): void {
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
    || rect.x < 0
    || rect.y < 0
    || rect.width <= 0
    || rect.height <= 0
    || rect.x + rect.width > 1
    || rect.y + rect.height > 1) {
    throw new Error('GRID_CROP_INVALID')
  }
}

function validateBasicDimensions(dimensions: ImageDimensions): void {
  if (!Number.isInteger(dimensions.width) || !Number.isInteger(dimensions.height)) {
    throw new Error('GRID_DIMENSIONS_NOT_INTEGER')
  }
  if (!Number.isSafeInteger(dimensions.width) || !Number.isSafeInteger(dimensions.height)) {
    throw new Error('GRID_DIMENSIONS_NOT_SAFE_INTEGER')
  }
  if (dimensions.width <= 0 || dimensions.height <= 0) {
    throw new Error('GRID_DIMENSIONS_NOT_POSITIVE')
  }
}

function validateDimensions(dimensions: ImageDimensions, spec: StoryboardGridSpec): void {
  validateBasicDimensions(dimensions)
  if (dimensions.width < spec.columns || dimensions.height < spec.rows) {
    throw new Error('GRID_DIMENSIONS_TOO_SMALL')
  }
}

function validatePixelRect(rect: PixelRect, dimensions: ImageDimensions): void {
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isInteger)
    || rect.x < 0
    || rect.y < 0
    || rect.width <= 0
    || rect.height <= 0
    || rect.x + rect.width > dimensions.width
    || rect.y + rect.height > dimensions.height) {
    throw new Error('GRID_CROP_INVALID')
  }
}
