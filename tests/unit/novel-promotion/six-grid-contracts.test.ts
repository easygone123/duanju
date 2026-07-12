import { describe, expect, it } from 'vitest'

import {
  parseCropRect,
  parseSixGridRunSettings,
} from '@/lib/novel-promotion/six-grid/contracts'

describe('six-grid domain contracts', () => {
  it('preserves strict six-grid run settings', () => {
    const settings = {
      mode: 'six_grid',
      cellAspectRatio: '9:16',
      processingOrder: 'sheet_upscale_then_crop',
    } as const

    expect(parseSixGridRunSettings(settings)).toEqual(settings)
  })

  it('rejects crop rectangles outside normalized bounds', () => {
    expect(() => parseCropRect({
      x: -0.01,
      y: 0,
      width: 1 / 3,
      height: 1 / 2,
    })).toThrow('SIX_GRID_CROP_OUT_OF_BOUNDS')
  })
})
