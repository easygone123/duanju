import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const capabilityMock = vi.hoisted(() => vi.fn())
const submitTaskMock = vi.hoisted(() => vi.fn(async () => ({ id: 'task-1' })))

vi.mock('@/lib/model-capabilities/lookup', () => ({
  resolveBuiltinCapabilitiesByModelKey: capabilityMock,
}))
vi.mock('@/lib/api-auth', () => ({
  requireProjectAuthLight: vi.fn(async () => ({ session: { user: { id: 'user-1' } } })),
  isErrorResponse: vi.fn(() => false),
}))
vi.mock('@/lib/task/submitter', () => ({ submitTask: submitTaskMock }))
vi.mock('@/lib/task/has-output', () => ({ hasPanelVideoOutput: vi.fn(async () => false) }))
vi.mock('@/lib/task/resolve-locale', () => ({ resolveRequiredTaskLocale: vi.fn(() => 'zh') }))
vi.mock('@/lib/config-service', () => ({
  applyTrustedComfyVersionSnapshot: vi.fn((payload: Record<string, unknown>, versionId?: string | null) => {
    delete payload.comfyWorkflowVersionId
    if (versionId) payload.comfyWorkflowVersionId = versionId
    return payload
  }),
  getProjectModelConfig: vi.fn(async (_projectId: string, _userId: string, overrides: { videoModel?: string }) => ({
    videoModel: overrides.videoModel ?? null,
    comfyVideoWorkflowVersionId: overrides.videoModel?.startsWith('comfyui::') ? 'video-version-1' : null,
  })),
  resolveProjectModelCapabilityGenerationOptions: vi.fn(async () => ({})),
}))
vi.mock('@/lib/model-pricing/lookup', () => ({
  resolveBuiltinPricing: vi.fn(() => ({ status: 'resolved' })),
}))
vi.mock('@/lib/prisma', () => ({
  prisma: {
    novelPromotionPanel: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => ({ id: 'panel-1' })),
    },
  },
}))

import { POST } from '@/app/api/novel-promotion/[projectId]/generate-video/route'

function request(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/novel-promotion/project-1/generate-video', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-locale': 'zh' },
    body: JSON.stringify({ storyboardId: 'storyboard-1', panelIndex: 0, ...body }),
  })
}

describe('generate-video ComfyUI first-last-frame routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capabilityMock.mockReturnValue(undefined)
  })

  it('accepts strict ComfyUI first-last-frame selection without consulting cloud capabilities', async () => {
    const response = await POST(request({
      videoModel: 'cloud::normal',
      firstLastFrame: { flModel: 'comfyui::wf-video' },
    }), { params: Promise.resolve({ projectId: 'project-1' }) })
    expect(response.status).toBe(200)
    expect(capabilityMock).not.toHaveBeenCalledWith('video', 'comfyui::wf-video')
    expect(submitTaskMock).toHaveBeenCalledTimes(1)
    expect(submitTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        videoModel: 'comfyui::wf-video',
        comfyWorkflowVersionId: 'video-version-1',
      }),
    }))
  })

  it('continues rejecting unsupported cloud first-last-frame models', async () => {
    const response = await POST(request({
      videoModel: 'cloud::normal',
      firstLastFrame: { flModel: 'cloud::unsupported' },
    }), { params: Promise.resolve({ projectId: 'project-1' }) })
    expect(response.status).toBe(400)
    expect(submitTaskMock).not.toHaveBeenCalled()
  })

  it('does not let malformed comfy-like keys bypass strict parsing', async () => {
    const response = await POST(request({
      videoModel: 'cloud::normal',
      firstLastFrame: { flModel: 'comfyui:wf-video' },
    }), { params: Promise.resolve({ projectId: 'project-1' }) })
    expect(response.status).toBe(400)
    expect(capabilityMock).not.toHaveBeenCalledWith('video', 'comfyui:wf-video')
  })
})
