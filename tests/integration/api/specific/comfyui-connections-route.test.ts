import { beforeEach, describe, expect, it, vi } from 'vitest'

import { buildMockRequest } from '../../../helpers/request'
import { installAuthMocks, mockAuthenticated, mockUnauthenticated, resetAuthMockState } from '../../../helpers/auth'

const prismaMock = vi.hoisted(() => ({
  $transaction: vi.fn(),
  comfyConnection: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
  },
  comfyGenerationRequest: {
    count: vi.fn(),
    findFirst: vi.fn(),
    updateMany: vi.fn(),
  },
}))

const encryptApiKeyMock = vi.hoisted(() => vi.fn((value: string) => `encrypted:${value}`))
const decryptApiKeyMock = vi.hoisted(() => vi.fn((value: string) => value.replace(/^encrypted:/, '')))
const authorizeComfyTargetMock = vi.hoisted(() => vi.fn(async (url: string) => ({
  url: new URL(url), address: '203.0.113.10', family: 4 as const,
})))
const clientConstructedMock = vi.hoisted(() => vi.fn())
const getSystemStatsMock = vi.hoisted(() => vi.fn())
const getQueueMock = vi.hoisted(() => vi.fn())
const redisMock = vi.hoisted(() => ({ set: vi.fn(), eval: vi.fn() }))

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('@/lib/redis', () => ({ redis: redisMock }))
vi.mock('@/lib/crypto-utils', () => ({
  encryptApiKey: encryptApiKeyMock,
  decryptApiKey: decryptApiKeyMock,
}))
vi.mock('@/lib/comfyui/network-policy', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/comfyui/network-policy')>()
  return { ...original, authorizeComfyTarget: authorizeComfyTargetMock }
})
vi.mock('@/lib/comfyui/client', () => ({
  ComfyClient: class {
    constructor(options: unknown) {
      clientConstructedMock(options)
    }
    getSystemStats = getSystemStatsMock
    getQueue = getQueueMock
  },
}))

const collectionContext = { params: Promise.resolve({}) }
const connectionContext = (connectionId: string) => ({ params: Promise.resolve({ connectionId }) })

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: 'connection-1',
    userId: 'user-1',
    name: 'Home GPU',
    baseUrl: 'HTTP://Example.COM:80/comfy/',
    normalizedBaseUrl: 'http://example.com/comfy',
    authType: 'bearer',
    authSecretEncrypted: 'encrypted:{"token":"top-secret"}',
    enabled: true,
    lastHealthAt: null,
    lastHealthCode: null,
    lastHealthMessage: null,
    lastSeenVersion: null,
    deviceSummary: null,
    lastAssignedAt: null,
    createdAt: new Date('2026-07-11T08:00:00.000Z'),
    updatedAt: new Date('2026-07-11T08:00:00.000Z'),
    ...overrides,
  }
}

async function responseJson(response: Response) {
  return await response.json() as Record<string, unknown>
}

