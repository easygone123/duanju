import { beforeEach, describe, expect, it, vi } from 'vitest'

const prismaMock = vi.hoisted(() => ({
  mediaObject: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  },
}))
const deleteObjectMock = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('@/lib/storage', () => ({
  deleteObject: deleteObjectMock,
  extractStorageKey: vi.fn(),
}))

import { deleteMediaObjectIfUnreferenced } from '@/lib/media/service'

describe('deleteMediaObjectIfUnreferenced', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    prismaMock.mediaObject.findUnique.mockResolvedValue({
      id: 'media-1',
      storageKey: 'voice/old.wav',
    })
  })

  it('deletes the storage object only after the unreferenced media row is claimed', async () => {
    prismaMock.mediaObject.deleteMany.mockResolvedValueOnce({ count: 1 })

    await expect(deleteMediaObjectIfUnreferenced({
      mediaId: 'media-1',
      expectedStorageKey: 'voice/old.wav',
    })).resolves.toBe(true)

    expect(prismaMock.mediaObject.deleteMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: 'media-1',
        storageKey: 'voice/old.wav',
        novelPromotionVoiceLineAudios: { none: {} },
        voicePresetAudios: { none: {} },
      }),
    }))
    expect(deleteObjectMock).toHaveBeenCalledWith('voice/old.wav')
  })

  it('preserves a shared media object when the unreferenced claim matches no row', async () => {
    prismaMock.mediaObject.deleteMany.mockResolvedValueOnce({ count: 0 })

    await expect(deleteMediaObjectIfUnreferenced({ mediaId: 'media-1' })).resolves.toBe(false)

    expect(deleteObjectMock).not.toHaveBeenCalled()
  })
})
