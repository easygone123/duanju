import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildMockRequest } from '../../../helpers/request'

const authMock = vi.hoisted(() => ({
  requireUserAuth: vi.fn(async () => ({ session: { user: { id: 'user-1' } } })),
  isErrorResponse: vi.fn((value: unknown) => value instanceof Response),
}))

const prismaMock = vi.hoisted(() => {
  const executable = {
    id: 'valid-generation', name: 'Valid generation', mediaType: 'image',
    currentVersionId: 'valid-v1',
    currentVersion: {
      id: 'valid-v1', purpose: 'generation', publishedAt: new Date(), contentHash: 'valid-hash',
      lastSuccessfulTestAt: new Date(), lastTestConnection: { userId: 'user-1' },
    },
  }
  return ({
    userPreference: {
      findUnique: vi.fn(async () => ({ customModels: '[]', customProviders: '[]' })),
    },
    comfyWorkflow: {
      findMany: vi.fn(async () => [
        executable,
        { ...executable, id: 'unpinned', currentVersionId: 'other-v1' },
        { ...executable, id: 'unpublished', currentVersion: { ...executable.currentVersion, publishedAt: null } },
        { ...executable, id: 'no-hash', currentVersion: { ...executable.currentVersion, contentHash: '' } },
        { ...executable, id: 'untested', currentVersion: { ...executable.currentVersion, lastSuccessfulTestAt: null } },
        { ...executable, id: 'other-owner', currentVersion: { ...executable.currentVersion, lastTestConnection: { userId: 'user-2' } } },
      ]),
    },
    comfyWorkflowVersion: { findMany: vi.fn(async () => []) },
  })
})

vi.mock('@/lib/api-auth', () => authMock)
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('@/lib/model-capabilities/catalog', () => ({ findBuiltinCapabilities: vi.fn() }))
vi.mock('@/lib/model-pricing/catalog', () => ({ findBuiltinPricingCatalogEntry: vi.fn() }))

describe('user models ComfyUI executable workflow contract', () => {
  beforeEach(() => vi.clearAllMocks())

  it('exposes only an owned, pinned, published, hashed and successfully tested generation version', async () => {
    const route = await import('@/app/api/user/models/route')
    const response = await route.GET(buildMockRequest({ path: '/api/user/models', method: 'GET' }), {
      params: Promise.resolve({}),
    })

    expect(response.status).toBe(200)
    const payload = await response.json() as { image: Array<{ value: string; workflowVersionId: string }> }
    expect(payload.image).toEqual([expect.objectContaining({
      value: 'comfyui::valid-generation', workflowVersionId: 'valid-v1',
    })])
    expect(prismaMock.comfyWorkflowVersion.findMany).toHaveBeenCalledTimes(0)
  })
})
