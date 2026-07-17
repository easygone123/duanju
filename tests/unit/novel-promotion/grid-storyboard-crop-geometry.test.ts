import { describe, expect, it } from 'vitest'
import {
  computeGridPixelRects,
  validateManualGridCrop,
} from '@/lib/novel-promotion/grid-storyboard/crop-geometry'
import { resolveStoryboardGridSpec } from '@/lib/novel-promotion/grid-storyboard/spec'
import { pixelRectToNormalized } from '@/lib/novel-promotion/six-grid/crop-geometry'

describe('grid storyboard crop geometry', () => {
  it.each([
    { mode: 'four_grid' as const, ratio: '16:9' as const, width: 1600, height: 900, count: 4 },
    { mode: 'four_grid' as const, ratio: '9:16' as const, width: 901, height: 1601, count: 4 },
    { mode: 'six_grid' as const, ratio: '16:9' as const, width: 2400, height: 900, count: 6 },
    { mode: 'six_grid' as const, ratio: '9:16' as const, width: 1351, height: 1601, count: 6 },
  ])('partitions $mode $width x $height exactly in row-major order', ({ mode, ratio, width, height, count }) => {
    const spec = resolveStoryboardGridSpec(mode, ratio)
    const rects = computeGridPixelRects({ width, height }, spec)

    expect(rects).toHaveLength(count)
    expect(rects.map((rect) => rect.cellIndex)).toEqual(Array.from({ length: count }, (_, index) => index))
    expect(rects.reduce((area, rect) => area + rect.width * rect.height, 0)).toBe(width * height)
    expect(rects.every((rect) => Number.isInteger(rect.x)
      && Number.isInteger(rect.y)
      && Number.isInteger(rect.width)
      && Number.isInteger(rect.height)
      && rect.width > 0
      && rect.height > 0)).toBe(true)

    for (let row = 0; row < spec.rows; row += 1) {
      const rowRects = rects.slice(row * spec.columns, (row + 1) * spec.columns)
      expect(rowRects[0]?.x).toBe(0)
      expect(rowRects.at(-1)!.x + rowRects.at(-1)!.width).toBe(width)
      for (let column = 1; column < rowRects.length; column += 1) {
        expect(rowRects[column]!.x).toBe(rowRects[column - 1]!.x + rowRects[column - 1]!.width)
      }
    }
    expect(rects[0]?.y).toBe(0)
    expect(rects.at(-1)!.y + rects.at(-1)!.height).toBe(height)
  })

  it('uses the established rounded-boundary behavior for both layouts', () => {
    expect(computeGridPixelRects(
      { width: 5, height: 3 },
      resolveStoryboardGridSpec('four_grid', '16:9'),
    )).toEqual([
      { cellIndex: 0, x: 0, y: 0, width: 3, height: 2 },
      { cellIndex: 1, x: 3, y: 0, width: 2, height: 2 },
      { cellIndex: 2, x: 0, y: 2, width: 3, height: 1 },
      { cellIndex: 3, x: 3, y: 2, width: 2, height: 1 },
    ])
    expect(computeGridPixelRects(
      { width: 7, height: 3 },
      resolveStoryboardGridSpec('six_grid', '16:9'),
    )).toEqual([
      { cellIndex: 0, x: 0, y: 0, width: 2, height: 2 },
      { cellIndex: 1, x: 2, y: 0, width: 3, height: 2 },
      { cellIndex: 2, x: 5, y: 0, width: 2, height: 2 },
      { cellIndex: 3, x: 0, y: 2, width: 2, height: 1 },
      { cellIndex: 4, x: 2, y: 2, width: 3, height: 1 },
      { cellIndex: 5, x: 5, y: 2, width: 2, height: 1 },
    ])
  })

  it.each([
    { width: 3.5, height: 2, error: 'GRID_DIMENSIONS_NOT_INTEGER' },
    { width: Number.MAX_SAFE_INTEGER + 1, height: 2, error: 'GRID_DIMENSIONS_NOT_SAFE_INTEGER' },
    { width: 0, height: 2, error: 'GRID_DIMENSIONS_NOT_POSITIVE' },
    { width: 1, height: 2, error: 'GRID_DIMENSIONS_TOO_SMALL' },
    { width: 2, height: 1, error: 'GRID_DIMENSIONS_TOO_SMALL' },
  ])('fails closed for invalid dimensions with $error', ({ width, height, error }) => {
    expect(() => computeGridPixelRects(
      { width, height },
      resolveStoryboardGridSpec('four_grid', '16:9'),
    )).toThrow(error)
  })

  it('fails closed for a non-canonical or internally inconsistent spec', () => {
    const canonical = resolveStoryboardGridSpec('four_grid', '16:9')
    expect(() => computeGridPixelRects(
      { width: 1600, height: 900 },
      { ...canonical, panelCount: 6 } as typeof canonical,
    )).toThrow('STORYBOARD_GRID_SPEC_INVALID')
  })

  it('accepts four unique manual crops in cells 0..3 and rejects cell 4', () => {
    const dimensions = { width: 1600, height: 900 }
    const spec = resolveStoryboardGridSpec('four_grid', '16:9')
    const cells = computeGridPixelRects(dimensions, spec)
    for (const cell of cells) {
      expect(validateManualGridCrop({
        cellIndex: cell.cellIndex,
        normalizedCropRect: pixelRectToNormalized(cell, dimensions),
        spec,
        dimensions,
      })).toEqual({ x: cell.x, y: cell.y, width: cell.width, height: cell.height })
    }
    expect(() => validateManualGridCrop({
      cellIndex: 4,
      normalizedCropRect: { x: 0, y: 0, width: 0.5, height: 0.5 },
      spec,
      dimensions,
    })).toThrow('GRID_CELL_INDEX_INVALID')
  })

  it('preserves six-grid manual crop range 0..5 and cell containment', () => {
    const dimensions = { width: 1200, height: 800 }
    const spec = resolveStoryboardGridSpec('six_grid', '16:9')
    expect(validateManualGridCrop({
      cellIndex: 5,
      normalizedCropRect: pixelRectToNormalized(
        { x: 820, y: 500, width: 320, height: 180 },
        dimensions,
      ),
      spec,
      dimensions,
    })).toEqual({ x: 820, y: 500, width: 320, height: 180 })
    expect(() => validateManualGridCrop({
      cellIndex: 6,
      normalizedCropRect: { x: 0, y: 0, width: 0.1, height: 0.1 },
      spec,
      dimensions,
    })).toThrow('GRID_CELL_INDEX_INVALID')
  })
})
