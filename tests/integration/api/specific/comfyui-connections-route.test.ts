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
    delete: vi.fn(),
  },
  comfyGenerationRequest: {
    count: vi.fn(),
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

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
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
    resetAuthMockState()
    process.env.COMFYUI_NETWORK_MODE = 'allowlist'
    process.env.COMFYUI_ALLOWED_HOSTS = 'example.com'
    process.env.COMFYUI_ALLOWED_CIDRS = ''
    prismaMock.comfyConnection.findMany.mockResolvedValue([])
    prismaMock.comfyGenerationRequest.count.mockResolvedValue(0)
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

  it('normalizes the URL, encrypts credential JSON, and returns only hasCredentials', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    prismaMock.comfyConnection.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      connection({ ...data, id: 'connection-new' }))
    prismaMock.comfyConnection.findFirst.mockResolvedValue(connection({ id: 'connection-new' }))
    prismaMock.comfyConnection.update.mockResolvedValue(connection({ id: 'connection-new' }))
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
    prismaMock.comfyConnection.update.mockResolvedValue(connection())
    getSystemStatsMock.mockRejectedValue(new Error('Authorization: Bearer top-secret'))
    const route = await import('@/app/api/comfyui/connections/[connectionId]/probe/route')
    const response = await route.POST(buildMockRequest({
      path: '/api/comfyui/connections/connection-1/probe', method: 'POST',
    }), connectionContext('connection-1'))

    expect(response.status).toBe(200)
    expect(prismaMock.comfyConnection.update).toHaveBeenCalledWith({
      where: { id_userId: { id: 'connection-1', userId: 'user-1' } },
      data: expect.objectContaining({
        lastHealthCode: 'offline',
        lastHealthMessage: 'Connection unavailable',
      }),
    })
    expect(JSON.stringify(prismaMock.comfyConnection.update.mock.calls)).not.toContain('top-secret')
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
})
