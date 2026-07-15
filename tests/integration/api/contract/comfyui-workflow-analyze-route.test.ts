import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  installAuthMocks,
  mockAuthenticated,
  mockUnauthenticated,
  resetAuthMockState,
} from '../../../helpers/auth'
import { buildMockRequest } from '../../../helpers/request'

async function responseJson(response: Response) {
  return await response.json() as Record<string, unknown>
}

describe('ComfyUI workflow analysis route', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    resetAuthMockState()
  })

  it('authenticates before attempting to parse the upload', async () => {
    installAuthMocks()
    mockUnauthenticated()
    const route = await import('@/app/api/comfyui/workflows/analyze/route')
    const request = new NextRequest('http://localhost:3000/api/comfyui/workflows/analyze', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not-json',
    })

    const response = await route.POST(request, { params: Promise.resolve({}) })

    expect(response.status).toBe(401)
  })

  it('rejects a graph larger than four megabytes', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    const route = await import('@/app/api/comfyui/workflows/analyze/route')
    const response = await route.POST(buildMockRequest({
      path: '/api/comfyui/workflows/analyze', method: 'POST', body: {
        kind: 'image_generation',
        apiFormatJson: 'x'.repeat(4 * 1024 * 1024 + 1),
      },
    }), { params: Promise.resolve({}) })

    expect(response.status).toBe(400)
    expect(await responseJson(response)).toMatchObject({ error: { code: 'INVALID_PARAMS' } })
  })

  it('returns the stable API Format diagnostic for normal Workflow JSON', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    const route = await import('@/app/api/comfyui/workflows/analyze/route')
    const response = await route.POST(buildMockRequest({
      path: '/api/comfyui/workflows/analyze', method: 'POST', body: {
        kind: 'image_generation', apiFormatJson: { nodes: [], links: [] },
      },
    }), { params: Promise.resolve({}) })

    expect(response.status).toBe(400)
    expect(await responseJson(response)).toMatchObject({
      error: {
        code: 'INVALID_PARAMS',
        details: { reason: 'COMFY_WORKFLOW_API_FORMAT_REQUIRED' },
      },
    })
  })

  it('analyzes an authenticated bounded API Format upload', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    const route = await import('@/app/api/comfyui/workflows/analyze/route')
    const response = await route.POST(buildMockRequest({
      path: '/api/comfyui/workflows/analyze', method: 'POST', body: {
        kind: 'image_generation', apiFormatJson: {
          '1': {
            class_type: 'CLIPTextEncode', inputs: { text: 'portrait' },
            _meta: { title: 'Positive Prompt' },
          },
          '2': { class_type: 'SaveImage', inputs: { images: ['1', 0] } },
        },
      },
    }), { params: Promise.resolve({}) })

    expect(response.status).toBe(200)
    expect(await responseJson(response)).toEqual(expect.objectContaining({
      analysis: expect.objectContaining({
        mediaType: 'image', purpose: 'generation',
        proposals: expect.arrayContaining([
          expect.objectContaining({ canonicalName: 'prompt', confidence: 'high' }),
        ]),
      }),
    }))
  })

  it('does not echo credentials, graph data, or raw analyzer errors', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    const route = await import('@/app/api/comfyui/workflows/analyze/route')
    const response = await route.POST(buildMockRequest({
      path: '/api/comfyui/workflows/analyze', method: 'POST', body: {
        kind: 'image_generation', apiFormatJson: {
          'secret-node': {
            class_type: '', inputs: { token: 'super-secret-workflow-token' },
          },
        },
      },
    }), { params: Promise.resolve({}) })
    const body = await response.text()

    expect(response.status).toBe(400)
    expect(body).toContain('COMFY_WORKFLOW_API_FORMAT_INVALID')
    expect(body).not.toContain('super-secret-workflow-token')
    expect(body).not.toContain('secret-node')
    expect(body.length).toBeLessThan(4_096)
  })
})
