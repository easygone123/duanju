import { beforeEach, describe, expect, it, vi } from 'vitest'

const prismaMock = vi.hoisted(() => ({
  mediaObject: { findFirst: vi.fn() },
  characterAppearance: { findFirst: vi.fn(), updateMany: vi.fn() },
  locationImage: { findFirst: vi.fn(), updateMany: vi.fn() },
  globalCharacterAppearance: { findFirst: vi.fn(), updateMany: vi.fn() },
  globalLocationImage: { findFirst: vi.fn(), updateMany: vi.fn() },
}))

const mediaServiceMock = vi.hoisted(() => ({
  ensureMediaObjectFromStorageKey: vi.fn(async (storageKey: string) => ({
    id: 'media-legacy',
    storageKey,
    mimeType: 'image/png',
  })),
  guessMimeTypeFromStorageKey: vi.fn((storageKey: string) => (
    storageKey.endsWith('.png') ? 'image/png' : storageKey.endsWith('.mp4') ? 'video/mp4' : null
  )),
  resolveStorageKeyFromMediaValue: vi.fn(async () => null),
}))

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('@/lib/media/service', () => mediaServiceMock)

import { resolveOwnedComfyMediaRefFromValue } from '@/lib/comfyui/media-ownership'

describe('ComfyUI legacy asset media repair', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    prismaMock.mediaObject.findFirst.mockResolvedValue(null)
    prismaMock.characterAppearance.findFirst.mockResolvedValue({ id: 'appearance-legacy' })
    prismaMock.locationImage.findFirst.mockResolvedValue(null)
    prismaMock.globalCharacterAppearance.findFirst.mockResolvedValue(null)
    prismaMock.globalLocationImage.findFirst.mockResolvedValue(null)
    prismaMock.characterAppearance.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.locationImage.updateMany.mockResolvedValue({ count: 0 })
    prismaMock.globalCharacterAppearance.updateMany.mockResolvedValue({ count: 0 })
    prismaMock.globalLocationImage.updateMany.mockResolvedValue({ count: 0 })
  })

  it('proves exact owner-and-project scope before creating and linking legacy media', async () => {
    await expect(resolveOwnedComfyMediaRefFromValue({
      userId: 'user-1', projectId: 'project-1', mediaType: 'image',
      value: '/api/storage/sign?key=images%2Flegacy.png&expires=3600',
    })).resolves.toEqual({ storageKey: 'images/legacy.png', mimeType: 'image/png' })

    const projectScope = {
      imageUrl: 'images/legacy.png',
      character: {
        novelPromotionProject: {
          projectId: 'project-1',
          project: { userId: 'user-1' },
        },
      },
    }
    expect(prismaMock.characterAppearance.findFirst).toHaveBeenCalledWith({
      where: projectScope,
      select: { id: true },
    })
    expect(prismaMock.characterAppearance.findFirst.mock.invocationCallOrder[0]).toBeLessThan(
      mediaServiceMock.ensureMediaObjectFromStorageKey.mock.invocationCallOrder[0],
    )
    expect(mediaServiceMock.ensureMediaObjectFromStorageKey).toHaveBeenCalledWith(
      'images/legacy.png',
      { mimeType: 'image/png' },
    )
    expect(prismaMock.characterAppearance.updateMany).toHaveBeenCalledWith({
      where: { id: 'appearance-legacy', ...projectScope },
      data: { imageMediaId: 'media-legacy' },
    })
  })

  it('repairs an exact user-owned global character without requiring a project relation', async () => {
    prismaMock.characterAppearance.findFirst.mockResolvedValue(null)
    prismaMock.globalCharacterAppearance.findFirst.mockResolvedValue({ id: 'global-appearance-1' })
    prismaMock.globalCharacterAppearance.updateMany.mockResolvedValue({ count: 1 })

    await expect(resolveOwnedComfyMediaRefFromValue({
      userId: 'user-1', projectId: 'project-1', mediaType: 'image',
      value: '/api/storage/sign?key=images%2Flegacy.png',
    })).resolves.toEqual({ storageKey: 'images/legacy.png', mimeType: 'image/png' })

    expect(prismaMock.globalCharacterAppearance.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'global-appearance-1',
        imageUrl: 'images/legacy.png',
        character: { userId: 'user-1' },
      },
      data: { imageMediaId: 'media-legacy' },
    })
  })

  it('fails closed when the exact key has no asset in the requested scope', async () => {
    prismaMock.characterAppearance.findFirst.mockResolvedValue(null)

    await expect(resolveOwnedComfyMediaRefFromValue({
      userId: 'user-1', projectId: 'different-project', mediaType: 'image',
      value: '/api/storage/sign?key=images%2Flegacy.png&expires=3600',
    })).resolves.toBeNull()

    expect(mediaServiceMock.ensureMediaObjectFromStorageKey).not.toHaveBeenCalled()
    expect(prismaMock.characterAppearance.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.globalCharacterAppearance.updateMany).not.toHaveBeenCalled()
  })

  it('rejects a non-image key before creating media metadata', async () => {
    await expect(resolveOwnedComfyMediaRefFromValue({
      userId: 'user-1', projectId: 'project-1', mediaType: 'image',
      value: '/api/storage/sign?key=videos%2Flegacy.mp4',
    })).resolves.toBeNull()

    expect(prismaMock.characterAppearance.findFirst).not.toHaveBeenCalled()
    expect(mediaServiceMock.ensureMediaObjectFromStorageKey).not.toHaveBeenCalled()
  })
})
