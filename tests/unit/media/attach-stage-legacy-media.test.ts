import { describe, expect, it, vi } from 'vitest'

const createReadOnlyMediaResolverMock = vi.hoisted(() => vi.fn())
const resolveLegacyMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/media/service', () => ({
  createReadOnlyMediaResolver: createReadOnlyMediaResolverMock,
  resolveMediaRef: vi.fn(async () => null),
  resolveMediaRefFromLegacyValue: resolveLegacyMock,
}))

import { attachMediaFieldsToStagePayload } from '@/lib/media/attach'

describe('stage legacy media attachment', () => {
  it('backfills a legacy ComfyUI panel output and returns its stable preview URL', async () => {
    let mediaAvailable = false
    createReadOnlyMediaResolverMock.mockImplementation(async () => ({
      resolve: vi.fn(async (_mediaId: unknown, legacyValue: unknown) => (
        mediaAvailable && legacyValue === 'comfyui/user/project/request/output.png'
          ? {
              id: 'media-1',
              publicId: 'public-1',
              storageKey: legacyValue,
              url: '/m/public-1',
              mimeType: 'image/png',
            }
          : null
      )),
      resolveLegacy: vi.fn(async () => null),
    }))
    resolveLegacyMock.mockImplementation(async (legacyValue: unknown) => {
      if (legacyValue !== 'comfyui/user/project/request/output.png') return null
      mediaAvailable = true
      return {
        id: 'media-1',
        publicId: 'public-1',
        storageKey: legacyValue,
        url: '/m/public-1',
        mimeType: 'image/png',
      }
    })

    const result = await attachMediaFieldsToStagePayload({
      storyboards: [{
        id: 'storyboard-1',
        panels: [{
          id: 'panel-1',
          imageMediaId: null,
          imageUrl: 'comfyui/user/project/request/output.png',
        }],
      }],
    })

    const storyboard = (result.storyboards as Array<Record<string, unknown>>)[0]
    const panel = (storyboard.panels as Array<Record<string, unknown>>)[0]
    expect(resolveLegacyMock).toHaveBeenCalledWith('comfyui/user/project/request/output.png')
    expect(panel.imageUrl).toBe('/m/public-1')
    expect(panel.imageMedia).toEqual(expect.objectContaining({ id: 'media-1' }))
  })
})
