import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildMockRequest } from '../../../helpers/request'

const authMock = vi.hoisted(() => ({
  requireUserAuth: vi.fn(async () => ({ session: { user: { id: 'user-1' } } })),
  isErrorResponse: vi.fn((value: unknown) => value instanceof Response),
}))

const prismaMock = vi.hoisted(() => ({
  userPreference: {
    findUnique: vi.fn(async () => ({ customModels: '[]', customProviders: '[]' })),
  },
  comfyWorkflow: {
    findMany: vi.fn(async () => [
      { id: 'image-workflow', name: 'Portrait workflow', mediaType: 'image' },
      { id: 'video-workflow', name: 'Video workflow', mediaType: 'video' },
    ]),
  },
}))

vi.mock('@/lib/api-auth', () => authMock)
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('@/lib/model-capabilities/catalog', () => ({ findBuiltinCapabilities: vi.fn() }))
vi.mock('@/lib/model-pricing/catalog', () => ({ findBuiltinPricingCatalogEntry: vi.fn() }))

describe('api specific - dynamic ComfyUI user models', () => {
  beforeEach(() => vi.clearAllMocks())

  it('lists owned published workflows in their image and video groups without a provider key', async () => {
    const route = await import('@/app/api/user/models/route')
    const response = await route.GET(buildMockRequest({ path: '/api/user/models', method: 'GET' }), {
      params: Promise.resolve({}),
    })

    expect(response.status).toBe(200)
    const payload = await response.json() as Record<string, Array<Record<string, unknown>>>
    expect(payload.image).toContainEqual({
      value: 'comfyui::image-workflow',
      label: 'Portrait workflow',
      provider: 'comfyui',
      providerName: 'ComfyUI',
    })
    expect(payload.video).toContainEqual({
      value: 'comfyui::video-workflow',
      label: 'Video workflow',
      provider: 'comfyui',
      providerName: 'ComfyUI',
    })
    expect(prismaMock.comfyWorkflow.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', status: 'published' },
      select: { id: true, name: true, mediaType: true },
      orderBy: [{ mediaType: 'asc' }, { name: 'asc' }, { id: 'asc' }],
    })
  })

  it('does not copy workflow graphs into user customModels', async () => {
    const route = await import('@/app/api/user/models/route')
    await route.GET(buildMockRequest({ path: '/api/user/models', method: 'GET' }), {
      params: Promise.resolve({}),
    })

    expect(prismaMock.userPreference.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      select: { customModels: true, customProviders: true },
    }))
    expect(prismaMock.userPreference).not.toHaveProperty('update')
  })
})
