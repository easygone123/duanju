import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildMockRequest } from '../../../helpers/request'
import {
  installAuthMocks,
  mockAuthenticated,
  mockUnauthenticated,
  resetAuthMockState,
} from '../../../helpers/auth'

const cancelComfyRequestMock = vi.hoisted(() => vi.fn(async () => ({
  requestId: 'request-1', status: 'canceled', outcome: 'canceled',
})))

vi.mock('@/lib/comfyui/dispatcher', () => ({ cancelComfyRequest: cancelComfyRequestMock }))
vi.mock('@/lib/prisma', () => ({ prisma: {} }))
vi.mock('@/lib/redis', () => ({ redis: {} }))
vi.mock('@/lib/crypto-utils', () => ({ decryptApiKey: vi.fn() }))

describe('ComfyUI request cancel route', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    resetAuthMockState()
  })

  it('returns 401 before attempting cancellation', async () => {
    installAuthMocks()
    mockUnauthenticated()
    const route = await import('@/app/api/comfyui/requests/[requestId]/cancel/route')
    const response = await route.POST(buildMockRequest({
      path: '/api/comfyui/requests/request-1/cancel', method: 'POST',
    }), { params: Promise.resolve({ requestId: 'request-1' }) })

    expect(response.status).toBe(401)
    expect(cancelComfyRequestMock).not.toHaveBeenCalled()
  })

  it('passes both request id and authenticated owner to cancellation', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    const route = await import('@/app/api/comfyui/requests/[requestId]/cancel/route')
    const response = await route.POST(buildMockRequest({
      path: '/api/comfyui/requests/request-1/cancel', method: 'POST',
    }), { params: Promise.resolve({ requestId: 'request-1' }) })

    expect(response.status).toBe(200)
    expect(cancelComfyRequestMock).toHaveBeenCalledWith(
      'request-1', 'user-1', expect.any(Object),
    )
  })
})
