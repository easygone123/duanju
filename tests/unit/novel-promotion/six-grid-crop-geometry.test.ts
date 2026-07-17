import { describe, expect, it } from 'vitest'
import {
  computeSixGridPixelRects,
  normalizedRectToPixel,
  pixelRectToNormalized,
  validateManualSixGridCrop,
} from '@/lib/novel-promotion/six-grid/crop-geometry'

describe('six-grid crop geometry', () => {
  it.each([
    { width: 300, height: 200 },
    { width: 301, height: 201 },
    { width: 1920, height: 3240 },
  ])('partitions $width x $height into six exact cells', ({ width, height }) => {
    const rects = computeSixGridPixelRects({ width, height })

    expect(rects).toHaveLength(6)
    expect(rects.map((rect) => rect.cellIndex)).toEqual([0, 1, 2, 3, 4, 5])
    expect(rects.every((rect) => Number.isInteger(rect.x)
      && Number.isInteger(rect.y)
      && Number.isInteger(rect.width)
      && Number.isInteger(rect.height)
      && rect.width > 0
      && rect.height > 0)).toBe(true)
    expect(rects.reduce((area, rect) => area + rect.width * rect.height, 0)).toBe(width * height)
    expect(rects).toEqual([
      { cellIndex: 0, x: 0, y: 0, width: Math.round(width / 3), height: Math.round(height / 2) },
      { cellIndex: 1, x: Math.round(width / 3), y: 0, width: Math.round(2 * width / 3) - Math.round(width / 3), height: Math.round(height / 2) },
      { cellIndex: 2, x: Math.round(2 * width / 3), y: 0, width: width - Math.round(2 * width / 3), height: Math.round(height / 2) },
      { cellIndex: 3, x: 0, y: Math.round(height / 2), width: Math.round(width / 3), height: height - Math.round(height / 2) },
      { cellIndex: 4, x: Math.round(width / 3), y: Math.round(height / 2), width: Math.round(2 * width / 3) - Math.round(width / 3), height: height - Math.round(height / 2) },
      { cellIndex: 5, x: Math.round(2 * width / 3), y: Math.round(height / 2), width: width - Math.round(2 * width / 3), height: height - Math.round(height / 2) },
    ])
  })

  it.each([
    { width: 3.5, height: 2, error: 'SIX_GRID_DIMENSIONS_NOT_INTEGER' },
    { width: Number.MAX_SAFE_INTEGER + 1, height: 2, error: 'SIX_GRID_DIMENSIONS_NOT_SAFE_INTEGER' },
    { width: 0, height: 2, error: 'SIX_GRID_DIMENSIONS_NOT_POSITIVE' },
    { width: 2, height: 2, error: 'SIX_GRID_DIMENSIONS_TOO_SMALL' },
    { width: 3, height: 1, error: 'SIX_GRID_DIMENSIONS_TOO_SMALL' },
  ])('rejects invalid source dimensions with $error', ({ width, height, error }) => {
    expect(() => computeSixGridPixelRects({ width, height })).toThrow(error)
  })

  it('round-trips odd-dimension canonical pixel boundaries through normalized coordinates', () => {
    const dimensions = { width: 1001, height: 667 }
    for (const cell of computeSixGridPixelRects(dimensions)) {
      const normalized = pixelRectToNormalized(cell, dimensions)
      expect(normalized.x).toBeGreaterThanOrEqual(0)
      expect(normalized.y).toBeGreaterThanOrEqual(0)
      expect(normalized.x + normalized.width).toBeLessThanOrEqual(1)
      expect(normalized.y + normalized.height).toBeLessThanOrEqual(1)
      expect(normalizedRectToPixel(normalized, dimensions)).toEqual({
        x: cell.x,
        y: cell.y,
        width: cell.width,
        height: cell.height,
      })
    }
  })

  it('preserves legacy minimum-dimension validation for conversion helpers', () => {
    expect(() => pixelRectToNormalized(
      { x: 0, y: 0, width: 2, height: 2 },
      { width: 2, height: 2 },
    )).toThrow('SIX_GRID_DIMENSIONS_TOO_SMALL')
    expect(() => normalizedRectToPixel(
      { x: 0, y: 0, width: 1, height: 1 },
      { width: 2, height: 2 },
    )).toThrow('SIX_GRID_DIMENSIONS_TOO_SMALL')
  })

  it('accepts a locked 16:9 manual crop wholly inside its assigned cell', () => {
    const dimensions = { width: 1200, height: 800 }
    const result = validateManualSixGridCrop({
      cellIndex: 1,
      normalizedCropRect: pixelRectToNormalized(
        { x: 420, y: 80, width: 320, height: 180 },
        dimensions,
      ),
      cellAspectRatio: '16:9',
      dimensions,
    })

    expect(result).toEqual({ x: 420, y: 80, width: 320, height: 180 })
  })

  it('accepts a locked 9:16 manual crop wholly inside a portrait-sheet cell', () => {
    const dimensions = { width: 900, height: 1800 }
    expect(validateManualSixGridCrop({
      cellIndex: 5,
      normalizedCropRect: pixelRectToNormalized(
        { x: 700, y: 1000, width: 180, height: 320 },
        dimensions,
      ),
      cellAspectRatio: '9:16',
      dimensions,
    })).toEqual({ x: 700, y: 1000, width: 180, height: 320 })
  })

  it('does not silently clamp a manual crop across its cell boundary', () => {
    const dimensions = { width: 1200, height: 800 }
    expect(() => validateManualSixGridCrop({
      cellIndex: 0,
      normalizedCropRect: pixelRectToNormalized(
        { x: 300, y: 50, width: 320, height: 180 },
        dimensions,
      ),
      cellAspectRatio: '16:9',
      dimensions,
    })).toThrow('CROP_OUT_OF_CELL')
  })

  it('rejects a continuous normalized crop 0.49px beyond an odd-width cell before rounding', () => {
    const dimensions = { width: 301, height: 201 }
    expect(() => validateManualSixGridCrop({
      cellIndex: 0,
      normalizedCropRect: {
        x: 0,
        y: 10 / dimensions.height,
        width: 100.49 / dimensions.width,
        height: (100.49 * 9 / 16) / dimensions.height,
      },
      cellAspectRatio: '16:9',
      dimensions,
    })).toThrow('CROP_OUT_OF_CELL')
  })

  it.each([null, undefined, '1:1', 'portrait', 1])(
    'rejects unsupported aspect ratio %s instead of treating it as portrait',
    (cellAspectRatio) => {
      expect(() => validateManualSixGridCrop({
        cellIndex: 0,
        normalizedCropRect: { x: 0, y: 0, width: 0.1, height: 0.1 },
        cellAspectRatio,
        dimensions: { width: 1200, height: 800 },
      })).toThrow('CROP_ASPECT_RATIO_INVALID')
    },
  )

  it('rejects a sub-pixel 16:9 crop that rounds to 1x1', () => {
    const dimensions = { width: 1200, height: 800 }
    expect(() => validateManualSixGridCrop({
      cellIndex: 0,
      normalizedCropRect: {
        x: 10.1 / dimensions.width,
        y: 10.1 / dimensions.height,
        width: 0.8 / dimensions.width,
        height: 0.45 / dimensions.height,
      },
      cellAspectRatio: '16:9',
      dimensions,
    })).toThrow('CROP_ASPECT_RATIO_TOO_SMALL')
  })

  it('accepts exact continuous 16:9 geometry with explainable integer rounding', () => {
    const dimensions = { width: 1200, height: 800 }
    expect(validateManualSixGridCrop({
      cellIndex: 0,
      normalizedCropRect: {
        x: 10.1 / dimensions.width,
        y: 10.1 / dimensions.height,
        width: 80.8 / dimensions.width,
        height: 45.45 / dimensions.height,
      },
      cellAspectRatio: '16:9',
      dimensions,
    })).toEqual({ x: 10, y: 10, width: 81, height: 46 })
  })

  it('rejects invalid cell indexes, non-positive crops, and aspect mismatch stably', () => {
    const dimensions = { width: 1200, height: 800 }
    expect(() => validateManualSixGridCrop({
      cellIndex: 6,
      normalizedCropRect: { x: 0, y: 0, width: 0.2, height: 0.2 },
      cellAspectRatio: '16:9',
      dimensions,
    })).toThrow('SIX_GRID_CELL_INDEX_INVALID')
    expect(() => normalizedRectToPixel(
      { x: 0, y: 0, width: 0, height: 0.2 },
      dimensions,
    )).toThrow('SIX_GRID_CROP_INVALID')
    expect(() => validateManualSixGridCrop({
      cellIndex: 0,
      normalizedCropRect: pixelRectToNormalized(
        { x: 20, y: 20, width: 200, height: 200 },
        dimensions,
      ),
      cellAspectRatio: '16:9',
      dimensions,
    })).toThrow('CROP_ASPECT_RATIO_MISMATCH')
  })
})