describe('ComfyUI private connection routes', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    prismaMock.$transaction.mockReset()
    resetAuthMockState()
    process.env.COMFYUI_NETWORK_MODE = 'allowlist'
    process.env.COMFYUI_ALLOWED_HOSTS = 'example.com'
    process.env.COMFYUI_ALLOWED_CIDRS = ''
    delete process.env.COMFYUI_STATUS_PROBE_CONCURRENCY
    prismaMock.comfyConnection.findMany.mockResolvedValue([])
    redisMock.set.mockResolvedValue('OK')
    redisMock.eval.mockResolvedValue(1)
    prismaMock.comfyConnection.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.comfyGenerationRequest.count.mockResolvedValue(0)
    prismaMock.comfyGenerationRequest.findFirst.mockResolvedValue(null)
    prismaMock.comfyGenerationRequest.updateMany.mockResolvedValue({ count: 0 })
    getSystemStatsMock.mockResolvedValue({ system: { comfyui_version: '0.3.50' }, devices: [] })
    getQueueMock.mockResolvedValue({ running: [], pending: [] })
    prismaMock.$transaction.mockImplementation(async (operation: (tx: unknown) => Promise<unknown>) =>
      operation(prismaMock))
  })

  it('returns 401 before listing private connections', async () => {
    installAuthMocks()
    mockUnauthenticated()
    const route = await import('@/app/api/comfyui/connections/route')
    const response = await route.GET(buildMockRequest({
      path: '/api/comfyui/connections', method: 'GET',
    }), collectionContext)

    expect(response.status).toBe(401)
    expect(prismaMock.comfyConnection.findMany).not.toHaveBeenCalled()
  })

  it('lists only the authenticated owner and never returns a secret', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    prismaMock.comfyConnection.findMany.mockResolvedValue([connection()])
    const route = await import('@/app/api/comfyui/connections/route')
    const response = await route.GET(buildMockRequest({
      path: '/api/comfyui/connections', method: 'GET',
    }), collectionContext)

    expect(response.status).toBe(200)
    expect(prismaMock.comfyConnection.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'user-1' },
    }))
    const body = await responseJson(response)
    expect(body.connections).toEqual([expect.objectContaining({
      id: 'connection-1', hasCredentials: true,
    })])
    expect(JSON.stringify(body)).not.toContain('top-secret')
    expect(JSON.stringify(body)).not.toContain('authSecretEncrypted')
    expect(JSON.stringify(body)).not.toContain('userId')
  })

  it('uses explicit runtime policy and client limits instead of rereading conflicting env', async () => {
    process.env.COMFYUI_NETWORK_MODE = 'allowlist'
    process.env.COMFYUI_ALLOWED_HOSTS = 'wrong.example'
    prismaMock.comfyConnection.findMany.mockResolvedValue([connection()])
    const service = await import('@/lib/comfyui/connection-service')
    const policy = { mode: 'trusted' as const, allowedHosts: ['explicit.example'], allowedCidrs: [] }

    await service.probeOwnedConnectionStatuses('user-1', {
      networkPolicy: policy,
      clientLimits: {
        timeoutMs: 1_234,
        maxWorkflowBytes: 2_345,
        maxInputBytes: 3_456,
        maxOutputBytes: 4_567,
      },
    })

    expect(authorizeComfyTargetMock).toHaveBeenCalledWith(
      'http://example.com/comfy', policy,
    )
    expect(clientConstructedMock).toHaveBeenCalledWith(expect.objectContaining({
      networkPolicy: policy,
      timeoutMs: 1_234,
      maxWorkflowBytes: 2_345,
      maxInputBytes: 3_456,
      maxOutputBytes: 4_567,
    }))
  })

  it('normalizes the URL, encrypts credential JSON, and returns only hasCredentials', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    prismaMock.comfyConnection.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      connection({ ...data, id: 'connection-new' }))
    prismaMock.comfyConnection.findFirst.mockResolvedValue(connection({ id: 'connection-new' }))
    prismaMock.comfyConnection.updateMany.mockResolvedValue({ count: 1 })
    const route = await import('@/app/api/comfyui/connections/route')
    const response = await route.POST(buildMockRequest({
      path: '/api/comfyui/connections',
      method: 'POST',
      body: {
        name: '  Home GPU  ',
        baseUrl: 'HTTP://Example.COM:80/comfy///',
        authType: 'bearer',
        credentials: { token: 'top-secret' },
      },
    }), collectionContext)

    expect(response.status).toBe(201)
    expect(encryptApiKeyMock).toHaveBeenCalledWith('{"token":"top-secret"}')
    expect(prismaMock.comfyConnection.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      userId: 'user-1',
      name: 'Home GPU',
      normalizedBaseUrl: 'http://example.com/comfy',
      authSecretEncrypted: 'encrypted:{"token":"top-secret"}',
    }) })
    const body = await responseJson(response)
    expect(body.connection).toEqual(expect.objectContaining({ hasCredentials: true }))
    expect(body.health).toEqual(expect.objectContaining({ state: 'online_idle' }))
    expect(clientConstructedMock).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(body)).not.toContain('top-secret')
  })

  it('maps a normalized per-owner duplicate to 409', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    prismaMock.comfyConnection.create.mockRejectedValue({ code: 'P2002' })
    const route = await import('@/app/api/comfyui/connections/route')
    const response = await route.POST(buildMockRequest({
      path: '/api/comfyui/connections', method: 'POST',
      body: { name: 'Duplicate', baseUrl: 'example.com:80/', authType: 'none' },
    }), collectionContext)

    expect(response.status).toBe(409)
  })

  it('returns 404 for another user before update or secret handling', async () => {
    installAuthMocks()
    mockAuthenticated('user-2')
    prismaMock.comfyConnection.findFirst.mockResolvedValue(null)
    const route = await import('@/app/api/comfyui/connections/[connectionId]/route')
    const response = await route.PATCH(buildMockRequest({
      path: '/api/comfyui/connections/connection-1', method: 'PATCH',
      body: { name: 'Stolen', credentials: { token: 'stolen' } },
    }), connectionContext('connection-1'))

    expect(response.status).toBe(404)
    expect(prismaMock.comfyConnection.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'connection-1', userId: 'user-2' },
    }))
    expect(encryptApiKeyMock).not.toHaveBeenCalled()
    expect(prismaMock.comfyConnection.update).not.toHaveBeenCalled()
  })

  it('allows disabling while preserving omitted credentials', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    prismaMock.comfyConnection.findFirst.mockResolvedValue(connection())
    prismaMock.comfyConnection.update.mockResolvedValue(connection({ enabled: false }))
    const route = await import('@/app/api/comfyui/connections/[connectionId]/route')
    const response = await route.PATCH(buildMockRequest({
      path: '/api/comfyui/connections/connection-1', method: 'PATCH', body: { enabled: false },
    }), connectionContext('connection-1'))

    expect(response.status).toBe(200)
    expect(prismaMock.comfyConnection.update).toHaveBeenCalledWith({
      where: { id_userId: { id: 'connection-1', userId: 'user-1' } }, data: { enabled: false },
    })
    expect(encryptApiKeyMock).not.toHaveBeenCalled()
  })

  it('allows an owner to disable an active connection without canceling work or releasing its lease', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    prismaMock.comfyConnection.findFirst.mockResolvedValue(connection())
    prismaMock.comfyConnection.update.mockResolvedValue(connection({ enabled: false }))
    prismaMock.comfyGenerationRequest.count.mockResolvedValue(1)
    const route = await import('@/app/api/comfyui/connections/[connectionId]/route')
    const response = await route.PATCH(buildMockRequest({
      path: '/api/comfyui/connections/connection-1', method: 'PATCH', body: { enabled: false },
    }), connectionContext('connection-1'))

    expect(response.status).toBe(200)
    expect(prismaMock.comfyConnection.update).toHaveBeenCalledWith({
      where: { id_userId: { id: 'connection-1', userId: 'user-1' } }, data: { enabled: false },
    })
    expect(prismaMock.comfyGenerationRequest.updateMany).not.toHaveBeenCalled()
    expect(redisMock.set).not.toHaveBeenCalled()
    expect(redisMock.eval).not.toHaveBeenCalled()
  })

  it('returns 409 for URL/auth identity PATCH while a test lease is active', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    prismaMock.comfyConnection.findFirst.mockResolvedValue(connection())
    redisMock.set.mockResolvedValue(null)
    const route = await import('@/app/api/comfyui/connections/[connectionId]/route')
    const response = await route.PATCH(buildMockRequest({
      path: '/api/comfyui/connections/connection-1', method: 'PATCH',
      body: { baseUrl: 'http://gpu-b.example.com', authType: 'none' },
    }), connectionContext('connection-1'))
    expect(response.status).toBe(409)
    expect(redisMock.set).toHaveBeenCalledWith(
      'comfy:lease:connection-1', expect.stringContaining('connection-update'),
      'PX', expect.any(Number), 'NX',
    )
    expect(prismaMock.comfyConnection.update).not.toHaveBeenCalled()
  })

  it('updates URL/auth identity under an acquired lease and releases it', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    prismaMock.comfyConnection.findFirst.mockResolvedValue(connection({ authType: 'none', authSecretEncrypted: null }))
    prismaMock.comfyConnection.update.mockResolvedValue(connection({
      baseUrl: 'http://gpu-b.example.com', normalizedBaseUrl: 'http://gpu-b.example.com',
      authType: 'none', authSecretEncrypted: null,
    }))
    const route = await import('@/app/api/comfyui/connections/[connectionId]/route')
    const response = await route.PATCH(buildMockRequest({
      path: '/api/comfyui/connections/connection-1', method: 'PATCH',
      body: { baseUrl: 'http://gpu-b.example.com', authType: 'none' },
    }), connectionContext('connection-1'))
    expect(response.status).toBe(200)
    expect(redisMock.set).toHaveBeenCalled()
    expect(prismaMock.comfyConnection.update).toHaveBeenCalled()
    expect(redisMock.eval).toHaveBeenCalled()
  })

  it('keeps URL/auth identity mutations blocked while durable active work exists', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    prismaMock.comfyConnection.findFirst.mockResolvedValue(connection())
    prismaMock.comfyGenerationRequest.count.mockResolvedValue(1)
    const route = await import('@/app/api/comfyui/connections/[connectionId]/route')
    const response = await route.PATCH(buildMockRequest({
      path: '/api/comfyui/connections/connection-1', method: 'PATCH',
      body: { baseUrl: 'http://gpu-b.example.com' },
    }), connectionContext('connection-1'))

    expect(response.status).toBe(409)
    expect(redisMock.set).toHaveBeenCalled()
    expect(prismaMock.comfyConnection.update).not.toHaveBeenCalled()
  })

  it('rejects deletion while owned nonterminal work exists but permits it after completion', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    prismaMock.comfyConnection.findFirst.mockResolvedValue(connection())
    prismaMock.comfyGenerationRequest.count.mockResolvedValueOnce(1).mockResolvedValueOnce(0)
    prismaMock.comfyConnection.delete.mockResolvedValue(connection())
    const route = await import('@/app/api/comfyui/connections/[connectionId]/route')
    const request = () => buildMockRequest({
      path: '/api/comfyui/connections/connection-1', method: 'DELETE',
    })

    const blocked = await route.DELETE(request(), connectionContext('connection-1'))
    expect(blocked.status).toBe(409)
    expect(prismaMock.comfyConnection.delete).not.toHaveBeenCalled()

    const deleted = await route.DELETE(request(), connectionContext('connection-1'))
    expect(deleted.status).toBe(200)
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2)
    expect(prismaMock.comfyGenerationRequest.count).toHaveBeenLastCalledWith({ where: {
      connectionId: 'connection-1',
      userId: 'user-1',
      status: { notIn: ['completed', 'failed', 'canceled'] },
    } })
    expect(prismaMock.comfyGenerationRequest.updateMany).toHaveBeenCalledWith({
      where: {
        connectionId: 'connection-1',
        userId: 'user-1',
        status: { in: ['completed', 'failed', 'canceled'] },
      },
      data: { connectionId: null, leaseId: null, leaseExpiresAt: null },
    })
  })

  it('returns 409 when a live-test lease owns the connection and never deletes it', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    prismaMock.comfyConnection.findFirst.mockResolvedValue(connection())
    redisMock.set.mockResolvedValue(null)
    const route = await import('@/app/api/comfyui/connections/[connectionId]/route')
    const response = await route.DELETE(buildMockRequest({
      path: '/api/comfyui/connections/connection-1', method: 'DELETE',
    }), connectionContext('connection-1'))
    expect(response.status).toBe(409)
    expect(redisMock.set).toHaveBeenCalledWith(
      'comfy:lease:connection-1', expect.stringContaining('delete'), 'PX', expect.any(Number), 'NX',
    )
    expect(prismaMock.comfyConnection.delete).not.toHaveBeenCalled()
  })

  it('authorizes ownership and the network target before constructing a probe client', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    prismaMock.comfyConnection.findFirst.mockResolvedValue(connection())
    const route = await import('@/app/api/comfyui/connections/[connectionId]/probe/route')
    const response = await route.POST(buildMockRequest({
      path: '/api/comfyui/connections/connection-1/probe', method: 'POST',
    }), connectionContext('connection-1'))

    expect(response.status).toBe(200)
    expect(prismaMock.comfyConnection.findFirst.mock.invocationCallOrder[0])
      .toBeLessThan(authorizeComfyTargetMock.mock.invocationCallOrder[0])
    expect(authorizeComfyTargetMock.mock.invocationCallOrder[0])
      .toBeLessThan(clientConstructedMock.mock.invocationCallOrder[0])
  })

  it('does not authorize or construct a probe client for another user', async () => {
    installAuthMocks()
    mockAuthenticated('user-2')
    prismaMock.comfyConnection.findFirst.mockResolvedValue(null)
    const route = await import('@/app/api/comfyui/connections/[connectionId]/probe/route')
    const response = await route.POST(buildMockRequest({
      path: '/api/comfyui/connections/connection-1/probe', method: 'POST',
    }), connectionContext('connection-1'))

    expect(response.status).toBe(404)
    expect(authorizeComfyTargetMock).not.toHaveBeenCalled()
    expect(clientConstructedMock).not.toHaveBeenCalled()
  })

  it('persists only sanitized probe diagnostics, never the thrown message', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    prismaMock.comfyConnection.findFirst.mockResolvedValue(connection())
    prismaMock.comfyConnection.updateMany.mockResolvedValue({ count: 1 })
    getSystemStatsMock.mockRejectedValue(new Error('Authorization: Bearer top-secret'))
    const route = await import('@/app/api/comfyui/connections/[connectionId]/probe/route')
    const response = await route.POST(buildMockRequest({
      path: '/api/comfyui/connections/connection-1/probe', method: 'POST',
    }), connectionContext('connection-1'))

    expect(response.status).toBe(200)
    expect(prismaMock.comfyConnection.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'connection-1',
        userId: 'user-1',
        normalizedBaseUrl: 'http://example.com/comfy',
        authType: 'bearer',
        authSecretEncrypted: 'encrypted:{"token":"top-secret"}',
        enabled: true,
      },
      data: expect.objectContaining({
        lastHealthCode: 'offline',
        lastHealthMessage: 'Connection unavailable',
      }),
    })
    const healthWrite = prismaMock.comfyConnection.updateMany.mock.calls[0]?.[0] as {
      data: Record<string, unknown>
    }
    expect(JSON.stringify(healthWrite.data)).not.toContain('top-secret')
  })

  it('discards a stale probe after PATCH and re-probes the stable connection version', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    const changed = connection({
      normalizedBaseUrl: 'http://changed.example.com',
      updatedAt: new Date('2026-07-11T08:01:00.000Z'),
    })
    prismaMock.comfyConnection.findFirst
      .mockResolvedValueOnce(connection())
      .mockResolvedValueOnce(changed)
    prismaMock.comfyConnection.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 })
    getSystemStatsMock
      .mockResolvedValueOnce({ system: { comfyui_version: 'stale' }, devices: [] })
      .mockResolvedValueOnce({ system: { comfyui_version: 'stable' }, devices: [] })
    const route = await import('@/app/api/comfyui/connections/[connectionId]/probe/route')
    const response = await route.POST(buildMockRequest({
      path: '/api/comfyui/connections/connection-1/probe', method: 'POST',
    }), connectionContext('connection-1'))

    expect(response.status).toBe(200)
    expect(await responseJson(response)).toEqual({ health: expect.objectContaining({ version: 'stable' }) })
    expect(clientConstructedMock).toHaveBeenCalledTimes(2)
    expect(prismaMock.comfyConnection.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ normalizedBaseUrl: 'http://changed.example.com' }),
    }))
  })

  it('discards a stale probe after concurrent DELETE and returns 404 rather than 500', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    prismaMock.comfyConnection.findFirst
      .mockResolvedValueOnce(connection())
      .mockResolvedValueOnce(null)
    prismaMock.comfyConnection.updateMany.mockResolvedValueOnce({ count: 0 })
    const route = await import('@/app/api/comfyui/connections/[connectionId]/probe/route')
    const response = await route.POST(buildMockRequest({
      path: '/api/comfyui/connections/connection-1/probe', method: 'POST',
    }), connectionContext('connection-1'))

    expect(response.status).toBe(404)
  })

  it('does not re-probe when concurrent health writes use the same connection config', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    const initial = connection()
    prismaMock.comfyConnection.findFirst.mockResolvedValue(initial)
    let healthWriteAdvancedUpdatedAt = false
    prismaMock.comfyConnection.updateMany.mockImplementation(
      async ({ where }: { where: Record<string, unknown> }) => {
        if (!('updatedAt' in where)) return { count: 1 }
        if (healthWriteAdvancedUpdatedAt) return { count: 0 }
        healthWriteAdvancedUpdatedAt = true
        return { count: 1 }
      },
    )
    const route = await import('@/app/api/comfyui/connections/[connectionId]/probe/route')
    const request = () => route.POST(buildMockRequest({
      path: '/api/comfyui/connections/connection-1/probe', method: 'POST',
    }), connectionContext('connection-1'))

    const responses = await Promise.all([request(), request()])
    expect(responses.map((response) => response.status)).toEqual([200, 200])
    expect(clientConstructedMock).toHaveBeenCalledTimes(2)
    expect(prismaMock.comfyConnection.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: 'connection-1',
        userId: 'user-1',
        normalizedBaseUrl: 'http://example.com/comfy',
        authType: 'bearer',
        authSecretEncrypted: 'encrypted:{"token":"top-secret"}',
        enabled: true,
      },
    }))
  })

  it('returns exact idle, external-busy, owned-busy, offline, and auth status states', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    const connections = [
      connection({ id: 'idle' }),
      connection({ id: 'external' }),
      connection({ id: 'owned' }),
      connection({ id: 'offline' }),
      connection({ id: 'auth' }),
    ]
    prismaMock.comfyConnection.findMany.mockResolvedValue(connections)
    prismaMock.comfyGenerationRequest.count
      .mockResolvedValueOnce(0).mockResolvedValueOnce(0).mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0).mockResolvedValueOnce(0)
    getSystemStatsMock
      .mockResolvedValueOnce({}).mockResolvedValueOnce({}).mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('down'))
      .mockRejectedValueOnce(Object.assign(new Error('unauthorized'), { code: 'COMFY_AUTH_FAILED' }))
    getQueueMock
      .mockResolvedValueOnce({ running: [], pending: [] })
      .mockResolvedValueOnce({ running: [], pending: [['manual']] })
      .mockResolvedValueOnce({ running: [['owned']], pending: [] })
    const route = await import('@/app/api/comfyui/connections/status/route')
    const response = await route.GET(buildMockRequest({
      path: '/api/comfyui/connections/status', method: 'GET',
    }), collectionContext)

    expect(response.status).toBe(200)
    const body = await responseJson(response) as { statuses: Array<{ connectionId: string; state: string }> }
    expect(body.statuses.map(({ connectionId, state }) => [connectionId, state])).toEqual([
      ['idle', 'online_idle'],
      ['external', 'online_busy_external'],
      ['owned', 'online_busy_owned'],
      ['offline', 'offline'],
      ['auth', 'auth_failed'],
    ])
  })

  it('returns only the owner-scoped active task summary for an owned-busy connection', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    prismaMock.comfyConnection.findMany.mockResolvedValue([connection({ id: 'owned' })])
    prismaMock.comfyGenerationRequest.count.mockResolvedValue(1)
    prismaMock.comfyGenerationRequest.findFirst.mockResolvedValue({
      id: 'request-1', taskId: 'task-42', status: 'running',
      promptId: 'must-not-leak', leaseId: 'must-not-leak',
    })
    getSystemStatsMock.mockResolvedValue({ system: { comfyui_version: '0.3.50' } })
    getQueueMock.mockResolvedValue({ running: [['owned']], pending: [] })
    const route = await import('@/app/api/comfyui/connections/status/route')
    const response = await route.GET(buildMockRequest({
      path: '/api/comfyui/connections/status', method: 'GET',
    }), collectionContext)

    expect(response.status).toBe(200)
    const body = await responseJson(response)
    expect(body.statuses).toEqual([expect.objectContaining({
      connectionId: 'owned', state: 'online_busy_owned', version: '0.3.50',
      ownedTask: { requestId: 'request-1', taskId: 'task-42', status: 'running' },
    })])
    expect(prismaMock.comfyGenerationRequest.findFirst).toHaveBeenCalledWith({
      where: {
        connectionId: 'owned', userId: 'user-1',
        status: { notIn: ['completed', 'failed', 'canceled'] },
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, taskId: true, status: true },
    })
    expect(JSON.stringify(body)).not.toContain('must-not-leak')
  })

  it('bounds status fan-out to the configured safe probe concurrency', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    process.env.COMFYUI_STATUS_PROBE_CONCURRENCY = '3'
    prismaMock.comfyConnection.findMany.mockResolvedValue(
      Array.from({ length: 12 }, (_, index) => connection({ id: `connection-${index}` })),
    )
    let active = 0
    let peak = 0
    getSystemStatsMock.mockImplementation(async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 2))
      active -= 1
      return {}
    })
    const route = await import('@/app/api/comfyui/connections/status/route')
    const response = await route.GET(buildMockRequest({
      path: '/api/comfyui/connections/status', method: 'GET',
    }), collectionContext)

    expect(response.status).toBe(200)
    expect(peak).toBe(3)
  })

  it('drops a status probe disabled mid-flight without constructing a second client', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    prismaMock.comfyConnection.findMany.mockResolvedValue([connection()])
    prismaMock.comfyConnection.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 })
    prismaMock.comfyConnection.findFirst.mockResolvedValue(connection({
      enabled: false,
      updatedAt: new Date('2026-07-11T08:01:00.000Z'),
    }))
    const route = await import('@/app/api/comfyui/connections/status/route')
    const response = await route.GET(buildMockRequest({
      path: '/api/comfyui/connections/status', method: 'GET',
    }), collectionContext)

    expect(response.status).toBe(200)
    expect(await responseJson(response)).toEqual({ statuses: [] })
    expect(clientConstructedMock).toHaveBeenCalledTimes(1)
  })

  it('retries P2034 serialization conflicts finitely before deleting', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    prismaMock.$transaction
      .mockRejectedValueOnce({ code: 'P2034' })
      .mockRejectedValueOnce({ code: 'P2034' })
    prismaMock.comfyConnection.findFirst.mockResolvedValue(connection())
    prismaMock.comfyConnection.delete.mockResolvedValue(connection())
    const route = await import('@/app/api/comfyui/connections/[connectionId]/route')
    const response = await route.DELETE(buildMockRequest({
      path: '/api/comfyui/connections/connection-1', method: 'DELETE',
    }), connectionContext('connection-1'))

    expect(response.status).toBe(200)
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(3)
  })

  it('maps scheduler FK races during delete to a stable 409', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    prismaMock.comfyConnection.findFirst.mockResolvedValue(connection())
    prismaMock.comfyConnection.delete.mockRejectedValue({ code: 'P2003' })
    const route = await import('@/app/api/comfyui/connections/[connectionId]/route')
    const response = await route.DELETE(buildMockRequest({
      path: '/api/comfyui/connections/connection-1', method: 'DELETE',
    }), connectionContext('connection-1'))

    expect(response.status).toBe(409)
  })
})
