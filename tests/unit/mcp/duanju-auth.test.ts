import { beforeEach, describe, expect, it, vi } from 'vitest'

const { findFirst } = vi.hoisted(() => ({
  findFirst: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: { findFirst },
  },
}))

import { authorizeDuanjuMcpRequest } from '@/lib/mcp/duanju-auth'

const token = 'a'.repeat(64)

function request(options?: { token?: string; origin?: string }) {
  const headers = new Headers()
  if (options?.token) headers.set('authorization', `Bearer ${options.token}`)
  if (options?.origin) headers.set('origin', options.origin)
  return new Request('http://duanju.example/api/mcp', { method: 'POST', headers })
}

describe('authorizeDuanjuMcpRequest', () => {
  beforeEach(() => {
    findFirst.mockReset()
  })

  it('fails closed when MCP is disabled', async () => {
    await expect(authorizeDuanjuMcpRequest(request(), {
      DUANJU_MCP_ENABLED: 'false',
    })).rejects.toMatchObject({ status: 404 })
  })

  it('rejects an invalid bearer token', async () => {
    await expect(authorizeDuanjuMcpRequest(request({ token: 'wrong' }), {
      DUANJU_MCP_ENABLED: 'true',
      DUANJU_MCP_TOKEN: token,
      DUANJU_MCP_USER: 'easygone',
    })).rejects.toMatchObject({ status: 401 })
  })

  it('rejects browser origins unless explicitly allowed', async () => {
    await expect(authorizeDuanjuMcpRequest(request({
      token,
      origin: 'https://untrusted.example',
    }), {
      DUANJU_MCP_ENABLED: 'true',
      DUANJU_MCP_TOKEN: token,
      DUANJU_MCP_USER: 'easygone',
    })).rejects.toMatchObject({ status: 403 })
  })

  it('resolves the configured remote user', async () => {
    findFirst.mockResolvedValue({ id: 'user-1', name: 'easygone' })
    await expect(authorizeDuanjuMcpRequest(request({ token }), {
      DUANJU_MCP_ENABLED: 'true',
      DUANJU_MCP_TOKEN: token,
      DUANJU_MCP_USER: 'easygone',
    })).resolves.toEqual({
      userId: 'user-1',
      userName: 'easygone',
    })
    expect(findFirst).toHaveBeenCalledWith({
      where: { name: 'easygone' },
      select: { id: true, name: true },
    })
  })
})
