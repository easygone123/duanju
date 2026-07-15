import { beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'

import { buildMockRequest } from '../../../helpers/request'
import { installAuthMocks, mockAuthenticated, mockUnauthenticated, resetAuthMockState } from '../../../helpers/auth'
import type { CreateVersionInput } from '@/lib/comfyui/workflow-service'
import { COMFY_ERROR_CODE, ComfyError } from '@/lib/comfyui/errors'

const prismaMock = vi.hoisted(() => ({
  $transaction: vi.fn(),
  comfyWorkflow: {
    findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn(),
  },
  comfyWorkflowVersion: {
    findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn(),
  },
  comfyConnection: { findFirst: vi.fn(), findMany: vi.fn() },
  project: { findFirst: vi.fn() },
  novelPromotionProject: { findUnique: vi.fn(), update: vi.fn() },
  projectComfyBinding: { count: vi.fn(), upsert: vi.fn() },
}))

const redisMock = vi.hoisted(() => ({
  get: vi.fn(), set: vi.fn(), eval: vi.fn(),
}))
const submitPromptMock = vi.hoisted(() => vi.fn())
const getQueueMock = vi.hoisted(() => vi.fn())
const getObjectInfoMock = vi.hoisted(() => vi.fn())
const getModelsMock = vi.hoisted(() => vi.fn())
const getSystemStatsMock = vi.hoisted(() => vi.fn())
const watchPromptMock = vi.hoisted(() => vi.fn())
const getHistoryMock = vi.hoisted(() => vi.fn())
const uploadImageMock = vi.hoisted(() => vi.fn())
const authorizeComfyTargetMock = vi.hoisted(() => vi.fn())
const clientConstructedMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('@/lib/redis', () => ({ redis: redisMock }))
vi.mock('@/lib/crypto-utils', () => ({ decryptApiKey: vi.fn((value: string) => value) }))
vi.mock('@/lib/comfyui/network-policy', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/comfyui/network-policy')>()
  return {
    ...original,
    authorizeComfyTarget: authorizeComfyTargetMock,
  }
})
vi.mock('@/lib/comfyui/client', () => ({
  ComfyClient: class {
    private readonly baseUrl: string

    constructor(options: { baseUrl: string }) {
      clientConstructedMock(options)
      this.baseUrl = options.baseUrl
    }

    getQueue = getQueueMock
    getSystemStats = (signal?: AbortSignal) => getSystemStatsMock(this.baseUrl, signal)
    getObjectInfo = (signal?: AbortSignal) => getObjectInfoMock(signal)
    getModels = (folder: string, signal?: AbortSignal) => getModelsMock(folder, signal)
    submitPrompt = submitPromptMock
    watchPrompt = watchPromptMock
    getHistory = getHistoryMock
    uploadImage = uploadImageMock
  },
}))

const graph = {
  '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model.safetensors' } },
  '2': { class_type: 'SaveImage', inputs: { images: ['1', 0], seed: '${seed}' } },
}
const contract: CreateVersionInput = {
  purpose: 'generation',
  apiFormatJson: graph,
  variableDefinitions: [{ name: 'seed', type: 'number', required: false, defaultValue: 7 }],
  bindings: [],
  outputs: [{ name: 'image', nodeId: '2', fieldPath: 'images', mediaType: 'image', primary: true }],
}

function workflow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'workflow-1', userId: 'user-1', name: 'Portrait', mediaType: 'image', status: 'draft',
    currentVersionId: null, createdAt: new Date('2026-07-11T00:00:00Z'),
    updatedAt: new Date('2026-07-11T00:00:00Z'), versions: [], currentVersion: null,
    ...overrides,
  }
}

function version(overrides: Record<string, unknown> = {}) {
  return {
    id: 'version-1', workflowId: 'workflow-1', version: 1, ...contract,
    requirements: { nodeClasses: ['CheckpointLoaderSimple', 'SaveImage'], candidateLoaderInputs: [
      { nodeId: '1', inputName: 'ckpt_name', value: 'model.safetensors' },
    ] },
    contentHash: 'hash', publishedAt: null, lastSuccessfulTestAt: null,
    lastTestConnectionId: null, createdAt: new Date('2026-07-11T00:00:00Z'), ...overrides,
  }
}

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: 'connection-1', userId: 'user-1', name: 'GPU', normalizedBaseUrl: 'http://example.com',
    authType: 'none', authSecretEncrypted: null, enabled: true, ...overrides,
  }
}

async function body(response: Response) {
  return await response.json() as Record<string, unknown>
}

