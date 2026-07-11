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
      imageWorkflowVersionId?: string | null
      videoWorkflowId: string | null
      videoWorkflowVersionId?: string | null
    } | null> => ({
      imageWorkflowId: 'image-workflow', imageWorkflowVersionId: 'image-version-1',
      videoWorkflowId: 'video-workflow', videoWorkflowVersionId: 'video-version-1',
    })),
  },
}))

const bindingMock = vi.hoisted(() => ({
  updateProjectWithComfyDefaults: vi.fn(async (input: { projectData: Record<string, unknown> }) => ({
    novelPromotionProject: { id: 'np-1', ...input.projectData },
  })),
}))
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
    expect(bindingMock.updateProjectWithComfyDefaults).toHaveBeenCalledWith({
      userId: 'user-1', projectId: 'project-1', projectData: {},
      imageWorkflowId: 'image-workflow', videoWorkflowId: 'video-workflow',
    })
    expect(prismaMock.novelPromotionProject.update).not.toHaveBeenCalled()
  })

  it('clears a Comfy binding without overwriting the specialized provider model', async () => {
    const route = await import('@/app/api/novel-promotion/[projectId]/route')
    const response = await route.PATCH(buildMockRequest({
      path: '/api/novel-promotion/project-1', method: 'PATCH',
      body: { comfyImageWorkflowId: null },
    }), { params: Promise.resolve({ projectId: 'project-1' }) })

    expect(response.status).toBe(200)
    expect(bindingMock.updateProjectWithComfyDefaults).toHaveBeenCalledWith({
      userId: 'user-1', projectId: 'project-1', projectData: {}, imageWorkflowId: null,
    })
    expect(prismaMock.novelPromotionProject.update).not.toHaveBeenCalled()
  })

  it('resolves strict precedence task override then Comfy binding then project model then user default', async () => {
    const { getProjectModelConfig } = await import('@/lib/config-service')

    const taskConfig = await getProjectModelConfig('project-1', 'user-1', {
      imageModel: 'task::image', videoModel: 'task::video',
    })
    expect(taskConfig.storyboardModel).toBe('task::image')
    expect(taskConfig.videoModel).toBe('task::video')
    expect(taskConfig.comfyImageWorkflowVersionId).toBeNull()
    expect(taskConfig.comfyVideoWorkflowVersionId).toBeNull()

    const bindingConfig = await getProjectModelConfig('project-1', 'user-1')
    expect(bindingConfig.characterModel).toBe('comfyui::image-workflow')
    expect(bindingConfig.locationModel).toBe('comfyui::image-workflow')
    expect(bindingConfig.storyboardModel).toBe('comfyui::image-workflow')
    expect(bindingConfig.editModel).toBe('comfyui::image-workflow')
    expect(bindingConfig.videoModel).toBe('comfyui::video-workflow')
    expect(bindingConfig.comfyImageWorkflowVersionId).toBe('image-version-1')
    expect(bindingConfig.comfyVideoWorkflowVersionId).toBe('video-version-1')

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

  it('central image payload builder snapshots the pinned Comfy version', async () => {
    const { buildImageBillingPayload, getProjectModelConfig } = await import('@/lib/config-service')
    const projectModelConfig = await getProjectModelConfig('project-1', 'user-1')
    const payload = await buildImageBillingPayload({
      projectId: 'project-1', userId: 'user-1',
      imageModel: projectModelConfig.storyboardModel,
      projectModelConfig,
      basePayload: { candidateCount: 2 },
    })
    expect(payload).toMatchObject({
      imageModel: 'comfyui::image-workflow',
      comfyWorkflowVersionId: 'image-version-1',
      candidateCount: 2,
    })
  })

  it.each([
    ['null body', null],
    ['array body', []],
    ['unknown field', { surprise: true }],
    ['oversized workflow id', { comfyImageWorkflowId: `w${'x'.repeat(191)}` }],
    ['malformed workflow id', { comfyVideoWorkflowId: 'bad:id' }],
  ])('rejects %s before any database write or audit', async (_case, requestBody) => {
    const route = await import('@/app/api/novel-promotion/[projectId]/route')
    const response = await route.PATCH(buildMockRequest({
      path: '/api/novel-promotion/project-1', method: 'PATCH', body: requestBody,
    }), { params: Promise.resolve({ projectId: 'project-1' }) })

    expect(response.status).toBe(400)
    expect(bindingMock.updateProjectWithComfyDefaults).not.toHaveBeenCalled()
    expect(prismaMock.novelPromotionProject.update).not.toHaveBeenCalled()
  })
})
