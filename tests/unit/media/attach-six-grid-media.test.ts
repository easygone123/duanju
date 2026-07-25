import { beforeEach, describe, expect, it, vi } from 'vitest'

const resolveMediaRefMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/media/service', () => ({
  createReadOnlyMediaResolver: vi.fn(async () => ({
    resolve: resolveMediaRefMock,
    resolveLegacy: vi.fn(async () => null),
  })),
  resolveMediaRef: resolveMediaRefMock,
  resolveMediaRefFromLegacyValue: vi.fn(async () => null),
}))

import { attachMediaFieldsToProject } from '@/lib/media/attach'

describe('six-grid media attachment', () => {
  beforeEach(() => {
    resolveMediaRefMock.mockReset()
    resolveMediaRefMock.mockImplementation(async (mediaId: unknown) => (
      typeof mediaId === 'string' && mediaId
        ? { id: mediaId, publicId: `public-${mediaId}`, url: `/m/public-${mediaId}`, mimeType: 'image/png' }
        : null
    ))
  })

  it('resolves sheet, crop, and upscale URLs by media id and preserves legacy fallbacks', async () => {
    const result = await attachMediaFieldsToProject({
      storyboards: [{
        id: 'storyboard-1',
        sheetImageMediaId: 'sheet-media', sheetImageUrl: 'stale-sheet.jpg',
        upscaledSheetImageMediaId: null, upscaledSheetImageUrl: 'legacy-upscaled-sheet.jpg',
        panels: [{
          id: 'panel-1',
          croppedImageMediaId: 'crop-media', croppedImageUrl: 'stale-crop.jpg',
          upscaledImageMediaId: null, upscaledImageUrl: 'legacy-upscaled-panel.jpg',
        }],
      }],
    })

    const storyboard = (result.storyboards as Array<Record<string, unknown>>)[0]
    const panel = (storyboard.panels as Array<Record<string, unknown>>)[0]
    expect(storyboard.sheetImageUrl).toBe('/m/public-sheet-media')
    expect(storyboard.upscaledSheetImageUrl).toBe('legacy-upscaled-sheet.jpg')
    expect(panel.croppedImageUrl).toBe('/m/public-crop-media')
    expect(panel.upscaledImageUrl).toBe('legacy-upscaled-panel.jpg')
  })
})
