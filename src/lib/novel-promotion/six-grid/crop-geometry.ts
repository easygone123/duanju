import type { NormalizedCropRect } from './contracts'
import { resolveStoryboardGridSpec } from '@/lib/novel-promotion/grid-storyboard/spec'
import {
  computeGridPixelRects,
  normalizedRectToPixel as normalizedRectToGridPixel,
  pixelRectToNormalized as gridPixelRectToNormalized,
  validateManualGridCrop,
  type ImageDimensions,
  type PixelRect,
} from '@/lib/novel-promotion/grid-storyboard/crop-geometry'

export type { ImageDimensions, PixelRect } from '@/lib/novel-promotion/grid-storyboard/crop-geometry'
export type SixGridPixelRect = PixelRect & { cellIndex: number }

export function assertSixGridCellAspectRatio(value: unknown): void {
  parseAspectRatio(value)
}

export function computeSixGridPixelRects(dimensions: ImageDimensions): SixGridPixelRect[] {
  try {
    return computeGridPixelRects(dimensions, resolveStoryboardGridSpec('six_grid', '16:9'))
  } catch (error) {
    throwLegacyGeometryError(error)
  }
}

export function pixelRectToNormalized(
  rect: PixelRect,
  dimensions: ImageDimensions,
): NormalizedCropRect {
  try {
    computeGridPixelRects(dimensions, resolveStoryboardGridSpec('six_grid', '16:9'))
    return gridPixelRectToNormalized(rect, dimensions)
  } catch (error) {
    throwLegacyGeometryError(error)
  }
}

export function normalizedRectToPixel(
  rect: NormalizedCropRect,
  dimensions: ImageDimensions,
): PixelRect {
  try {
    computeGridPixelRects(dimensions, resolveStoryboardGridSpec('six_grid', '16:9'))
    return normalizedRectToGridPixel(rect, dimensions)
  } catch (error) {
    throwLegacyGeometryError(error)
  }
}

export function validateManualSixGridCrop(input: {
  cellIndex: number
  normalizedCropRect: NormalizedCropRect
  cellAspectRatio: unknown
  dimensions: ImageDimensions
}): PixelRect {
  try {
    return validateManualGridCrop({
      cellIndex: input.cellIndex,
      normalizedCropRect: input.normalizedCropRect,
      spec: resolveStoryboardGridSpec('six_grid', input.cellAspectRatio),
      dimensions: input.dimensions,
    })
  } catch (error) {
    throwLegacyGeometryError(error)
  }
}

function parseAspectRatio(value: unknown): readonly [number, number] {
  if (value === '16:9') return [16, 9]
  if (value === '9:16') return [9, 16]
  throw new Error('CROP_ASPECT_RATIO_INVALID')
}

function throwLegacyGeometryError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error)
  const legacy = new Map([
    ['GRID_CELL_INDEX_INVALID', 'SIX_GRID_CELL_INDEX_INVALID'],
    ['GRID_CROP_INVALID', 'SIX_GRID_CROP_INVALID'],
    ['GRID_DIMENSIONS_NOT_INTEGER', 'SIX_GRID_DIMENSIONS_NOT_INTEGER'],
    ['GRID_DIMENSIONS_NOT_SAFE_INTEGER', 'SIX_GRID_DIMENSIONS_NOT_SAFE_INTEGER'],
    ['GRID_DIMENSIONS_NOT_POSITIVE', 'SIX_GRID_DIMENSIONS_NOT_POSITIVE'],
    ['GRID_DIMENSIONS_TOO_SMALL', 'SIX_GRID_DIMENSIONS_TOO_SMALL'],
    ['STORYBOARD_GRID_CELL_ASPECT_RATIO_INVALID', 'CROP_ASPECT_RATIO_INVALID'],
  ]).get(message)
  throw new Error(legacy ?? message)
}
