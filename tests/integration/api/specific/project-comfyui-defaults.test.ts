import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildMockRequest } from '../../../helpers/request'

const authMock = vi.hoisted(() => ({
  requireProjectAuthLight: vi.fn(async () => ({
    session: { user: { id: 'user-1', name: 'User 1' } },
    project: { id: 'project-1', userId: 'user-1', name: 'Project 1' },
  })),
  isErrorResponse: vi.fn((value: unknown) => value instanceof Response),
}))

const prismaMock = vi.hoisted(() => ({
  novelPromotionProject: {
    findUnique: vi.fn(async (): Promise<Record<string, string | null> | null> => ({
      analysisModel: 'cloud::analysis', characterModel: 'cloud::character',
      locationModel: 'cloud::location', storyboardModel: 'cloud::storyboard',
      editModel: 'cloud::edit', videoModel: 'cloud::video', audioModel: 'cloud::audio',
      capabilityOverrides: null,
    })),
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'np-1', ...data })),
  },
  userPreference: {
    findUnique: vi.fn(async () => ({
      analysisModel: 'user::analysis', characterModel: 'user::character',
      locationModel: 'user::location', storyboardModel: 'user::storyboard',
      editModel: 'user::edit', videoModel: 'user::video', audioModel: 'user::audio',
      capabilityDefaults: null,
    })),
  },
  projectComfyBinding: {
    findUnique: vi.fn(async (): Promise<{
      imageWorkflowId: string | null
      videoWorkflowId: string | null
    } | null> => ({
      imageWorkflowId: 'image-workflow', videoWorkflowId: 'video-workflow',
    })),
  },
}))

const bindingMock = vi.hoisted(() => ({ bindProjectDefaultWorkflow: vi.fn(async () => ({})) }))
const mediaAttachMock = vi.hoisted(() => ({ attachMediaFieldsToProject: vi.fn(async (value: unknown) => value) }))

vi.mock('@/lib/api-auth', () => authMock)
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('@/lib/comfyui/workflow-service', () => bindingMock)
vi.mock('@/lib/media/attach', () => mediaAttachMock)
vi.mock('@/lib/logging/semantic', () => ({ logProjectAction: vi.fn() }))
vi.mock('@/lib/model-capabilities/lookup', () => ({
  resolveBuiltinModelContext: vi.fn(() => null),
  getCapabilityOptionFields: vi.fn(() => ({})),
  validateCapabilitySelectionsPayload: vi.fn(() => []),
  resolveGenerationOptionsForModel: vi.fn(() => ({ issues: [], options: {} })),
}))
vi.mock('@/lib/model-capabilities/catalog', () => ({ findBuiltinCapabilities: vi.fn() }))

describe('api specific - project ComfyUI defaults', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns project image and video workflow bindings', async () => {
    const route = await import('@/app/api/novel-promotion/[projectId]/route')
    const response = await route.GET(buildMockRequest({
      path: '/api/novel-promotion/project-1', method: 'GET',
    }), { params: Promise.resolve({ projectId: 'project-1' }) })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      comfyImageWorkflowId: 'image-workflow',
      comfyVideoWorkflowId: 'video-workflow',
    })
    expect(prismaMock.projectComfyBinding.findUnique).toHaveBeenCalledWith({
      where: { projectId_userId: { projectId: 'project-1', userId: 'user-1' } },
      select: { imageWorkflowId: true, videoWorkflowId: true },
    })
  })

  it('binds defaults through the atomic owned/published/tested workflow API', async () => {
    const route = await import('@/app/api/novel-promotion/[projectId]/route')
    const response = await route.PATCH(buildMockRequest({
      path: '/api/novel-promotion/project-1', method: 'PATCH',
      body: { comfyImageWorkflowId: 'image-workflow', comfyVideoWorkflowId: 'video-workflow' },
    }), { params: Promise.resolve({ projectId: 'project-1' }) })

    expect(response.status).toBe(200)
    expect(bindingMock.bindProjectDefaultWorkflow).toHaveBeenNthCalledWith(
      1, 'user-1', 'project-1', 'image', 'image-workflow',
    )
    expect(bindingMock.bindProjectDefaultWorkflow).toHaveBeenNthCalledWith(
      2, 'user-1', 'project-1', 'video', 'video-workflow',
    )
    expect(prismaMock.novelPromotionProject.update).toHaveBeenCalledWith({
      where: { projectId: 'project-1' }, data: {},
    })
  })

  it('clears a Comfy binding without overwriting the specialized provider model', async () => {
    const route = await import('@/app/api/novel-promotion/[projectId]/route')
    const response = await route.PATCH(buildMockRequest({
      path: '/api/novel-promotion/project-1', method: 'PATCH',
      body: { comfyImageWorkflowId: null },
    }), { params: Promise.resolve({ projectId: 'project-1' }) })

    expect(response.status).toBe(200)
    expect(bindingMock.bindProjectDefaultWorkflow).toHaveBeenCalledWith(
      'user-1', 'project-1', 'image', null,
    )
    expect(prismaMock.novelPromotionProject.update).toHaveBeenCalledWith({
      where: { projectId: 'project-1' }, data: {},
    })
  })

  it('resolves strict precedence task override then Comfy binding then project model then user default', async () => {
    const { getProjectModelConfig } = await import('@/lib/config-service')

    const taskConfig = await getProjectModelConfig('project-1', 'user-1', {
      imageModel: 'task::image', videoModel: 'task::video',
    })
    expect(taskConfig.storyboardModel).toBe('task::image')
    expect(taskConfig.videoModel).toBe('task::video')

    const bindingConfig = await getProjectModelConfig('project-1', 'user-1')
    expect(bindingConfig.characterModel).toBe('comfyui::image-workflow')
    expect(bindingConfig.locationModel).toBe('comfyui::image-workflow')
    expect(bindingConfig.storyboardModel).toBe('comfyui::image-workflow')
    expect(bindingConfig.editModel).toBe('comfyui::image-workflow')
    expect(bindingConfig.videoModel).toBe('comfyui::video-workflow')

    prismaMock.projectComfyBinding.findUnique.mockResolvedValueOnce({
      imageWorkflowId: null, videoWorkflowId: null,
    })
    const projectConfig = await getProjectModelConfig('project-1', 'user-1')
    expect(projectConfig.storyboardModel).toBe('cloud::storyboard')
    expect(projectConfig.videoModel).toBe('cloud::video')

    prismaMock.projectComfyBinding.findUnique.mockResolvedValueOnce(null)
    prismaMock.novelPromotionProject.findUnique.mockResolvedValueOnce({
      analysisModel: null, characterModel: null, locationModel: null,
      storyboardModel: null, editModel: null, videoModel: null, audioModel: null,
      capabilityOverrides: null,
    })
    const userConfig = await getProjectModelConfig('project-1', 'user-1')
    expect(userConfig.storyboardModel).toBe('user::storyboard')
    expect(userConfig.videoModel).toBe('user::video')
  })

  it('rejects malformed task override model keys instead of guessing a provider', async () => {
    const { getProjectModelConfig } = await import('@/lib/config-service')
    await expect(getProjectModelConfig('project-1', 'user-1', { imageModel: 'legacy-model-id' }))
      .rejects.toThrow('MODEL_KEY_INVALID')
  })
})
