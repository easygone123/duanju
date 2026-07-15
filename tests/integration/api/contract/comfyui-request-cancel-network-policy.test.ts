import { beforeEach, describe, expect, it, vi } from 'vitest'

import { buildMockRequest } from '../../../helpers/request'
import {
  installAuthMocks,
  mockAuthenticated,
  resetAuthMockState,
} from '../../../helpers/auth'

const prismaMock = vi.hoisted(() => ({
  comfyGenerationRequest: { findFirst: vi.fn() },
}))
const clientConstructedMock = vi.hoisted(() => vi.fn())
const cancelComfyRequestMock = vi.hoisted(() => vi.fn(async (
  requestId: string,
  userId: string,
  dependencies: { loadOwnedRequest(id: string, ownerId: string): Promise<unknown> },
) => {
  await dependencies.loadOwnedRequest(requestId, userId)
  return { requestId, status: 'canceled', outcome: 'canceled' }
}))

vi.mock('@/lib/comfyui/dispatcher', () => ({ cancelComfyRequest: cancelComfyRequestMock }))
vi.mock('@/lib/comfyui/client', () => ({
  ComfyClient: class {
    constructor(options: unknown) {
      clientConstructedMock(options)
    }
  },
}))
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('@/lib/redis', () => ({ redis: {} }))
vi.mock('@/lib/crypto-utils', () => ({ decryptApiKey: vi.fn() }))

describe('ComfyUI request cancellation network policy contract', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    resetAuthMockState()
    delete process.env.COMFYUI_NETWORK_MODE
    delete process.env.COMFYUI_ALLOWED_HOSTS
    delete process.env.COMFYUI_ALLOWED_CIDRS
    prismaMock.comfyGenerationRequest.findFirst.mockResolvedValue({
      id: 'request-1',
      taskId: 'task-1',
      userId: 'user-1',
      projectId: 'project-1',
      workflowId: 'workflow-1',
      workflowVersionId: 'version-1',
      status: 'running',
      connectionId: 'connection-1',
      leaseId: 'lease-1',
      promptId: 'prompt-1',
      clientId: 'client-1',
      connection: {
        normalizedBaseUrl: 'http://127.0.0.1:8188',
        authType: 'none',
        authSecretEncrypted: null,
      },
    })
  })

  it('constructs the cancellation client with trusted mode when network variables are absent', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    const route = await import('@/app/api/comfyui/requests/[requestId]/cancel/route')

    const response = await route.POST(buildMockRequest({
      path: '/api/comfyui/requests/request-1/cancel', method: 'POST',
    }), { params: Promise.resolve({ requestId: 'request-1' }) })

    expect(response.status).toBe(200)
    expect(clientConstructedMock).toHaveBeenCalledWith(expect.objectContaining({
      networkPolicy: { mode: 'trusted', allowedHosts: [], allowedCidrs: [] },
    }))
  })
})
