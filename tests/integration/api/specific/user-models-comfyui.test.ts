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
    findMany: vi.fn(async (): Promise<Array<Record<string, unknown>>> => [
      { id: 'image-workflow', name: 'Portrait workflow', mediaType: 'image', currentVersionId: 'image-v1', currentVersion: { id: 'image-v1', purpose: 'generation', publishedAt: new Date(), contentHash: 'image-hash', lastSuccessfulTestAt: new Date(), lastTestConnection: { userId: 'user-1' } } },
      {
        id: 'video-workflow', name: 'Video workflow', mediaType: 'video', currentVersionId: 'video-v1',
        currentVersion: {
          id: 'video-v1', purpose: 'generation', publishedAt: new Date(), contentHash: 'video-hash',
          lastSuccessfulTestAt: new Date(), lastTestConnection: { userId: 'user-1' },
          variableDefinitions: [
            { name: 'firstFrame', type: 'image_ref', required: true },
            { name: 'lastFrame', type: 'image_ref', required: true },
          ],
          bindingSpec: [
            { nodeId: '1', inputPath: 'image', variable: 'firstFrame', valueType: 'image_ref' },
            { nodeId: '2', inputPath: 'image', variable: 'lastFrame', valueType: 'image_ref' },
          ],
        },
      },
    ]),
  },
  comfyWorkflowVersion: {
    findMany: vi.fn(async (): Promise<Array<Record<string, unknown>>> => []),
  },
}))

vi.mock('@/lib/api-auth', () => authMock)
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('@/lib/model-capabilities/catalog', () => ({ findBuiltinCapabilities: vi.fn() }))
vi.mock('@/lib/model-pricing/catalog', () => ({ findBuiltinPricingCatalogEntry: vi.fn() }))

describe('api specific - dynamic ComfyUI user models', () => {
  beforeEach(() => vi.clearAllMocks())

  it('lists only owned, pinned, published, successfully tested workflows without loading generation graphs', async () => {
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
      workflowPurpose: 'generation',
      workflowVersionId: 'image-v1',
    })
    expect(payload.video).toContainEqual({
      value: 'comfyui::video-workflow',
      label: 'Video workflow',
      provider: 'comfyui',
      providerName: 'ComfyUI',
      workflowPurpose: 'generation',
      workflowVersionId: 'video-v1',
      capabilities: { video: { firstlastframe: true } },
    })
    expect(prismaMock.comfyWorkflow.findMany).toHaveBeenCalledWith({
      where: {
        userId: 'user-1', status: 'published', currentVersionId: { not: null },
        currentVersion: { is: { publishedAt: { not: null } } },
      },
      select: {
        id: true, name: true, mediaType: true, currentVersionId: true,
        currentVersion: {
          select: {
            id: true, purpose: true, publishedAt: true, contentHash: true, lastSuccessfulTestAt: true,
            variableDefinitions: true, bindingSpec: true,
            lastTestConnection: { select: { userId: true } },
          },
        },
      },
      orderBy: [{ mediaType: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      take: 500,
    })
    expect(prismaMock.comfyWorkflowVersion.findMany).not.toHaveBeenCalled()
  })

  it('discovers only a published statically valid upscale workflow in the upscale group', async () => {
    const validVersion = {
      purpose: 'upscale',
      apiFormatJson: {
        load: { class_type: 'LoadImage', inputs: { image: 'input.png' } },
        save: { class_type: 'SaveImage', inputs: { images: ['load', 0] } },
      },
      variableDefinitions: [{ name: 'source', type: 'image_ref', required: true }],
      bindingSpec: [{
        nodeId: 'load', inputPath: 'image', variable: 'source',
        valueType: 'image_ref', transform: 'filename',
      }],
      outputSpec: [{
        name: 'result', nodeId: 'save', fieldPath: 'images', mediaType: 'image', primary: true,
      }],
    }
    prismaMock.comfyWorkflow.findMany.mockResolvedValueOnce([
      { id: 'generation', name: 'Generate', mediaType: 'image', currentVersionId: 'generation-v1', currentVersion: { id: 'generation-v1', purpose: 'generation', publishedAt: new Date(), contentHash: 'generation-hash', lastSuccessfulTestAt: new Date(), lastTestConnection: { userId: 'user-1' } } },
      { id: 'upscale-valid', name: 'Upscale', mediaType: 'image', currentVersionId: 'upscale-valid-v1', currentVersion: { id: 'upscale-valid-v1', purpose: 'upscale', publishedAt: new Date(), contentHash: 'valid-hash', lastSuccessfulTestAt: new Date(), lastTestConnection: { userId: 'user-1' } } },
      { id: 'upscale-invalid', name: 'Broken upscale', mediaType: 'image', currentVersionId: 'upscale-invalid-v1', currentVersion: { id: 'upscale-invalid-v1', purpose: 'upscale', publishedAt: new Date(), contentHash: 'invalid-hash', lastSuccessfulTestAt: new Date(), lastTestConnection: { userId: 'user-1' } } },
      { id: 'upscale-untransformed', name: 'Unsafe upscale', mediaType: 'image', currentVersionId: 'upscale-untransformed-v1', currentVersion: { id: 'upscale-untransformed-v1', purpose: 'upscale', publishedAt: new Date(), contentHash: 'unsafe-hash', lastSuccessfulTestAt: new Date(), lastTestConnection: { userId: 'user-1' } } },
    ])
    prismaMock.comfyWorkflowVersion.findMany.mockResolvedValueOnce([
      { id: 'upscale-valid-v1', workflowId: 'upscale-valid', ...validVersion },
      { id: 'upscale-invalid-v1', workflowId: 'upscale-invalid', ...validVersion, bindingSpec: [] },
      { id: 'upscale-untransformed-v1', workflowId: 'upscale-untransformed', ...validVersion, bindingSpec: [{
        nodeId: 'load', inputPath: 'image', variable: 'source', valueType: 'image_ref',
      }] },
    ])

    const route = await import('@/app/api/user/models/route')
    const response = await route.GET(buildMockRequest({ path: '/api/user/models', method: 'GET' }), {
      params: Promise.resolve({}),
    })
    const payload = await response.json() as Record<string, Array<Record<string, unknown>>>

    expect(payload.upscale).toEqual([{
      value: 'comfyui::upscale-valid', label: 'Upscale', provider: 'comfyui',
      providerName: 'ComfyUI', workflowPurpose: 'upscale', workflowVersionId: 'upscale-valid-v1',
    }])
    expect(payload.image.map((model) => model.value)).toContain('comfyui::generation')
    expect(payload.image.map((model) => model.value)).not.toContain('comfyui::upscale-valid')
    expect(payload.upscale.map((model) => model.value)).not.toContain('comfyui::upscale-invalid')
    expect(payload.upscale.map((model) => model.value)).not.toContain('comfyui::upscale-untransformed')
    expect(prismaMock.comfyWorkflowVersion.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['upscale-valid-v1', 'upscale-invalid-v1', 'upscale-untransformed-v1'] } },
      select: {
        id: true, workflowId: true, purpose: true, apiFormatJson: true,
        variableDefinitions: true, bindingSpec: true, outputSpec: true,
      },
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
