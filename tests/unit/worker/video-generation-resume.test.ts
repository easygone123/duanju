import type { Job } from 'bullmq'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskJobData } from '@/lib/task/types'

const prismaMock = vi.hoisted(() => ({
  task: {
    findUnique: vi.fn(),
  },
}))

const taskServiceMock = vi.hoisted(() => ({
  isTaskActive: vi.fn(async () => true),
  trySetTaskExternalId: vi.fn(async () => true),
}))

const asyncPollMock = vi.hoisted(() => ({
  pollAsyncTask: vi.fn(),
}))

const generatorApiMock = vi.hoisted(() => ({
  generateImage: vi.fn(),
  generateVideo: vi.fn(),
}))

const configServiceMock = vi.hoisted(() => ({
  getProjectModelConfig: vi.fn(),
  getUserModelConfig: vi.fn(),
  resolveProjectComfyWorkflowVersion: vi.fn((config: {
    comfyImageWorkflowVersionId?: string
    comfyVideoWorkflowVersionId?: string
  }, _modelKey: string, mediaType: 'image' | 'video') => (
    mediaType === 'image' ? config.comfyImageWorkflowVersionId : config.comfyVideoWorkflowVersionId
  )),
  resolveProjectModelCapabilityGenerationOptions: vi.fn(async () => ({})),
}))

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('@/lib/task/service', () => taskServiceMock)
vi.mock('@/lib/async-poll', () => asyncPollMock)
vi.mock('@/lib/generator-api', () => generatorApiMock)
vi.mock('@/lib/lipsync', () => ({ generateLipSync: vi.fn() }))
vi.mock('@/lib/storage', () => ({
  getSignedUrl: vi.fn((value: string) => value),
  toFetchableUrl: vi.fn((value: string) => value),
}))
vi.mock('@/lib/fonts', () => ({ initializeFonts: vi.fn(), createLabelSVG: vi.fn() }))
vi.mock('@/lib/media-process', () => ({ processMediaResult: vi.fn() }))
vi.mock('@/lib/config-service', () => configServiceMock)

function currentComfyConfig() {
  return {
    characterModel: 'comfyui::wf-image',
    locationModel: 'comfyui::wf-image',
    storyboardModel: 'comfyui::wf-image',
    editModel: 'comfyui::wf-image',
    videoModel: 'comfyui::wf-video',
    comfyImageWorkflowVersionId: 'wf-image-version-1',
    comfyVideoWorkflowVersionId: 'wf-video-version-1',
  }
}

import { resolveImageSourceFromGeneration, resolveVideoSourceFromGeneration } from '@/lib/workers/utils'

function buildJob(): Job<TaskJobData> {
  return {
    data: {
      taskId: 'task-1',
      type: 'VIDEO_PANEL',
      locale: 'zh',
      projectId: 'project-1',
      episodeId: 'episode-1',
      targetType: 'NovelPromotionPanel',
      targetId: 'panel-1',
      payload: {},
      userId: 'user-1',
    },
  } as unknown as Job<TaskJobData>
}

