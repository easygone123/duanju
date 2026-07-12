import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { buildMockRequest } from '../../../helpers/request'

type RouteContext = { params: Promise<{ projectId: string }> }
type ProjectConfigFixture = {
  analysisModel: string
  storyboardGenerationMode: 'individual' | 'six_grid'
  sixGridCellAspectRatio: '16:9' | '9:16' | null
  sixGridProcessingOrder: 'crop_then_panel_upscale' | 'sheet_upscale_then_crop'
  storyboardUpscaleModel: string | null
  dialogueVideoModel: string | null
  videoRatio: string
}

const maybeSubmitLLMTaskMock = vi.hoisted(() =>
  vi.fn<typeof import('@/lib/llm-observe/route-task').maybeSubmitLLMTask>(async () => NextResponse.json({
  success: true,
  async: true,
  taskId: 'task-1',
  runId: 'run-1',
  status: 'queued',
  deduped: false,
  })),
)

const getProjectModelConfigMock = vi.hoisted(() => vi.fn(async (): Promise<ProjectConfigFixture> => ({
  analysisModel: 'openai::analysis-v1',
  storyboardGenerationMode: 'individual',
  sixGridCellAspectRatio: '9:16',
  sixGridProcessingOrder: 'crop_then_panel_upscale',
  storyboardUpscaleModel: 'comfyui::upscale-v1',
  dialogueVideoModel: 'comfyui::dialogue-v1',
  videoRatio: '9:16',
})))

vi.mock('@/lib/api-auth', () => ({
  isErrorResponse: (value: unknown) => value instanceof Response,
  requireProjectAuth: async () => ({
    session: { user: { id: 'user-1' } },
    project: { id: 'project-1', userId: 'user-1' },
  }),
}))

vi.mock('@/lib/config-service', () => ({
  getProjectModelConfig: getProjectModelConfigMock,
}))

vi.mock('@/lib/llm-observe/route-task', () => ({
  maybeSubmitLLMTask: maybeSubmitLLMTaskMock,
}))

describe('api contract - script-to-storyboard immutable run settings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getProjectModelConfigMock.mockResolvedValue({
      analysisModel: 'openai::analysis-v1',
      storyboardGenerationMode: 'individual',
      sixGridCellAspectRatio: '9:16',
      sixGridProcessingOrder: 'crop_then_panel_upscale',
      storyboardUpscaleModel: 'comfyui::upscale-v1',
      dialogueVideoModel: 'comfyui::dialogue-v1',
      videoRatio: '9:16',
    })
  })

  it('passes the complete resolved settings snapshot to the task submission boundary', async () => {
    const route = await import('@/app/api/novel-promotion/[projectId]/script-to-storyboard-stream/route')
    const request = buildMockRequest({
      path: '/api/novel-promotion/project-1/script-to-storyboard-stream',
      method: 'POST',
      body: {
        episodeId: 'episode-1',
        async: true,
        storyboardGenerationMode: 'six_grid',
        sixGridCellAspectRatio: '16:9',
        sixGridProcessingOrder: 'sheet_upscale_then_crop',
        storyboardUpscaleModel: 'comfyui::task-upscale',
        dialogueVideoModel: 'comfyui::task-dialogue',
      },
    })

    const response = await route.POST(request, {
      params: Promise.resolve({ projectId: 'project-1' }),
    } as RouteContext)

    expect(response.status).toBe(200)
    expect(getProjectModelConfigMock).toHaveBeenCalledWith('project-1', 'user-1')
    const submission = maybeSubmitLLMTaskMock.mock.calls[0]?.[0]
    expect(submission?.body).toMatchObject({
      storyboardGenerationMode: 'six_grid',
      sixGridCellAspectRatio: '16:9',
      sixGridProcessingOrder: 'sheet_upscale_then_crop',
      storyboardUpscaleModel: 'comfyui::task-upscale',
      dialogueVideoModel: 'comfyui::task-dialogue',
    })
    expect(submission?.body).toHaveProperty('displayMode', 'detail')
  })

  it.each([
    ['invalid mode', { storyboardGenerationMode: 'grid' }],
    ['invalid cell ratio', { storyboardGenerationMode: 'six_grid', sixGridCellAspectRatio: '1:1' }],
    ['invalid processing order', { sixGridProcessingOrder: 'upscale_only' }],
    ['non-string upscale model', { storyboardUpscaleModel: 42 }],
    ['non-string dialogue model', { dialogueVideoModel: false }],
    ['malformed upscale model key', { storyboardUpscaleModel: 'bad-key' }],
    ['malformed dialogue model key', { dialogueVideoModel: 'also-bad' }],
  ])('rejects %s before task submission', async (_label, invalidSettings) => {
    const route = await import('@/app/api/novel-promotion/[projectId]/script-to-storyboard-stream/route')
    const request = buildMockRequest({
      path: '/api/novel-promotion/project-1/script-to-storyboard-stream',
      method: 'POST',
      body: { episodeId: 'episode-1', async: true, ...invalidSettings },
    })

    const response = await route.POST(request, {
      params: Promise.resolve({ projectId: 'project-1' }),
    } as RouteContext)

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: {
        code: 'INVALID_PARAMS',
        details: { code: 'STORYBOARD_RUN_SETTINGS_INVALID' },
      },
    })
    expect(maybeSubmitLLMTaskMock).not.toHaveBeenCalled()
  })

  it('returns a stable client error before submission for an unsupported inherited ratio', async () => {
    getProjectModelConfigMock.mockResolvedValue({
      analysisModel: 'openai::analysis-v1',
      storyboardGenerationMode: 'six_grid',
      sixGridCellAspectRatio: null,
      sixGridProcessingOrder: 'crop_then_panel_upscale',
      storyboardUpscaleModel: null,
      dialogueVideoModel: null,
      videoRatio: '1:1',
    })
    const route = await import('@/app/api/novel-promotion/[projectId]/script-to-storyboard-stream/route')
    const request = buildMockRequest({
      path: '/api/novel-promotion/project-1/script-to-storyboard-stream',
      method: 'POST',
      body: { episodeId: 'episode-1', async: true },
    })

    const response = await route.POST(request, {
      params: Promise.resolve({ projectId: 'project-1' }),
    } as RouteContext)

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: {
        code: 'INVALID_PARAMS',
        details: { code: 'SIX_GRID_ASPECT_RATIO_UNSUPPORTED' },
      },
    })
    expect(maybeSubmitLLMTaskMock).not.toHaveBeenCalled()
  })
})
