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
})
