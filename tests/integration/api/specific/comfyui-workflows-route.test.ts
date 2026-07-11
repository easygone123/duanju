import { beforeEach, describe, expect, it, vi } from 'vitest'

import { buildMockRequest } from '../../../helpers/request'
import { installAuthMocks, mockAuthenticated, mockUnauthenticated, resetAuthMockState } from '../../../helpers/auth'
import type { CreateVersionInput } from '@/lib/comfyui/workflow-service'

const prismaMock = vi.hoisted(() => ({
  $transaction: vi.fn(),
  comfyWorkflow: {
    findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn(),
  },
  comfyWorkflowVersion: {
    findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn(),
  },
  comfyConnection: { findFirst: vi.fn() },
  projectComfyBinding: { count: vi.fn() },
}))

const redisMock = vi.hoisted(() => ({
  get: vi.fn(), set: vi.fn(), eval: vi.fn(),
}))
const submitPromptMock = vi.hoisted(() => vi.fn())
const getQueueMock = vi.hoisted(() => vi.fn())
const getObjectInfoMock = vi.hoisted(() => vi.fn())
const getModelsMock = vi.hoisted(() => vi.fn())
const watchPromptMock = vi.hoisted(() => vi.fn())
const authorizeComfyTargetMock = vi.hoisted(() => vi.fn())

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
    getQueue = getQueueMock
    getObjectInfo = getObjectInfoMock
    getModels = getModelsMock
    submitPrompt = submitPromptMock
    watchPrompt = watchPromptMock
  },
}))

const graph = {
  '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model.safetensors' } },
  '2': { class_type: 'SaveImage', inputs: { images: ['1', 0], seed: '${seed}' } },
}
const contract: CreateVersionInput = {
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
      workflow: expect.objectContaining({ validation: { valid: true, issues: [] } }),
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
    prismaMock.comfyWorkflowVersion.findFirst.mockResolvedValue({ version: 4 })
    prismaMock.comfyWorkflowVersion.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => version({ ...data, id: 'version-5' }))
    const route = await import('@/app/api/comfyui/workflows/[workflowId]/versions/route')
    const response = await route.POST(buildMockRequest({
      path: '/api/comfyui/workflows/workflow-1/versions', method: 'POST', body: contract,
    }), { params: Promise.resolve({ workflowId: 'workflow-1' }) })
    expect(response.status).toBe(201)
    expect(prismaMock.comfyWorkflowVersion.create).toHaveBeenCalledWith({ data: expect.objectContaining({ workflowId: 'workflow-1', version: 5 }) })
    expect(prismaMock.$transaction).toHaveBeenCalled()
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
      where: { id: 'workflow-1', userId: 'user-1', status: 'published', mediaType: 'image' },
    }))
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
    expect((await route.DELETE(request(), { params: Promise.resolve({ workflowId: 'workflow-1' }) })).status).toBe(409)
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
    expect(redisMock.eval).toHaveBeenCalled()
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
    if (setup.lease) redisMock.get.mockResolvedValue(setup.lease)
    if (setup.objectInfo) getObjectInfoMock.mockResolvedValue(setup.objectInfo)
    const route = await import('@/app/api/comfyui/workflows/[workflowId]/test-run/route')
    const response = await route.POST(buildMockRequest({
      path: '/api/comfyui/workflows/workflow-1/test-run', method: 'POST',
      body: { versionId: 'version-1', connectionId: 'connection-1', variables: { seed: 11 } },
    }), { params: Promise.resolve({ workflowId: 'workflow-1' }) })
    expect(response.status).toBe(409)
    expect(submitPromptMock).not.toHaveBeenCalled()
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
