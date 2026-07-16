import { beforeEach, describe, expect, it, vi } from 'vitest'

const prismaMock = vi.hoisted(() => ({
  mediaObject: { findFirst: vi.fn() },
  characterAppearance: { updateMany: vi.fn() },
  locationImage: { updateMany: vi.fn() },
  globalCharacterAppearance: { updateMany: vi.fn() },
  globalLocationImage: { updateMany: vi.fn() },
  $transaction: vi.fn(async (operations: Array<Promise<unknown>>) => Promise.all(operations)),
}))

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))

import { resolveOwnedComfyMediaRefFromValue } from '@/lib/comfyui/media-ownership'

describe('ComfyUI legacy project-asset media repair', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    prismaMock.mediaObject.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'media-legacy', storageKey: 'images/legacy.png', mimeType: 'image/png',
      })
    prismaMock.characterAppearance.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.locationImage.updateMany.mockResolvedValue({ count: 0 })
    prismaMock.globalCharacterAppearance.updateMany.mockResolvedValue({ count: 0 })
    prismaMock.globalLocationImage.updateMany.mockResolvedValue({ count: 0 })
  })

  it('backfills only an exact owner-and-project-scoped legacy character link', async () => {
    await expect(resolveOwnedComfyMediaRefFromValue({
      userId: 'user-1', projectId: 'project-1', mediaType: 'image',
      value: '/api/storage/sign?key=images%2Flegacy.png&expires=3600',
    })).resolves.toEqual({ storageKey: 'images/legacy.png', mimeType: 'image/png' })

    expect(prismaMock.characterAppearance.updateMany).toHaveBeenCalledWith({
      where: {
        imageUrl: 'images/legacy.png',
        character: {
          novelPromotionProject: {
            projectId: 'project-1',
            project: { userId: 'user-1' },
          },
        },
      },
      data: { imageMediaId: 'media-legacy' },
    })
  })

  it('fails closed when the exact storage key has no owned project or global asset link', async () => {
    prismaMock.characterAppearance.updateMany.mockResolvedValue({ count: 0 })
    prismaMock.globalCharacterAppearance.updateMany.mockResolvedValue({ count: 1 })

    await expect(resolveOwnedComfyMediaRefFromValue({
      userId: 'user-1', projectId: 'different-project', mediaType: 'image',
      value: '/api/storage/sign?key=images%2Flegacy.png&expires=3600',
    })).resolves.toBeNull()
    expect(prismaMock.globalCharacterAppearance.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.globalLocationImage.updateMany).not.toHaveBeenCalled()
  })
})