describe('worker utils video generation resume', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    configServiceMock.getProjectModelConfig.mockResolvedValue(currentComfyConfig())
  })

  it('continues polling from existing externalId without re-submitting generation', async () => {
    const externalId = 'OPENAI:VIDEO:b3BlbmFpLWNvbXBhdGlibGU6b2EtMQ:vid_123'
    prismaMock.task.findUnique.mockResolvedValueOnce({ externalId })
    asyncPollMock.pollAsyncTask.mockResolvedValueOnce({
      status: 'completed',
      resultUrl: 'https://oa.test/v1/videos/vid_123/content',
      downloadHeaders: {
        Authorization: 'Bearer oa-key',
      },
    })

    const result = await resolveVideoSourceFromGeneration(buildJob(), {
      userId: 'user-1',
      modelId: 'openai-compatible:oa-1::sora-2',
      invocationKey: 'task-1:video:0',
      imageUrl: 'data:image/png;base64,QQ==',
      options: {
        prompt: 'animate this frame',
      },
    })

    expect(result).toEqual({
      url: 'https://oa.test/v1/videos/vid_123/content',
      downloadHeaders: {
        Authorization: 'Bearer oa-key',
      },
    })
    expect(asyncPollMock.pollAsyncTask).toHaveBeenCalledWith(externalId, 'user-1')
    expect(generatorApiMock.generateVideo).not.toHaveBeenCalled()
  })

  it('prevents duplicate panel candidates by skipping task externalId resume when requested', async () => {
    prismaMock.task.findUnique.mockResolvedValueOnce({ externalId: 'FAL:IMAGE:fal-ai/nano-banana-pro:req_1' })
    generatorApiMock.generateImage.mockResolvedValueOnce({
      success: true,
      imageUrl: 'https://fal.test/new-image.png',
    })

    const result = await resolveImageSourceFromGeneration(buildJob(), {
      userId: 'user-1',
      modelId: 'fal::banana',
      invocationKey: 'task-1:image:0',
      prompt: 'a cinematic portrait',
      options: {
        aspectRatio: '16:9',
      },
      allowTaskExternalIdResume: false,
    })

    expect(result).toBe('https://fal.test/new-image.png')
    expect(prismaMock.task.findUnique).not.toHaveBeenCalled()
    expect(asyncPollMock.pollAsyncTask).not.toHaveBeenCalled()
    expect(generatorApiMock.generateImage).toHaveBeenCalledTimes(1)
  })

  it('ignores task-level externalId for ComfyUI and re-enters the invocation-idempotent provider', async () => {
    prismaMock.task.findUnique.mockResolvedValueOnce({ externalId: 'COMFY:IMAGE:other-invocation' })
    generatorApiMock.generateImage.mockResolvedValueOnce({
      success: true,
      async: true,
      externalId: 'COMFY:IMAGE:same-invocation',
    })
    asyncPollMock.pollAsyncTask.mockResolvedValueOnce({
      status: 'completed', resultUrl: 'https://store/same.png',
    })
    const result = await resolveImageSourceFromGeneration(buildJob(), {
      userId: 'user-1', modelId: 'comfyui::wf-image',
      invocationKey: 'task-1:panel:p1:candidate:1', prompt: 'rain',
      allowTaskExternalIdResume: true,
    })
    expect(result).toBe('https://store/same.png')
    expect(generatorApiMock.generateImage).toHaveBeenCalledTimes(1)
  })

  it('can return the already-durable ComfyUI storage key instead of an internal HTTP URL', async () => {
    generatorApiMock.generateImage.mockResolvedValueOnce({
      success: true,
      async: true,
      externalId: 'COMFY:IMAGE:same-invocation',
    })
    asyncPollMock.pollAsyncTask.mockResolvedValueOnce({
      status: 'completed',
      resultUrl: '/api/storage/sign?key=comfyui%2Fresult.png',
      resultStorageKey: 'comfyui/user-1/project-1/result.png',
    })

    const result = await resolveImageSourceFromGeneration(buildJob(), {
      userId: 'user-1', modelId: 'comfyui::wf-image',
      invocationKey: 'task-1:sheet:1', prompt: 'six-grid',
      preferComfyStorageKey: true,
    })

    expect(result).toBe('comfyui/user-1/project-1/result.png')
  })

  it('returns the already-durable ComfyUI video storage key with the polling result', async () => {
    generatorApiMock.generateVideo.mockResolvedValueOnce({
      success: true,
      async: true,
      externalId: 'COMFY:VIDEO:same-invocation',
    })
    asyncPollMock.pollAsyncTask.mockResolvedValueOnce({
      status: 'completed',
      resultUrl: 'http://localhost:19000/signed-result.mp4',
      resultStorageKey: 'comfyui/user-1/project-1/result.mp4',
    })

    const result = await resolveVideoSourceFromGeneration(buildJob(), {
      userId: 'user-1', modelId: 'comfyui::wf-video',
      invocationKey: 'task-1:panel:p1:video', imageUrl: '',
      options: { prompt: 'move', duration: 5 },
    })

    expect(result).toEqual({
      url: 'http://localhost:19000/signed-result.mp4',
      storageKey: 'comfyui/user-1/project-1/result.mp4',
    })
  })

  it('backfills the trusted pin for an old unmarked Comfy image task when current selection is unchanged', async () => {
    const job = buildJob()
    job.data.payload = { imageModel: 'comfyui::wf-image' }
    generatorApiMock.generateImage.mockResolvedValueOnce({
      success: true, imageUrl: 'https://store/legacy-image.png',
    })

    await resolveImageSourceFromGeneration(job, {
      userId: 'user-1', modelId: 'comfyui::wf-image',
      invocationKey: 'task-1:legacy-image', prompt: 'legacy',
    })

    expect(generatorApiMock.generateImage).toHaveBeenCalledWith(
      'user-1', 'comfyui::wf-image', 'legacy',
      expect.objectContaining({
        comfy: expect.objectContaining({ workflowVersionId: 'wf-image-version-1' }),
      }),
    )
  })

  it('rejects an old unmarked Comfy image task after current selection changes', async () => {
    const job = buildJob()
    job.data.payload = { imageModel: 'comfyui::old-image-workflow' }

    await expect(resolveImageSourceFromGeneration(job, {
      userId: 'user-1', modelId: 'comfyui::wf-image',
      invocationKey: 'task-1:stale-image', prompt: 'legacy',
    })).rejects.toThrow('TASK_MODEL_SNAPSHOT_INVALID')
    expect(generatorApiMock.generateImage).not.toHaveBeenCalled()
  })

  it('backfills the trusted pin for an old unmarked Comfy video task when current selection is unchanged', async () => {
    const job = buildJob()
    job.data.payload = { videoModel: 'comfyui::wf-video' }
    generatorApiMock.generateVideo.mockResolvedValueOnce({
      success: true, videoUrl: 'https://store/legacy-video.mp4',
    })

    await resolveVideoSourceFromGeneration(job, {
      userId: 'user-1', modelId: 'comfyui::wf-video',
      invocationKey: 'task-1:legacy-video', imageUrl: '',
    })

    expect(generatorApiMock.generateVideo).toHaveBeenCalledWith(
      'user-1', 'comfyui::wf-video', '',
      expect.objectContaining({
        comfy: expect.objectContaining({ workflowVersionId: 'wf-video-version-1' }),
      }),
    )
  })
})
