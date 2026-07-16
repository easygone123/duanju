import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const prismaMock = vi.hoisted(() => ({
  novelPromotionCharacter: {
    findFirst: vi.fn(),
    update: vi.fn(),
  },
  characterAppearance: {
    findFirst: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
  },
  novelPromotionLocation: { findFirst: vi.fn(), update: vi.fn() },
  locationImage: { update: vi.fn(), create: vi.fn() },
}))

const storageMock = vi.hoisted(() => ({
  uploadObject: vi.fn(),
  generateUniqueKey: vi.fn(() => 'manual-character.jpg'),
}))

const fontMock = vi.hoisted(() => ({
  initializeFonts: vi.fn(),
  createLabelSVG: vi.fn(async () => Buffer.from('<svg />')),
}))

const sharpMock = vi.hoisted(() => vi.fn(() => ({
  metadata: vi.fn(async () => ({ width: 100, height: 100 })),
  extend: vi.fn().mockReturnThis(),
  composite: vi.fn().mockReturnThis(),
  jpeg: vi.fn().mockReturnThis(),
  toBuffer: vi.fn(async () => Buffer.from('processed')),
})))

const ensureMediaObjectMock = vi.hoisted(() => vi.fn(async () => ({
  id: 'media-manual-character',
})))

vi.mock('@/lib/api-auth', () => ({
  requireProjectAuthLight: vi.fn(async () => ({
    session: { user: { id: 'user-1' } },
    project: { id: 'project-1', userId: 'user-1' },
  })),
  isErrorResponse: (value: unknown) => value instanceof Response,
}))
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('@/lib/storage', () => storageMock)
vi.mock('@/lib/fonts', () => fontMock)
vi.mock('@/lib/media/service', () => ({ ensureMediaObjectFromStorageKey: ensureMediaObjectMock }))
vi.mock('sharp', () => ({ default: sharpMock }))

describe('api specific - pending character manual image upload', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    prismaMock.novelPromotionCharacter.findFirst.mockResolvedValue({
      id: 'character-1', name: '林夏', profileConfirmed: false,
    })
    prismaMock.characterAppearance.upsert.mockResolvedValue({
      id: 'appearance-1', imageUrls: '[]', selectedIndex: null,
    })
    prismaMock.characterAppearance.update.mockResolvedValue({ id: 'appearance-1' })
    prismaMock.novelPromotionCharacter.update.mockResolvedValue({ id: 'character-1' })
  })

  it('creates a primary appearance, uploads the image, and confirms the pending profile', async () => {
    const formData = new FormData()
    formData.append('file', new File([Buffer.from('image')], 'hero.png', { type: 'image/png' }))
    formData.append('type', 'character')
    formData.append('id', 'character-1')
    formData.append('labelText', '林夏')
    const request = new NextRequest(
      'http://localhost/api/novel-promotion/project-1/upload-asset-image',
      { method: 'POST', body: formData },
    )
    const mod = await import('@/app/api/novel-promotion/[projectId]/upload-asset-image/route')

    const response = await mod.POST(request, {
      params: Promise.resolve({ projectId: 'project-1' }),
    })

    expect(response.status).toBe(200)
    expect(prismaMock.novelPromotionCharacter.findFirst).toHaveBeenCalledWith({
      where: { id: 'character-1', novelPromotionProject: { projectId: 'project-1' } },
      select: { id: true, name: true, profileConfirmed: true },
    })
    expect(prismaMock.characterAppearance.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { characterId_appearanceIndex: { characterId: 'character-1', appearanceIndex: 0 } },
    }))
    expect(prismaMock.characterAppearance.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'appearance-1' },
      data: expect.objectContaining({
        imageUrl: 'manual-character.jpg',
        imageMediaId: 'media-manual-character',
      }),
    }))
    expect(prismaMock.novelPromotionCharacter.update).toHaveBeenCalledWith({
      where: { id: 'character-1' },
      data: { profileConfirmed: true },
    })
    expect(await response.json()).toMatchObject({
      success: true,
      appearanceId: 'appearance-1',
      imageKey: 'manual-character.jpg',
    })
  })

  it('rejects a location outside the authenticated project before uploading bytes', async () => {
    prismaMock.novelPromotionLocation.findFirst.mockResolvedValue(null)
    const formData = new FormData()
    formData.append('file', new File([Buffer.from('image')], 'location.png', { type: 'image/png' }))
    formData.append('type', 'location')
    formData.append('id', 'location-from-another-project')
    formData.append('labelText', '错误项目场景')
    const request = new NextRequest(
      'http://localhost/api/novel-promotion/project-1/upload-asset-image',
      { method: 'POST', body: formData },
    )
    const mod = await import('@/app/api/novel-promotion/[projectId]/upload-asset-image/route')

    const response = await mod.POST(request, {
      params: Promise.resolve({ projectId: 'project-1' }),
    })

    expect(response.status).toBe(404)
    expect(prismaMock.novelPromotionLocation.findFirst).toHaveBeenCalledWith({
      where: { id: 'location-from-another-project', novelPromotionProject: { projectId: 'project-1' } },
      include: { images: { orderBy: { imageIndex: 'asc' } } },
    })
    expect(storageMock.uploadObject).not.toHaveBeenCalled()
    expect(ensureMediaObjectMock).not.toHaveBeenCalled()
    expect(prismaMock.locationImage.update).not.toHaveBeenCalled()
    expect(prismaMock.locationImage.create).not.toHaveBeenCalled()
  })
})