describe('ComfyUI workflow library', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    resetAuthMockState()
    prismaMock.$transaction.mockImplementation(async (operation: (tx: unknown) => Promise<unknown>) => operation(prismaMock))
    prismaMock.comfyWorkflow.findMany.mockResolvedValue([])
    prismaMock.comfyWorkflow.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.comfyWorkflowVersion.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.projectComfyBinding.count.mockResolvedValue(0)
    redisMock.get.mockResolvedValue(null)
    redisMock.set.mockResolvedValue('OK')
    redisMock.eval.mockResolvedValue(1)
    authorizeComfyTargetMock.mockResolvedValue({ url: new URL('http://example.com'), address: '203.0.113.1', family: 4 })
    getQueueMock.mockResolvedValue({ running: [], pending: [] })
    getObjectInfoMock.mockResolvedValue({
      CheckpointLoaderSimple: { input: { required: { ckpt_name: [['model.safetensors']] } } },
      SaveImage: { input: { required: {} } },
    })
    getModelsMock.mockResolvedValue(['model.safetensors'])
    getSystemStatsMock.mockResolvedValue({ system: { comfyui_version: '0.3.50' } })
    getHistoryMock.mockResolvedValue({ outputs: {
      '2': { images: [{ filename: 'result.png', subfolder: '', type: 'output' }] },
    } })
    uploadImageMock.mockResolvedValue({ name: 'input.png', subfolder: 'waoowaoo', type: 'input' })
    submitPromptMock.mockResolvedValue({ promptId: 'prompt-1' })
    watchPromptMock.mockImplementation(async function* () {
      yield { type: 'executing', promptId: 'prompt-1', nodeId: null }
    })
    process.env.COMFYUI_NETWORK_MODE = 'allowlist'
    process.env.COMFYUI_ALLOWED_HOSTS = 'example.com'
  })

  it('requires authentication before listing workflows', async () => {
    installAuthMocks()
    mockUnauthenticated()
    const route = await import('@/app/api/comfyui/workflows/route')
    const response = await route.GET(buildMockRequest({ path: '/api/comfyui/workflows', method: 'GET' }), { params: Promise.resolve({}) })
    expect(response.status).toBe(401)
    expect(prismaMock.comfyWorkflow.findMany).not.toHaveBeenCalled()
  })

  it('lists only active workflows owned by the authenticated user', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    const route = await import('@/app/api/comfyui/workflows/route')

    const response = await route.GET(buildMockRequest({
      path: '/api/comfyui/workflows', method: 'GET',
    }), { params: Promise.resolve({}) })

    expect(response.status).toBe(200)
    expect(prismaMock.comfyWorkflow.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', status: { not: 'archived' } },
      include: { currentVersion: true, versions: { orderBy: { version: 'desc' } } },
      orderBy: { createdAt: 'asc' },
    })
  })

  it('round-trips an upscale purpose through owned list and get responses', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    const saved = version({ purpose: 'upscale' })
    const record = workflow({
      purpose: 'upscale', versions: [saved], currentVersion: saved,
      currentVersionId: saved.id,
    })
    prismaMock.comfyWorkflow.findMany.mockResolvedValue([record])
    prismaMock.comfyWorkflow.findFirst.mockResolvedValue(record)
    const listRoute = await import('@/app/api/comfyui/workflows/route')
    const detailRoute = await import('@/app/api/comfyui/workflows/[workflowId]/route')

    const listed = await body(await listRoute.GET(buildMockRequest({
      path: '/api/comfyui/workflows', method: 'GET',
    }), { params: Promise.resolve({}) }))
    const detailed = await body(await detailRoute.GET(buildMockRequest({
      path: '/api/comfyui/workflows/workflow-1', method: 'GET',
    }), { params: Promise.resolve({ workflowId: 'workflow-1' }) }))

    expect(listed.workflows).toEqual([
      expect.objectContaining({
        purpose: 'upscale', versions: [expect.objectContaining({ purpose: 'upscale' })],
      }),
    ])
    expect(detailed.workflow).toEqual(expect.objectContaining({
      purpose: 'upscale', currentVersion: expect.objectContaining({ purpose: 'upscale' }),
    }))
  })

  it('creates an owned draft with version one and detailed static validation', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    prismaMock.comfyWorkflow.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => workflow({
      ...data,
      versions: [version({ ...(data.versions as { create: Record<string, unknown> }).create })],
    }))
    const route = await import('@/app/api/comfyui/workflows/route')
    const response = await route.POST(buildMockRequest({
      path: '/api/comfyui/workflows', method: 'POST', body: { name: ' Portrait ', mediaType: 'image', ...contract },
    }), { params: Promise.resolve({}) })
    expect(response.status).toBe(201)
    expect(prismaMock.comfyWorkflow.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      userId: 'user-1', name: 'Portrait', status: 'draft',
      versions: { create: expect.objectContaining({ version: 1, requirements: expect.any(Object), contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) }) },
    }), include: expect.any(Object) })
    expect(await body(response)).toEqual(expect.objectContaining({
      workflow: expect.objectContaining({
        purpose: 'generation', validation: { valid: true, issues: [] },
        versions: [expect.objectContaining({ purpose: 'generation' })],
      }),
    }))
  })

  it('rejects an explicitly invalid purpose at the route boundary', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    const route = await import('@/app/api/comfyui/workflows/route')
    for (const purpose of ['thumbnail']) {
      const payload = { name: 'Invalid purpose', mediaType: 'image', ...contract } as Record<string, unknown>
      if (purpose === undefined) delete payload.purpose
      else payload.purpose = purpose
      const response = await route.POST(buildMockRequest({
        path: '/api/comfyui/workflows', method: 'POST', body: payload,
      }), { params: Promise.resolve({}) })
      expect(response.status).toBe(400)
      expect((await body(response)).error).toEqual(expect.objectContaining({ code: 'INVALID_PARAMS' }))
    }
    expect(prismaMock.comfyWorkflow.create).not.toHaveBeenCalled()
  })

  it('defaults a legacy create request with omitted purpose to generation', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    prismaMock.comfyWorkflow.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => workflow({
      ...data,
      versions: [version({ ...(data.versions as { create: Record<string, unknown> }).create })],
    }))
    const legacy = { name: 'Legacy', mediaType: 'image', ...contract } as Record<string, unknown>
    delete legacy.purpose
    const route = await import('@/app/api/comfyui/workflows/route')
    const response = await route.POST(buildMockRequest({
      path: '/api/comfyui/workflows', method: 'POST', body: legacy,
    }), { params: Promise.resolve({}) })

    expect(response.status).toBe(201)
    expect(await body(response)).toEqual(expect.objectContaining({
      workflow: expect.objectContaining({
        purpose: 'generation', versions: [expect.objectContaining({ purpose: 'generation' })],
      }),
    }))
  })

  it('treats file JSON text and pasted object as the same canonical content', async () => {
    const { canonicalWorkflowHash, parseWorkflowImport } = await import('@/lib/comfyui/workflow-service')
    const pasted = parseWorkflowImport(contract.apiFormatJson)
    const uploaded = parseWorkflowImport(JSON.stringify({ '2': graph['2'], '1': graph['1'] }, null, 2))
    expect(canonicalWorkflowHash({ ...contract, apiFormatJson: pasted })).toBe(
      canonicalWorkflowHash({ ...contract, apiFormatJson: uploaded }),
    )
  })

  it.each(['variableDefinitions', 'bindings', 'outputs'] as const)(
    'rejects a 10k-deep %s contract before canonical recursive sorting',
    async (field) => {
      const { canonicalWorkflowHash } = await import('@/lib/comfyui/workflow-service')
      let deep: Record<string, unknown> = { leaf: true }
      for (let index = 0; index < 10_000; index += 1) deep = { child: deep }
      const hostile = { ...contract, [field]: [deep] } as unknown as CreateVersionInput
      expect(() => canonicalWorkflowHash(hostile)).toThrowError(expect.objectContaining({
        code: 'INVALID_PARAMS',
      }))
    },
  )

  it('rejects excessive total contract bytes outside the graph', async () => {
    const { canonicalWorkflowHash } = await import('@/lib/comfyui/workflow-service')
    expect(() => canonicalWorkflowHash({
      ...contract,
      variableDefinitions: [{
        name: 'huge', type: 'string', required: false, defaultValue: 'x'.repeat(7 * 1024 * 1024),
      }],
    })).toThrowError(expect.objectContaining({ code: 'INVALID_PARAMS' }))
  })

  it('returns validation issues for an invalid draft but does not make it executable', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    const invalid = { ...contract, outputs: [] }
    prismaMock.comfyWorkflow.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => workflow({
      ...data, versions: [version({ ...(data.versions as { create: Record<string, unknown> }).create, ...invalid })],
    }))
    const route = await import('@/app/api/comfyui/workflows/route')
    const response = await route.POST(buildMockRequest({
      path: '/api/comfyui/workflows', method: 'POST', body: { name: 'Invalid', mediaType: 'image', ...invalid },
    }), { params: Promise.resolve({}) })
    expect(response.status).toBe(201)
    expect((await body(response)).workflow).toEqual(expect.objectContaining({
      validation: expect.objectContaining({ valid: false, issues: expect.arrayContaining([
        expect.objectContaining({ code: 'COMFY_OUTPUT_REQUIRED', path: 'outputs' }),
      ]) }),
    }))
  })

  it('creates immutable monotonically increasing versions under an owner-scoped transaction', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    prismaMock.comfyWorkflow.findFirst.mockResolvedValue(workflow())
    prismaMock.comfyWorkflowVersion.findFirst.mockResolvedValue({ version: 4, purpose: 'generation' })
    prismaMock.comfyWorkflowVersion.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => version({ ...data, id: 'version-5' }))
    const route = await import('@/app/api/comfyui/workflows/[workflowId]/versions/route')
    const response = await route.POST(buildMockRequest({
      path: '/api/comfyui/workflows/workflow-1/versions', method: 'POST', body: contract,
    }), { params: Promise.resolve({ workflowId: 'workflow-1' }) })
    expect(response.status).toBe(201)
    expect(prismaMock.comfyWorkflowVersion.create).toHaveBeenCalledWith({ data: expect.objectContaining({ workflowId: 'workflow-1', version: 5 }) })
    expect(prismaMock.$transaction).toHaveBeenCalled()
  })

  it('rejects purpose drift when creating a later immutable workflow version', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    prismaMock.comfyWorkflow.findFirst.mockResolvedValue(workflow())
    prismaMock.comfyWorkflowVersion.findFirst.mockResolvedValue({ version: 1, purpose: 'generation' })
    const route = await import('@/app/api/comfyui/workflows/[workflowId]/versions/route')
    const response = await route.POST(buildMockRequest({
      path: '/api/comfyui/workflows/workflow-1/versions', method: 'POST',
      body: { ...contract, purpose: 'upscale' },
    }), { params: Promise.resolve({ workflowId: 'workflow-1' }) })

    expect(response.status).toBe(400)
    expect((await body(response)).error).toEqual(expect.objectContaining({ code: 'INVALID_PARAMS' }))
    expect(prismaMock.comfyWorkflowVersion.create).not.toHaveBeenCalled()
  })

  it.each([
    ['generation', 'generation'],
    ['upscale', 'upscale'],
  ])('inherits %s purpose for a legacy subsequent version request', async (latestPurpose, expected) => {
    installAuthMocks()
    mockAuthenticated('user-1')
    prismaMock.comfyWorkflow.findFirst.mockResolvedValue(workflow())
    prismaMock.comfyWorkflowVersion.findFirst.mockResolvedValue({ version: 1, purpose: latestPurpose })
    prismaMock.comfyWorkflowVersion.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => version({ ...data }))
    const legacy = { ...contract } as Record<string, unknown>
    delete legacy.purpose
    const route = await import('@/app/api/comfyui/workflows/[workflowId]/versions/route')
    const response = await route.POST(buildMockRequest({
      path: '/api/comfyui/workflows/workflow-1/versions', method: 'POST', body: legacy,
    }), { params: Promise.resolve({ workflowId: 'workflow-1' }) })

    expect(response.status).toBe(201)
    expect(prismaMock.comfyWorkflowVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ purpose: expected, version: 2 }),
    })
    expect((await body(response)).version).toEqual(expect.objectContaining({ purpose: expected }))
  })

  it('publishes a static-valid version without requiring a live test', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    prismaMock.comfyWorkflow.findFirst.mockResolvedValue(workflow())
    prismaMock.comfyWorkflowVersion.findFirst.mockResolvedValue(version())
    const route = await import('@/app/api/comfyui/workflows/[workflowId]/publish/route')
    const response = await route.POST(buildMockRequest({
      path: '/api/comfyui/workflows/workflow-1/publish', method: 'POST', body: { versionId: 'version-1' },
    }), { params: Promise.resolve({ workflowId: 'workflow-1' }) })
    expect(response.status).toBe(200)
    expect(prismaMock.comfyWorkflowVersion.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'version-1', workflowId: 'workflow-1', publishedAt: null },
    }))
    expect(prismaMock.comfyWorkflow.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'workflow-1', userId: 'user-1', status: { not: 'archived' } },
      data: { currentVersionId: 'version-1', status: 'published' },
    }))
  })

  it('publishes a valid upscale version without drifting its immutable purpose', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    const upscale = {
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
    prismaMock.comfyWorkflow.findFirst.mockResolvedValue(workflow())
    prismaMock.comfyWorkflowVersion.findFirst.mockResolvedValue(version(upscale))
    const route = await import('@/app/api/comfyui/workflows/[workflowId]/publish/route')
    const response = await route.POST(buildMockRequest({
      path: '/api/comfyui/workflows/workflow-1/publish', method: 'POST',
      body: { versionId: 'version-1' },
    }), { params: Promise.resolve({ workflowId: 'workflow-1' }) })

    expect(response.status).toBe(200)
    expect(prismaMock.comfyWorkflowVersion.updateMany).toHaveBeenCalledWith({
      where: { id: 'version-1', workflowId: 'workflow-1', publishedAt: null },
      data: { publishedAt: expect.any(Date) },
    })
  })

  it.each([
    ['COMFY_UPSCALE_INPUT_REQUIRED', { variableDefinitions: [], bindingSpec: [] }],
    ['COMFY_UPSCALE_OUTPUT_REQUIRED', { outputSpec: [] }],
    ['COMFY_UPSCALE_BINDINGS_INVALID', {
      bindingSpec: [{
        nodeId: 'load', inputPath: 'image', variable: 'source', valueType: 'image_ref',
      }],
    }],
  ])('rejects publishing an invalid upscale version with %s', async (code, override) => {
    installAuthMocks()
    mockAuthenticated('user-1')
    prismaMock.comfyWorkflow.findFirst.mockResolvedValue(workflow())
    prismaMock.comfyWorkflowVersion.findFirst.mockResolvedValue(version({
      purpose: 'upscale',
      apiFormatJson: {
        load: { class_type: 'LoadImage', inputs: { image: 'input.png' } },
        save: { class_type: 'SaveImage', inputs: { images: ['load', 0] } },
      },
      variableDefinitions: [{ name: 'source', type: 'image_ref', required: true }],
      bindingSpec: [{ nodeId: 'load', inputPath: 'image', variable: 'source', valueType: 'image_ref' }],
      outputSpec: [{ name: 'result', nodeId: 'save', fieldPath: 'images', mediaType: 'image', primary: true }],
      ...override,
    }))
    const route = await import('@/app/api/comfyui/workflows/[workflowId]/publish/route')
    const response = await route.POST(buildMockRequest({
      path: '/api/comfyui/workflows/workflow-1/publish', method: 'POST',
      body: { versionId: 'version-1' },
    }), { params: Promise.resolve({ workflowId: 'workflow-1' }) })

    expect(response.status).toBe(400)
    expect((await body(response)).error).toEqual(expect.objectContaining({
      details: expect.objectContaining({
        validationIssues: expect.arrayContaining([expect.objectContaining({ code })]),
      }),
    }))
  })

  it('rejects an untested current version as a project default', async () => {
    prismaMock.comfyWorkflow.findFirst.mockResolvedValue(workflow({
      status: 'published',
      currentVersionId: 'version-1',
      currentVersion: version({ publishedAt: new Date('2026-07-11T01:00:00Z') }),
    }))
    const { assertWorkflowCanBeProjectDefault } = await import('@/lib/comfyui/workflow-service')
    await expect(assertWorkflowCanBeProjectDefault('user-1', 'workflow-1', 'image'))
      .rejects.toMatchObject({ code: 'CONFLICT' })
    expect(prismaMock.comfyWorkflow.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: 'workflow-1', userId: 'user-1', status: 'published', mediaType: 'image',
        currentVersion: { is: { purpose: 'generation' } },
      },
    }))
  })

  it('atomically binds only a tested owned current version as a project default', async () => {
    prismaMock.project.findFirst.mockResolvedValue({ id: 'project-1', userId: 'user-1' })
    prismaMock.comfyWorkflow.findFirst.mockResolvedValue(workflow({
      status: 'published', currentVersionId: 'version-1',
      currentVersion: version({
        publishedAt: new Date('2026-07-11T01:00:00Z'),
        lastSuccessfulTestAt: new Date('2026-07-11T02:00:00Z'),
        lastTestConnection: { userId: 'user-1' },
      }),
    }))
    prismaMock.projectComfyBinding.upsert.mockResolvedValue({ projectId: 'project-1' })
    const { bindProjectDefaultWorkflow } = await import('@/lib/comfyui/workflow-service')
    await bindProjectDefaultWorkflow('user-1', 'project-1', 'image', 'workflow-1')
    expect(prismaMock.$transaction).toHaveBeenCalled()
    expect(prismaMock.projectComfyBinding.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { projectId_userId: { projectId: 'project-1', userId: 'user-1' } },
      create: expect.objectContaining({
        imageWorkflowId: 'workflow-1', imageWorkflowVersionId: 'version-1',
      }),
      update: { imageWorkflowId: 'workflow-1', imageWorkflowVersionId: 'version-1' },
    }))
  })

  it('updates both pinned defaults and project fields in one serializable transaction', async () => {
    prismaMock.project.findFirst.mockResolvedValue({ id: 'project-1', userId: 'user-1' })
    prismaMock.novelPromotionProject.findUnique.mockResolvedValue({ projectId: 'project-1' })
    prismaMock.novelPromotionProject.update.mockResolvedValue({ projectId: 'project-1', artStyle: 'realistic' })
    prismaMock.comfyWorkflow.findFirst
      .mockResolvedValueOnce(workflow({
        status: 'published', mediaType: 'image', currentVersionId: 'image-v1',
        currentVersion: version({ id: 'image-v1', publishedAt: new Date(),
          lastSuccessfulTestAt: new Date(), lastTestConnection: { userId: 'user-1' } }),
      }))
      .mockResolvedValueOnce(workflow({
        id: 'workflow-video', status: 'published', mediaType: 'video', currentVersionId: 'video-v1',
        currentVersion: version({ id: 'video-v1', workflowId: 'workflow-video', publishedAt: new Date(),
          lastSuccessfulTestAt: new Date(), lastTestConnection: { userId: 'user-1' } }),
      }))
    prismaMock.projectComfyBinding.upsert.mockResolvedValue({ projectId: 'project-1' })

    const { updateProjectWithComfyDefaults } = await import('@/lib/comfyui/workflow-service')
    await updateProjectWithComfyDefaults({
      userId: 'user-1', projectId: 'project-1', projectData: { artStyle: 'realistic' },
      imageWorkflowId: 'workflow-1', videoWorkflowId: 'workflow-video',
    })

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(prismaMock.projectComfyBinding.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        imageWorkflowId: 'workflow-1', imageWorkflowVersionId: 'image-v1',
        videoWorkflowId: 'workflow-video', videoWorkflowVersionId: 'video-v1',
      }),
    }))
    expect(prismaMock.novelPromotionProject.update).toHaveBeenCalledWith({
      where: { projectId: 'project-1' }, data: { artStyle: 'realistic' },
    })
  })

  it('rejects publication of an invalid version with validation details', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    prismaMock.comfyWorkflow.findFirst.mockResolvedValue(workflow())
    prismaMock.comfyWorkflowVersion.findFirst.mockResolvedValue(version({ outputSpec: [] }))
    const route = await import('@/app/api/comfyui/workflows/[workflowId]/publish/route')
    const response = await route.POST(buildMockRequest({
      path: '/api/comfyui/workflows/workflow-1/publish', method: 'POST', body: { versionId: 'version-1' },
    }), { params: Promise.resolve({ workflowId: 'workflow-1' }) })
    expect(response.status).toBe(400)
    expect((await body(response)).error).toEqual(expect.objectContaining({ code: 'INVALID_PARAMS' }))
    expect(prismaMock.comfyWorkflow.updateMany).not.toHaveBeenCalled()
  })

  it('archives only an owned workflow and refuses one used as a project default', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    prismaMock.comfyWorkflow.findFirst.mockResolvedValue(workflow())
    prismaMock.projectComfyBinding.count.mockResolvedValueOnce(1).mockResolvedValueOnce(0)
    const route = await import('@/app/api/comfyui/workflows/[workflowId]/route')
    const request = () => buildMockRequest({ path: '/api/comfyui/workflows/workflow-1', method: 'DELETE' })
    const conflict = await route.DELETE(request(), { params: Promise.resolve({ workflowId: 'workflow-1' }) })
    expect(conflict.status).toBe(409)
    expect((await body(conflict)).error).toEqual(expect.objectContaining({
      code: 'CONFLICT',
      details: expect.objectContaining({ reason: 'COMFY_WORKFLOW_PROJECT_DEFAULT_CONFLICT' }),
    }))
    expect((await route.DELETE(request(), { params: Promise.resolve({ workflowId: 'workflow-1' }) })).status).toBe(200)
    expect(prismaMock.comfyWorkflow.updateMany).toHaveBeenCalledWith({
      where: { id: 'workflow-1', userId: 'user-1', status: { not: 'archived' } },
      data: { status: 'archived' },
    })
  })

  it('returns 404 without reading versions when another user addresses a workflow', async () => {
    installAuthMocks()
    mockAuthenticated('user-2')
    prismaMock.comfyWorkflow.findFirst.mockResolvedValue(null)
    const route = await import('@/app/api/comfyui/workflows/[workflowId]/versions/route')
    const response = await route.POST(buildMockRequest({
      path: '/api/comfyui/workflows/workflow-1/versions', method: 'POST', body: contract,
    }), { params: Promise.resolve({ workflowId: 'workflow-1' }) })
    expect(response.status).toBe(404)
    expect(prismaMock.comfyWorkflowVersion.findFirst).not.toHaveBeenCalled()
  })

  it('persists strict owned workflow metadata and keeps media type immutable', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    prismaMock.comfyWorkflow.findFirst.mockResolvedValue(workflow())
    const route = await import('@/app/api/comfyui/workflows/[workflowId]/route')
    const response = await route.PATCH(buildMockRequest({
      path: '/api/comfyui/workflows/workflow-1', method: 'PATCH', body: { name: ' Renamed portrait ' },
    }), { params: Promise.resolve({ workflowId: 'workflow-1' }) })
    expect(response.status).toBe(200)
    expect(prismaMock.comfyWorkflow.updateMany).toHaveBeenCalledWith({
      where: { id: 'workflow-1', userId: 'user-1', status: { not: 'archived' } },
      data: { name: 'Renamed portrait' },
    })
    expect((await route.PATCH(buildMockRequest({
      path: '/api/comfyui/workflows/workflow-1', method: 'PATCH', body: { mediaType: 'video' },
    }), { params: Promise.resolve({ workflowId: 'workflow-1' }) })).status).toBe(400)
  })

  it('returns exact compatibility for each enabled owned connection', async () => {
    const routePath = 'src/app/api/comfyui/workflows/[workflowId]/versions/[versionId]/compatibility/route.ts'
    expect(existsSync(routePath)).toBe(true)
    installAuthMocks()
    mockAuthenticated('user-1')
    prismaMock.comfyWorkflow.findFirst.mockResolvedValue(workflow())
    prismaMock.comfyWorkflowVersion.findFirst.mockResolvedValue(version())
    prismaMock.comfyConnection.findMany.mockResolvedValue([
      connection(), connection({ id: 'connection-2', name: 'Second GPU' }),
    ])
    const route = await import('@/app/api/comfyui/workflows/[workflowId]/versions/[versionId]/compatibility/route')
    const response = await route.GET(buildMockRequest({
      path: '/api/comfyui/workflows/workflow-1/versions/version-1/compatibility', method: 'GET',
    }), { params: Promise.resolve({ workflowId: 'workflow-1', versionId: 'version-1' }) })
    expect(response.status).toBe(200)
    expect(await body(response)).toEqual({ compatibility: [
      expect.objectContaining({ connectionId: 'connection-1', status: 'online', compatible: true,
        missingNodes: [], missingModels: [], workflowHash: 'hash', capabilityFingerprint: expect.any(String) }),
      expect.objectContaining({ connectionId: 'connection-2', status: 'online', compatible: true }),
    ], nextCursor: null })
    expect(prismaMock.comfyConnection.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'user-1' },
    }))
  })

  it('lists disabled owned connections without probing ComfyUI or exposing another owner', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    prismaMock.comfyWorkflow.findFirst.mockResolvedValue(workflow())
    prismaMock.comfyWorkflowVersion.findFirst.mockResolvedValue(version())
    prismaMock.comfyConnection.findMany.mockResolvedValue([
      connection({ id: 'disabled-1', name: 'Paused GPU', enabled: false }),
    ])
    const route = await import('@/app/api/comfyui/workflows/[workflowId]/versions/[versionId]/compatibility/route')
    const response = await route.GET(buildMockRequest({
      path: '/api/comfyui/workflows/workflow-1/versions/version-1/compatibility', method: 'GET',
    }), { params: Promise.resolve({ workflowId: 'workflow-1', versionId: 'version-1' }) })

    expect(response.status).toBe(200)
    expect(await body(response)).toEqual({ compatibility: [expect.objectContaining({
      connectionId: 'disabled-1', connectionName: 'Paused GPU', status: 'disabled', compatible: false,
    })], nextCursor: null })
    expect(prismaMock.comfyConnection.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'user-1' },
    }))
    expect(getSystemStatsMock).not.toHaveBeenCalled()
    expect(authorizeComfyTargetMock).not.toHaveBeenCalled()
  })

  it('paginates compatibility probes with a bounded stable cursor page', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    prismaMock.comfyWorkflow.findFirst.mockResolvedValue(workflow())
    prismaMock.comfyWorkflowVersion.findFirst.mockResolvedValue(version())
    prismaMock.comfyConnection.findMany.mockResolvedValue([
      connection({ id: 'connection-1' }),
      connection({ id: 'connection-2' }),
      connection({ id: 'connection-3' }),
    ])
    const route = await import('@/app/api/comfyui/workflows/[workflowId]/versions/[versionId]/compatibility/route')
    const response = await route.GET(buildMockRequest({
      path: '/api/comfyui/workflows/workflow-1/versions/version-1/compatibility', method: 'GET', query: { limit: 2 },
    }), { params: Promise.resolve({ workflowId: 'workflow-1', versionId: 'version-1' }) })
    const payload = await body(response)
    expect((payload.compatibility as Array<{ connectionId: string }>).map((item) => item.connectionId))
      .toEqual(['connection-1', 'connection-2'])
    expect(payload.nextCursor).toBe('connection-2')
    expect(prismaMock.comfyConnection.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 3 }))
  })

  it('returns a bounded timeout row when the request-level compatibility deadline aborts a probe', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    prismaMock.comfyWorkflow.findFirst.mockResolvedValue(workflow())
    prismaMock.comfyWorkflowVersion.findFirst.mockResolvedValue(version())
    prismaMock.comfyConnection.findMany.mockResolvedValue([connection()])
    getSystemStatsMock.mockImplementation((_url: string, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    }))
    const { listOwnedWorkflowCompatibility } = await import('@/lib/comfyui/workflow-compatibility-service')
    const page = await listOwnedWorkflowCompatibility('user-1', 'workflow-1', 'version-1', { limit: 1, deadlineMs: 5 })
    expect(page.compatibility).toEqual([expect.objectContaining({ connectionId: 'connection-1', status: 'timeout' })])
  })

  it('rejects cross-workflow version pairing before probing connections', async () => {
    const routePath = 'src/app/api/comfyui/workflows/[workflowId]/versions/[versionId]/compatibility/route.ts'
    expect(existsSync(routePath)).toBe(true)
    installAuthMocks()
    mockAuthenticated('user-1')
    prismaMock.comfyWorkflow.findFirst.mockResolvedValue(workflow())
    prismaMock.comfyWorkflowVersion.findFirst.mockResolvedValue(null)
    const route = await import('@/app/api/comfyui/workflows/[workflowId]/versions/[versionId]/compatibility/route')
    const response = await route.GET(buildMockRequest({ path: '/api/comfyui/workflows/workflow-1/versions/foreign/compatibility', method: 'GET' }), {
      params: Promise.resolve({ workflowId: 'workflow-1', versionId: 'foreign' }),
    })
    expect(response.status).toBe(404)
    expect(prismaMock.comfyConnection.findMany).not.toHaveBeenCalled()
  })

  it('returns exact missing nodes/models and distinguishes auth failure from offline', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    const currentErrors = await import('@/lib/comfyui/errors')
    prismaMock.comfyWorkflow.findFirst.mockResolvedValue(workflow())
    prismaMock.comfyWorkflowVersion.findFirst.mockResolvedValue(version())
    prismaMock.comfyConnection.findMany.mockResolvedValue([
      connection({ id: 'incompatible', normalizedBaseUrl: 'http://incompatible.example.com' }),
      connection({ id: 'auth', normalizedBaseUrl: 'http://auth.example.com' }),
      connection({ id: 'offline', normalizedBaseUrl: 'http://offline.example.com' }),
    ])
    getSystemStatsMock.mockImplementation(async (baseUrl: string) => {
      if (baseUrl === 'http://auth.example.com') {
        throw new currentErrors.ComfyError(currentErrors.COMFY_ERROR_CODE.AUTH_FAILED, 'denied')
      }
      if (baseUrl === 'http://offline.example.com') throw new Error('offline')
      return { system: {} }
    })
    getObjectInfoMock.mockResolvedValueOnce({
      CheckpointLoaderSimple: { input: { required: { ckpt_name: [['other.safetensors']] } } },
    })
    const route = await import('@/app/api/comfyui/workflows/[workflowId]/versions/[versionId]/compatibility/route')
    const response = await route.GET(buildMockRequest({
      path: '/api/comfyui/workflows/workflow-1/versions/version-1/compatibility', method: 'GET',
    }), { params: Promise.resolve({ workflowId: 'workflow-1', versionId: 'version-1' }) })
    expect(await body(response)).toEqual({ compatibility: [
      expect.objectContaining({ connectionId: 'incompatible', status: 'online', compatible: false,
        missingNodes: ['SaveImage'], missingModels: [{ nodeId: '1', field: 'ckpt_name', value: 'model.safetensors' }] }),
      expect.objectContaining({ connectionId: 'auth', status: 'auth_failed', compatible: false }),
      expect.objectContaining({ connectionId: 'offline', status: 'offline', compatible: false }),
    ], nextCursor: null })
  })

  it('live-tests an owned compatible version on an idle owned connection and always releases its lease', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    prismaMock.comfyWorkflow.findFirst.mockResolvedValue(workflow())
    prismaMock.comfyWorkflowVersion.findFirst.mockResolvedValue(version())
    prismaMock.comfyConnection.findFirst.mockResolvedValue(connection())
    const route = await import('@/app/api/comfyui/workflows/[workflowId]/test-run/route')
    const response = await route.POST(buildMockRequest({
      path: '/api/comfyui/workflows/workflow-1/test-run', method: 'POST',
      body: { versionId: 'version-1', connectionId: 'connection-1', variables: { seed: 11 } },
    }), { params: Promise.resolve({ workflowId: 'workflow-1' }) })
    expect(response.status).toBe(200)
    expect(redisMock.set).toHaveBeenCalledWith('comfy:lease:connection-1', expect.stringContaining('test-run'), 'PX', expect.any(Number), 'NX')
    expect(submitPromptMock).toHaveBeenCalledWith(expect.objectContaining({
      '2': expect.objectContaining({ inputs: expect.objectContaining({ seed: 11 }) }),
    }), expect.any(String))
    expect(prismaMock.comfyWorkflowVersion.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'version-1', workflowId: 'workflow-1' },
      data: { lastSuccessfulTestAt: expect.any(Date), lastTestConnectionId: 'connection-1' },
    }))
    expect(getHistoryMock).toHaveBeenCalledWith('prompt-1')
    expect(redisMock.eval).toHaveBeenCalled()
  })

  it('live-tests with trusted network mode when network variables are absent', async () => {
    delete process.env.COMFYUI_NETWORK_MODE
    delete process.env.COMFYUI_ALLOWED_HOSTS
    delete process.env.COMFYUI_ALLOWED_CIDRS
    installAuthMocks()
    mockAuthenticated('user-1')
    prismaMock.comfyWorkflow.findFirst.mockResolvedValue(workflow())
    prismaMock.comfyWorkflowVersion.findFirst.mockResolvedValue(version())
    prismaMock.comfyConnection.findFirst.mockResolvedValue(connection())
    const route = await import('@/app/api/comfyui/workflows/[workflowId]/test-run/route')

    const response = await route.POST(buildMockRequest({
      path: '/api/comfyui/workflows/workflow-1/test-run', method: 'POST',
      body: { versionId: 'version-1', connectionId: 'connection-1', variables: { seed: 11 } },
    }), { params: Promise.resolve({ workflowId: 'workflow-1' }) })

    expect(response.status).toBe(200)
    expect(clientConstructedMock).toHaveBeenCalledWith(expect.objectContaining({
      networkPolicy: { mode: 'trusted', allowedHosts: [], allowedCidrs: [] },
    }))
  })

  it('renews the owner-matched test lease and refuses success after lease loss', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    prismaMock.comfyWorkflow.findFirst.mockResolvedValue(workflow())
    prismaMock.comfyWorkflowVersion.findFirst.mockResolvedValue(version())
    prismaMock.comfyConnection.findFirst.mockResolvedValue(connection())
    redisMock.eval.mockResolvedValueOnce(0).mockResolvedValue(0)
    const route = await import('@/app/api/comfyui/workflows/[workflowId]/test-run/route')
    const response = await route.POST(buildMockRequest({
      path: '/api/comfyui/workflows/workflow-1/test-run', method: 'POST',
      body: { versionId: 'version-1', connectionId: 'connection-1', variables: { seed: 11 } },
    }), { params: Promise.resolve({ workflowId: 'workflow-1' }) })
    expect(response.status).toBe(409)
    expect(redisMock.eval.mock.calls.some((call) => String(call[0]).includes('pexpire'))).toBe(true)
    expect(prismaMock.comfyWorkflowVersion.updateMany).not.toHaveBeenCalled()
  })

  it('rolls back newly recorded success metadata when the lease is lost during the DB write', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    prismaMock.comfyWorkflow.findFirst.mockResolvedValue(workflow())
    prismaMock.comfyWorkflowVersion.findFirst.mockResolvedValue(version())
    prismaMock.comfyConnection.findFirst.mockResolvedValue(connection())
    redisMock.eval
      .mockResolvedValueOnce(1).mockResolvedValueOnce(1).mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1).mockResolvedValueOnce(1).mockResolvedValueOnce(0)
      .mockResolvedValue(0)
    const route = await import('@/app/api/comfyui/workflows/[workflowId]/test-run/route')
    const response = await route.POST(buildMockRequest({
      path: '/api/comfyui/workflows/workflow-1/test-run', method: 'POST',
      body: { versionId: 'version-1', connectionId: 'connection-1', variables: { seed: 11 } },
    }), { params: Promise.resolve({ workflowId: 'workflow-1' }) })
    expect(response.status).toBe(409)
    expect(prismaMock.comfyWorkflowVersion.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: { lastSuccessfulTestAt: null, lastTestConnectionId: null },
    }))
  })

  it('does not record a successful test when a declared history output is missing', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    prismaMock.comfyWorkflow.findFirst.mockResolvedValue(workflow())
    prismaMock.comfyWorkflowVersion.findFirst.mockResolvedValue(version())
    prismaMock.comfyConnection.findFirst.mockResolvedValue(connection())
    getHistoryMock.mockResolvedValue({ outputs: {} })
    const route = await import('@/app/api/comfyui/workflows/[workflowId]/test-run/route')
    const response = await route.POST(buildMockRequest({
      path: '/api/comfyui/workflows/workflow-1/test-run', method: 'POST',
      body: { versionId: 'version-1', connectionId: 'connection-1', variables: { seed: 11 } },
    }), { params: Promise.resolve({ workflowId: 'workflow-1' }) })
    expect(response.status).toBe(502)
    expect(prismaMock.comfyWorkflowVersion.updateMany).not.toHaveBeenCalled()
  })

  it.each([
    [COMFY_ERROR_CODE.AUTH_FAILED, 400, 'MISSING_CONFIG'],
    [COMFY_ERROR_CODE.EXECUTION_TIMEOUT, 504, 'GENERATION_TIMEOUT'],
    [COMFY_ERROR_CODE.PROMPT_REJECTED, 502, 'EXTERNAL_ERROR'],
  ])('maps %s to stable safe API semantics', async (code, status, apiCode) => {
    installAuthMocks()
    mockAuthenticated('user-1')
    prismaMock.comfyWorkflow.findFirst.mockResolvedValue(workflow())
    prismaMock.comfyWorkflowVersion.findFirst.mockResolvedValue(version())
    prismaMock.comfyConnection.findFirst.mockResolvedValue(connection())
    submitPromptMock.mockRejectedValue(new ComfyError(code, 'remote secret prompt body'))
    const route = await import('@/app/api/comfyui/workflows/[workflowId]/test-run/route')
    const response = await route.POST(buildMockRequest({
      path: '/api/comfyui/workflows/workflow-1/test-run', method: 'POST',
      body: { versionId: 'version-1', connectionId: 'connection-1', variables: { seed: 11 } },
    }), { params: Promise.resolve({ workflowId: 'workflow-1' }) })
    expect(response.status).toBe(status)
    const result = await body(response)
    expect(result.error).toEqual(expect.objectContaining({ code: apiCode }))
    expect(JSON.stringify(result)).not.toContain('remote secret prompt body')
  })

  it('uploads bounded image and video inputs before rendering I2V/V2V live tests', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    const mediaContract: CreateVersionInput = {
      purpose: 'generation',
      apiFormatJson: {
        '1': { class_type: 'LoadImage', inputs: { image: 'placeholder.png' } },
        '2': { class_type: 'SaveVideo', inputs: { images: ['1', 0], video: ['3', 0] } },
        '3': { class_type: 'LoadVideo', inputs: { video: 'placeholder.mp4' } },
      },
      variableDefinitions: [
        { name: 'first_frame', type: 'image_ref', required: true },
        { name: 'source_video', type: 'video_ref', required: true },
      ],
      bindings: [
        { nodeId: '1', inputPath: 'image', variable: 'first_frame', valueType: 'image_ref', transform: 'filename' },
        { nodeId: '3', inputPath: 'video', variable: 'source_video', valueType: 'video_ref', transform: 'filename' },
      ],
      outputs: [{ name: 'video', nodeId: '2', fieldPath: 'gifs', mediaType: 'video', primary: true }],
    }
    prismaMock.comfyWorkflow.findFirst.mockResolvedValue(workflow({ mediaType: 'video' }))
    prismaMock.comfyWorkflowVersion.findFirst.mockResolvedValue(version({
      ...mediaContract,
      bindingSpec: mediaContract.bindings,
      outputSpec: mediaContract.outputs,
      requirements: { nodeClasses: ['LoadImage', 'LoadVideo', 'SaveVideo'], candidateLoaderInputs: [] },
    }))
    prismaMock.comfyConnection.findFirst.mockResolvedValue(connection())
    getObjectInfoMock.mockResolvedValue({
      LoadImage: { input: { required: {} } }, LoadVideo: { input: { required: {} } },
      SaveVideo: { input: { required: {} } },
    })
    getHistoryMock.mockResolvedValue({ outputs: {
      '2': { gifs: [{ filename: 'result.mp4', subfolder: '', type: 'output' }] },
    } })
    uploadImageMock
      .mockResolvedValueOnce({ name: 'input.png', subfolder: 'waoowaoo', type: 'input' })
      .mockResolvedValueOnce({ name: 'input.mp4', subfolder: 'waoowaoo', type: 'input' })
    const route = await import('@/app/api/comfyui/workflows/[workflowId]/test-run/route')
    const response = await route.POST(buildMockRequest({
      path: '/api/comfyui/workflows/workflow-1/test-run', method: 'POST', body: {
        versionId: 'version-1', connectionId: 'connection-1', variables: {
          first_frame: { storageKey: 'inline:first_frame', mimeType: 'image/png', filename: 'input.png' },
          source_video: { storageKey: 'inline:source_video', mimeType: 'video/mp4', filename: 'input.mp4' },
        },
        uploads: {
          first_frame: { filename: 'input.png', contentType: 'image/png', base64: 'AQID' },
          source_video: { filename: 'input.mp4', contentType: 'video/mp4', base64: 'BAUG' },
        },
      },
    }), { params: Promise.resolve({ workflowId: 'workflow-1' }) })
    expect(response.status).toBe(200)
    expect(uploadImageMock).toHaveBeenCalledWith(expect.objectContaining({
      filename: expect.stringMatching(/-input\.png$/), contentType: 'image/png', bytes: new Uint8Array([1, 2, 3]),
    }))
    expect(submitPromptMock).toHaveBeenCalledWith(expect.objectContaining({
      '1': expect.objectContaining({ inputs: { image: 'input.png' } }),
      '3': expect.objectContaining({ inputs: { video: 'input.mp4' } }),
    }), expect.any(String))
  })

  it('rejects oversized, deeply nested, and variable-exploding payloads before DB access', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    const route = await import('@/app/api/comfyui/workflows/route')
    const oversized = { '1': { class_type: 'Node', inputs: { value: 'x'.repeat(4 * 1024 * 1024) } } }
    const oversizedResponse = await route.POST(buildMockRequest({
      path: '/api/comfyui/workflows', method: 'POST',
      body: { name: 'Huge', mediaType: 'image', ...contract, apiFormatJson: oversized },
    }), { params: Promise.resolve({}) })
    expect(oversizedResponse.status).toBe(400)

    let deep: Record<string, unknown> = { value: 'leaf' }
    for (let index = 0; index < 80; index += 1) deep = { child: deep }
    const deepResponse = await route.POST(buildMockRequest({
      path: '/api/comfyui/workflows', method: 'POST',
      body: { name: 'Deep', mediaType: 'image', ...contract, apiFormatJson: deep },
    }), { params: Promise.resolve({}) })
    expect(deepResponse.status).toBe(400)
    expect(prismaMock.comfyWorkflow.create).not.toHaveBeenCalled()

    const testRoute = await import('@/app/api/comfyui/workflows/[workflowId]/test-run/route')
    const variables = Object.fromEntries(Array.from({ length: 1100 }, (_, index) => [`v${index}`, index]))
    const variableResponse = await testRoute.POST(buildMockRequest({
      path: '/api/comfyui/workflows/workflow-1/test-run', method: 'POST',
      body: { versionId: 'version-1', connectionId: 'connection-1', variables },
    }), { params: Promise.resolve({ workflowId: 'workflow-1' }) })
    expect(variableResponse.status).toBe(400)
    expect(prismaMock.comfyWorkflow.findFirst).not.toHaveBeenCalled()
  })

  it.each([
    ['external queue', { queue: { running: [['manual']], pending: [] } }],
    ['existing lease', { lease: 'occupied' }],
    ['missing required node', { objectInfo: { SaveImage: {} } }],
  ])('rejects live test when blocked by %s without submitting', async (_label, rawSetup) => {
    const setup = rawSetup as {
      queue?: { running: unknown[]; pending: unknown[] }
      lease?: string
      objectInfo?: Record<string, unknown>
    }
    installAuthMocks()
    mockAuthenticated('user-1')
    prismaMock.comfyWorkflow.findFirst.mockResolvedValue(workflow())
    prismaMock.comfyWorkflowVersion.findFirst.mockResolvedValue(version())
    prismaMock.comfyConnection.findFirst.mockResolvedValue(connection())
    if (setup.queue) getQueueMock.mockResolvedValue(setup.queue)
    if (setup.lease) redisMock.set.mockResolvedValue(null)
    if (setup.objectInfo) getObjectInfoMock.mockResolvedValue(setup.objectInfo)
    const route = await import('@/app/api/comfyui/workflows/[workflowId]/test-run/route')
    const response = await route.POST(buildMockRequest({
      path: '/api/comfyui/workflows/workflow-1/test-run', method: 'POST',
      body: { versionId: 'version-1', connectionId: 'connection-1', variables: { seed: 11 } },
    }), { params: Promise.resolve({ workflowId: 'workflow-1' }) })
    expect(response.status).toBe(409)
    expect(submitPromptMock).not.toHaveBeenCalled()
  })

  it.each([
    ['ordinary STRING', ['STRING', {}]],
    ['empty enum', [[], { model_folder: 'checkpoints' }]],
    ['malformed schema', { type: 'MODEL' }],
    ['missing field', undefined],
  ])('does not classify a %s loader field as a missing model in live test', async (_label, spec) => {
    installAuthMocks()
    mockAuthenticated('user-1')
    prismaMock.comfyWorkflow.findFirst.mockResolvedValue(workflow())
    prismaMock.comfyWorkflowVersion.findFirst.mockResolvedValue(version())
    prismaMock.comfyConnection.findFirst.mockResolvedValue(connection())
    getObjectInfoMock.mockResolvedValue({
      CheckpointLoaderSimple: {
        input: { required: spec === undefined ? {} : { ckpt_name: spec } },
      },
      SaveImage: { input: { required: {} } },
    })
    const route = await import('@/app/api/comfyui/workflows/[workflowId]/test-run/route')
    const response = await route.POST(buildMockRequest({
      path: '/api/comfyui/workflows/workflow-1/test-run', method: 'POST',
      body: { versionId: 'version-1', connectionId: 'connection-1', variables: { seed: 11 } },
    }), { params: Promise.resolve({ workflowId: 'workflow-1' }) })

    expect(response.status).toBe(200)
    expect(submitPromptMock).toHaveBeenCalledOnce()
  })

  it('releases the test lease when execution fails and does not record success', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    prismaMock.comfyWorkflow.findFirst.mockResolvedValue(workflow())
    prismaMock.comfyWorkflowVersion.findFirst.mockResolvedValue(version())
    prismaMock.comfyConnection.findFirst.mockResolvedValue(connection())
    submitPromptMock.mockRejectedValue(new Error('secret prompt content'))
    const route = await import('@/app/api/comfyui/workflows/[workflowId]/test-run/route')
    const response = await route.POST(buildMockRequest({
      path: '/api/comfyui/workflows/workflow-1/test-run', method: 'POST',
      body: { versionId: 'version-1', connectionId: 'connection-1', variables: { seed: 11 } },
    }), { params: Promise.resolve({ workflowId: 'workflow-1' }) })
    expect(response.status).toBe(500)
    expect(JSON.stringify(await body(response))).not.toContain('secret prompt content')
    expect(redisMock.eval).toHaveBeenCalled()
    expect(prismaMock.comfyWorkflowVersion.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ lastSuccessfulTestAt: expect.anything() }),
    }))
  })
})
