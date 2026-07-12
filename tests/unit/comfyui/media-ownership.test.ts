import { describe, expect, it, vi } from 'vitest'

import { resolveOwnedComfyMedia } from '@/lib/comfyui/media-ownership'

describe('ComfyUI media ownership resolver', () => {
  it('queries registered media by exact key, expected type, project and user relations', async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: 'media-1' })
    await expect(resolveOwnedComfyMedia({
      userId: 'user-1', projectId: 'project-1', storageKey: 'images/owned.png', mediaType: 'image',
    }, { findFirst })).resolves.toBe(true)
    expect(findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        storageKey: 'images/owned.png', mimeType: { startsWith: 'image/' },
        OR: expect.any(Array),
      }),
      select: { id: true },
    })
  })

  it('rejects unregistered and URL-like values without guessing or fetching', async () => {
    const findFirst = vi.fn().mockResolvedValue(null)
    await expect(resolveOwnedComfyMedia({
      userId: 'user-1', projectId: 'project-1', storageKey: 'images/missing.png', mediaType: 'image',
    }, { findFirst })).resolves.toBe(false)
    await expect(resolveOwnedComfyMedia({
      userId: 'user-1', projectId: 'project-1', storageKey: 'https://example.com/a.png', mediaType: 'image',
    }, { findFirst })).resolves.toBe(false)
    expect(findFirst).toHaveBeenCalledTimes(1)
  })

  it('accepts ownership through six-grid sheet, crop, and upscale relations', async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: 'media-1' })
    await resolveOwnedComfyMedia({
      userId: 'user-1', projectId: 'project-1', storageKey: 'six-grid/source.png', mediaType: 'image',
    }, { findFirst })
    const where = findFirst.mock.calls[0]?.[0]?.where
    expect(where.OR).toEqual(expect.arrayContaining([
      expect.objectContaining({ novelPromotionPanelCroppedImages: expect.any(Object) }),
      expect.objectContaining({ novelPromotionPanelUpscaledImages: expect.any(Object) }),
      expect.objectContaining({ novelPromotionStoryboardSheetImages: expect.any(Object) }),
      expect.objectContaining({ novelPromotionStoryboardUpscaledSheetImages: expect.any(Object) }),
    ]))
  })
})
