import { describe, expect, it } from 'vitest'
import {
  resolveStoryboardGridSpec,
} from '@/lib/novel-promotion/grid-storyboard/spec'

describe('resolveStoryboardGridSpec', () => {
  it.each([
    ['four_grid', '16:9', { columns: 2, rows: 2, panelCount: 4, sheetAspectRatio: '16:9' }],
    ['four_grid', '9:16', { columns: 2, rows: 2, panelCount: 4, sheetAspectRatio: '9:16' }],
    ['six_grid', '16:9', { columns: 3, rows: 2, panelCount: 6, sheetAspectRatio: '8:3' }],
    ['six_grid', '9:16', { columns: 3, rows: 2, panelCount: 6, sheetAspectRatio: '27:32' }],
  ] as const)(
    'maps %s with %s cells to its canonical grid geometry',
    (mode, cellAspectRatio, expected) => {
      expect(resolveStoryboardGridSpec(mode, cellAspectRatio)).toEqual({
        mode,
        cellAspectRatio,
        ...expected,
      })
    },
  )

  it('rejects non-grid modes', () => {
    expect(() => resolveStoryboardGridSpec('individual', '16:9'))
      .toThrowError('STORYBOARD_GRID_MODE_INVALID')
  })

  it('rejects unsupported cell aspect ratios', () => {
    expect(() => resolveStoryboardGridSpec('four_grid', '1:1'))
      .toThrowError('STORYBOARD_GRID_CELL_ASPECT_RATIO_INVALID')
  })
})
