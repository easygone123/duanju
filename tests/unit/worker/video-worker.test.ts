import type { Job } from 'bullmq'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TASK_TYPE, type TaskJobData } from '@/lib/task/types'
import { resolveVideoTaskSnapshot, type TaskModelSnapshot } from '@/lib/workers/task-model-snapshot'

type WorkerProcessor = (job: Job<TaskJobData>) => Promise<unknown>

type PanelRow = {
  id: string
  videoUrl: string | null
  imageUrl: string | null
  videoPrompt: string | null
  description: string | null
  firstLastFramePrompt: string | null
  duration: number | null
}

const workerState = vi.hoisted(() => ({
  processor: null as WorkerProcessor | null,
}))

const reportTaskProgressMock = vi.hoisted(() => vi.fn(async () => undefined))
const withTaskLifecycleMock = vi.hoisted(() =>
  vi.fn(async (job: Job<TaskJobData>, handler: WorkerProcessor) => await handler(job)),
)

const utilsMock = vi.hoisted(() => ({
  assertTaskActive: vi.fn(async () => undefined),
  getProjectModels: vi.fn(async () => ({ videoRatio: '16:9' })),
  resolveLipSyncVideoSource: vi.fn(async () => 'https://provider.example/lipsync.mp4'),
  resolveVideoSourceFromGeneration: vi.fn<(...args: unknown[]) => Promise<{ url: string; storageKey?: string; actualVideoTokens?: number; downloadHeaders?: Record<string, string> }>>(async () => ({ url: 'https://provider.example/video.mp4' })),
  toSignedUrlIfCos: vi.fn((url: string | null) => (url ? `https://signed.example/${url}` : null)),
  uploadVideoSourceToCos: vi.fn(async () => 'cos/lip-sync/video.mp4'),
}))
const configServiceMock = vi.hoisted(() => ({
  getUserWorkflowConcurrencyConfig: vi.fn(async () => ({
    analysis: 5,
    image: 5,
    video: 5,
  })),
}))
const concurrencyGateMock = vi.hoisted(() => ({
  withUserConcurrencyGate: vi.fn(async <T>(input: {
    run: () => Promise<T>
  }) => await input.run()),
}))
const capabilityMock = vi.hoisted(() => vi.fn<
  (mediaType: string, modelKey: string) => { video: { firstlastframe: boolean } } | undefined
>(() => ({ video: { firstlastframe: true } })))
const normalizeToBase64ForGenerationMock = vi.hoisted(() => vi.fn(async (input: string) => (
  input.includes('last') ? 'data:image/png;base64,TEFTVA==' : 'data:image/png;base64,RklSU1Q='
)))
const fetchMock = vi.hoisted(() => vi.fn())
const deleteObjectMock = vi.hoisted(() => vi.fn(async () => undefined))
const ensureMediaObjectMock = vi.hoisted(() => vi.fn(async (storageKey: string) => ({
  id: `media:${storageKey}`,
  url: storageKey,
})))

const prismaMock = vi.hoisted(() => ({
  novelPromotionPanel: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(async () => undefined),
    updateMany: vi.fn(async () => ({ count: 1 })),
  },
  novelPromotionVoiceLine: {
    findUnique: vi.fn(),
  },
  mediaObject: {
    deleteMany: vi.fn(async () => ({ count: 1 })),
  },
}))

vi.mock('bullmq', () => ({
  Queue: class {
    constructor(name: string) {
      void name
    }

    async add() {
      return { id: 'job-1' }
    }

    async getJob() {
      return null
    }
  },
  Worker: class {
    constructor(name: string, processor: WorkerProcessor) {
      void name
      workerState.processor = processor
    }
  },
}))

vi.mock('@/lib/redis', () => ({ queueRedis: {} }))
vi.mock('@/lib/workers/shared', () => ({
  reportTaskProgress: reportTaskProgressMock,
  withTaskLifecycle: withTaskLifecycleMock,
}))
vi.mock('@/lib/workers/utils', () => utilsMock)
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('@/lib/storage', () => ({ deleteObject: deleteObjectMock }))
vi.mock('@/lib/media/service', () => ({
  ensureMediaObjectFromStorageKey: ensureMediaObjectMock,
}))
vi.mock('@/lib/media/outbound-image', () => ({
  normalizeToBase64ForGeneration: normalizeToBase64ForGenerationMock,
}))
vi.mock('@/lib/model-capabilities/lookup', () => ({
  resolveBuiltinCapabilitiesByModelKey: capabilityMock,
}))
vi.mock('@/lib/api-config', () => ({
  getProviderConfig: vi.fn(async () => ({ apiKey: 'api-key' })),
}))
vi.mock('@/lib/config-service', () => configServiceMock)
vi.mock('@/lib/workers/user-concurrency-gate', () => concurrencyGateMock)

function buildPanel(overrides?: Partial<PanelRow>): PanelRow {
  return {
    id: 'panel-1',
    videoUrl: 'cos/base-video.mp4',
    imageUrl: 'cos/panel-image.png',
    videoPrompt: 'panel prompt',
    description: 'panel description',
    firstLastFramePrompt: null,
    duration: 5,
    ...(overrides || {}),
  }
}

function buildJob(params: {
  type: TaskJobData['type']
  payload?: Record<string, unknown>
  targetType?: string
  targetId?: string
}): Job<TaskJobData> {
  return {
    data: {
      taskId: 'task-1',
      type: params.type,
      locale: 'zh',
      projectId: 'project-1',
      episodeId: 'episode-1',
      targetType: params.targetType ?? 'NovelPromotionPanel',
      targetId: params.targetId ?? 'panel-1',
      payload: params.payload ?? {},
      userId: 'user-1',
    },
  } as unknown as Job<TaskJobData>
}

function useBehaviorFaithfulVideoBoundary(
  assertion: (snapshot: TaskModelSnapshot, params: {
    modelId: string
    comfyWorkflowVersionId?: string
    imageUrl: string
  }) => void,
) {
  utilsMock.resolveVideoSourceFromGeneration.mockImplementationOnce(async (...args: unknown[]) => {
    const job = args[0] as Job<TaskJobData>
    const params = args[1] as {
      modelId: string
      comfyWorkflowVersionId?: string
      imageUrl: string
    }
    const snapshot = resolveVideoTaskSnapshot(job.data.payload, {
      model: params.modelId,
      comfyWorkflowVersionId: params.comfyWorkflowVersionId,
    })
    assertion(snapshot, params)
    return { url: 'https://provider.example/video.mp4' }
  })
}

describe('worker video processor behavior', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchMock)
    workerState.processor = null
    capabilityMock.mockReset()
    capabilityMock.mockReturnValue({ video: { firstlastframe: true } })
    utilsMock.resolveVideoSourceFromGeneration.mockReset()
    utilsMock.resolveVideoSourceFromGeneration.mockResolvedValue({
      url: 'https://provider.example/video.mp4',
    })

    prismaMock.novelPromotionPanel.findUnique.mockResolvedValue(buildPanel())
    prismaMock.novelPromotionPanel.findFirst.mockResolvedValue(buildPanel())
    prismaMock.novelPromotionVoiceLine.findUnique.mockResolvedValue({
      id: 'line-1',
      audioUrl: 'cos/line-1.mp3',
      audioDuration: 1200,
      enabled: true,
      lineType: 'dialogue',
      matchedPanelId: 'panel-1',
    })

    const mod = await import('@/lib/workers/video.worker')
    mod.createVideoWorker()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('VIDEO_PANEL: 缺少 payload.videoModel 时显式失败', async () => {
    const processor = workerState.processor
    expect(processor).toBeTruthy()

    const job = buildJob({
      type: TASK_TYPE.VIDEO_PANEL,
      payload: {},
    })

    await expect(processor!(job)).rejects.toThrow('VIDEO_MODEL_REQUIRED: payload video model is required')
  })

  it('VIDEO_PANEL: 透传异步轮询返回的下载头到 COS 上传', async () => {
    const processor = workerState.processor
    expect(processor).toBeTruthy()

    utilsMock.resolveVideoSourceFromGeneration.mockResolvedValueOnce({
      url: 'https://provider.example/video.mp4',
      downloadHeaders: {
        Authorization: 'Bearer oa-key',
      },
    })

    const job = buildJob({
      type: TASK_TYPE.VIDEO_PANEL,
      payload: {
        videoModel: 'openai-compatible:oa-1::sora-2',
        generationOptions: {
          duration: 8,
          resolution: '720p',
        },
      },
    })

    await processor!(job)

    expect(utilsMock.uploadVideoSourceToCos).toHaveBeenCalledWith(
      'https://provider.example/video.mp4',
      'panel-video',
      'panel-1',
      {
        Authorization: 'Bearer oa-key',
      },
    )
  })

  it.each([
    ['normal', {}],
    ['first-last-frame', {
      firstLastFrame: {
        flModel: 'cloud::normal',
        customPrompt: 'FORGED FIRST LAST PROMPT',
      },
    }],
  ])('VIDEO_PANEL: %s execution always uses the queued authoritative videoPrompt', async (_mode, modePayload) => {
    const processor = workerState.processor
    expect(processor).toBeTruthy()

    await processor!(buildJob({
      type: TASK_TYPE.VIDEO_PANEL,
      payload: {
        videoModel: 'cloud::normal',
        videoPrompt: 'SERVER AUTHORITATIVE PROMPT',
        customPrompt: 'FORGED ROOT PROMPT',
        ...modePayload,
      },
    }))

    expect(utilsMock.resolveVideoSourceFromGeneration).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        options: expect.objectContaining({
          prompt: 'SERVER AUTHORITATIVE PROMPT',
        }),
      }),
    )
  })

  it('VIDEO_PANEL: 将 Ark 返回的实际视频 token 用量透传到任务结果', async () => {
    const processor = workerState.processor
    expect(processor).toBeTruthy()

    utilsMock.resolveVideoSourceFromGeneration.mockResolvedValueOnce({
      url: 'https://provider.example/video.mp4',
      actualVideoTokens: 108000,
    })

    const job = buildJob({
      type: TASK_TYPE.VIDEO_PANEL,
      payload: {
        videoModel: 'ark::doubao-seedance-2-0-260128',
        generationOptions: {
          duration: 5,
          resolution: '720p',
        },
      },
    })

    const result = await processor!(job) as { panelId: string; videoUrl: string; actualVideoTokens: number }
    expect(result).toEqual({
      panelId: 'panel-1',
      videoUrl: 'cos/lip-sync/video.mp4',
      videoMediaId: 'media:cos/lip-sync/video.mp4',
      actualVideoTokens: 108000,
    })
  })

  it('VIDEO_PANEL: ComfyUI first-last-frame bypasses the cloud capability catalog', async () => {
    const processor = workerState.processor
    capabilityMock.mockReturnValueOnce(undefined)
    prismaMock.novelPromotionPanel.findFirst.mockResolvedValueOnce(buildPanel({
      id: 'last-panel', imageUrl: 'cos/last.png',
    }))
    await processor!(buildJob({
      type: TASK_TYPE.VIDEO_PANEL,
      payload: {
        videoModel: 'comfyui::wf-video',
        videoPrompt: 'SERVER FIRST LAST PROMPT',
        generationOptions: { duration: 5 },
        firstLastFrame: {
          flModel: 'comfyui::wf-video',
          sourcePanelId: 'last-panel',
        },
      },
    }))
    expect(capabilityMock).not.toHaveBeenCalled()
    expect(prismaMock.novelPromotionPanel.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'last-panel',
        storyboard: { episode: { novelPromotionProject: {
          projectId: 'project-1', project: { userId: 'user-1' },
        } } },
      },
    })
    expect(utilsMock.resolveVideoSourceFromGeneration).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        modelId: 'comfyui::wf-video',
        imageUrl: 'cos/panel-image.png',
        comfyFirstFrameSource: 'cos/panel-image.png',
        comfyLastFrameSource: 'cos/last.png',
        options: expect.objectContaining({ prompt: 'SERVER FIRST LAST PROMPT', duration: 5 }),
      }),
    )
    expect(normalizeToBase64ForGenerationMock).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('VIDEO_PANEL: reuses the durable ComfyUI output instead of downloading a container-inaccessible signed URL', async () => {
    utilsMock.resolveVideoSourceFromGeneration.mockResolvedValueOnce({
      url: 'http://localhost:19000/signed-result.mp4',
      storageKey: 'comfyui/user-1/project-1/result.mp4',
    })

    const result = await workerState.processor!(buildJob({
      type: TASK_TYPE.VIDEO_PANEL,
      payload: {
        videoModel: 'comfyui::wf-video',
        videoPrompt: 'SERVER PROMPT',
        generationOptions: { duration: 5 },
      },
    }))

    expect(utilsMock.uploadVideoSourceToCos).not.toHaveBeenCalled()
    expect(prismaMock.novelPromotionPanel.update).toHaveBeenCalledWith({
      where: { id: 'panel-1' },
      data: {
        videoUrl: 'comfyui/user-1/project-1/result.mp4',
        videoMediaId: 'media:comfyui/user-1/project-1/result.mp4',
        videoGenerationMode: 'normal',
      },
    })
    expect(result).toMatchObject({ videoUrl: 'comfyui/user-1/project-1/result.mp4' })
  })

  it('VIDEO_PANEL: uses the trusted manual first-frame panel image instead of the target image', async () => {
    prismaMock.novelPromotionPanel.findFirst.mockImplementation(async ({ where }: { where: { id?: string } }) => {
      if (where.id === 'manual-first-panel') {
        return buildPanel({ id: 'manual-first-panel', imageUrl: 'cos/manual-first.png' })
      }
      if (where.id === 'last-panel') {
        return buildPanel({ id: 'last-panel', imageUrl: 'cos/last.png' })
      }
      return null
    })

    await workerState.processor!(buildJob({
      type: TASK_TYPE.VIDEO_PANEL,
      payload: {
        videoModel: 'comfyui::wf-video',
        videoPrompt: 'SERVER FIRST LAST PROMPT',
        firstLastFrame: {
          flModel: 'comfyui::wf-video',
          firstFrameSourcePanelId: 'manual-first-panel',
          sourcePanelId: 'last-panel',
        },
      },
    }))

    expect(utilsMock.resolveVideoSourceFromGeneration).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        imageUrl: 'cos/manual-first.png',
        comfyFirstFrameSource: 'cos/manual-first.png',
        comfyLastFrameSource: 'cos/last.png',
        options: expect.not.objectContaining({ lastFrameImageUrl: expect.anything() }),
      }),
    )
    expect(normalizeToBase64ForGenerationMock).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('VIDEO_PANEL: cloud first-last-frame keeps normalized data URL inputs', async () => {
    prismaMock.novelPromotionPanel.findFirst.mockResolvedValueOnce(buildPanel({
      id: 'last-panel', imageUrl: 'users/u/projects/p/last.png',
    }))

    await workerState.processor!(buildJob({
      type: TASK_TYPE.VIDEO_PANEL,
      payload: {
        videoModel: 'fal::cloud-video',
        videoPrompt: 'SERVER FIRST LAST PROMPT',
        firstLastFrame: {
          flModel: 'fal::cloud-video',
          sourcePanelId: 'last-panel',
        },
      },
    }))

    expect(normalizeToBase64ForGenerationMock).toHaveBeenNthCalledWith(
      1,
      'https://signed.example/cos/panel-image.png',
    )
    expect(normalizeToBase64ForGenerationMock).toHaveBeenNthCalledWith(
      2,
      'https://signed.example/users/u/projects/p/last.png',
    )
    expect(utilsMock.resolveVideoSourceFromGeneration).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        modelId: 'fal::cloud-video',
        imageUrl: 'data:image/png;base64,RklSU1Q=',
        options: expect.objectContaining({
          lastFrameImageUrl: 'data:image/png;base64,TEFTVA==',
        }),
      }),
    )
  })

  it('VIDEO_PANEL: authoritative cloud model normalizes when legacy first-last model looks Comfy', async () => {
    useBehaviorFaithfulVideoBoundary((snapshot, params) => {
      expect(snapshot.model).toBe('fal::cloud-video')
      expect(params.modelId).toBe(snapshot.model)
      expect(params.imageUrl).toBe('data:image/png;base64,RklSU1Q=')
    })

    await workerState.processor!(buildJob({
      type: TASK_TYPE.VIDEO_PANEL,
      payload: {
        videoModel: 'fal::cloud-video',
        videoPrompt: 'AUTHORITATIVE CLOUD PROMPT',
        firstLastFrame: {
          flModel: 'comfyui::legacy-video',
        },
      },
    }))

    expect(normalizeToBase64ForGenerationMock).toHaveBeenCalledWith(
      'https://signed.example/cos/panel-image.png',
    )
  })

  it('VIDEO_PANEL: authoritative Comfy model preserves raw source when legacy first-last model looks cloud', async () => {
    useBehaviorFaithfulVideoBoundary((snapshot, params) => {
      expect(snapshot.model).toBe('comfyui::workflow-video')
      expect(params.modelId).toBe(snapshot.model)
      expect(params.imageUrl).toBe('cos/panel-image.png')
    })

    await workerState.processor!(buildJob({
      type: TASK_TYPE.VIDEO_PANEL,
      payload: {
        videoModel: 'comfyui::workflow-video',
        comfyWorkflowVersionId: 'workflow-video-version-1',
        comfyModelSnapshotVersion: 1,
        videoPrompt: 'AUTHORITATIVE COMFY PROMPT',
        firstLastFrame: {
          flModel: 'fal::legacy-video',
        },
      },
    }))

    expect(normalizeToBase64ForGenerationMock).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('VIDEO_PANEL: rejects a trusted-looking last-frame id that is outside the task project', async () => {
    prismaMock.novelPromotionPanel.findFirst.mockResolvedValueOnce(null)

    await expect(workerState.processor!(buildJob({
      type: TASK_TYPE.VIDEO_PANEL,
      payload: {
        videoModel: 'comfyui::wf-video',
        videoPrompt: 'SERVER FIRST LAST PROMPT',
        firstLastFrame: { flModel: 'comfyui::wf-video', sourcePanelId: 'foreign-panel' },
      },
    }))).rejects.toThrow('VIDEO_LAST_FRAME_SOURCE_FORBIDDEN')

    expect(utilsMock.resolveVideoSourceFromGeneration).not.toHaveBeenCalled()
  })

  it('VIDEO_PANEL: unsupported cloud first-last-frame still fails closed', async () => {
    const processor = workerState.processor
    capabilityMock.mockReturnValueOnce(undefined)
    await expect(processor!(buildJob({
      type: TASK_TYPE.VIDEO_PANEL,
      payload: { videoModel: 'cloud::unsupported', firstLastFrame: { flModel: 'cloud::unsupported' } },
    }))).rejects.toThrow('VIDEO_FIRSTLASTFRAME_MODEL_UNSUPPORTED: cloud::unsupported')
  })

  it('LIP_SYNC: 缺少 panel 时显式失败', async () => {
    const processor = workerState.processor
    expect(processor).toBeTruthy()

    prismaMock.novelPromotionPanel.findUnique.mockResolvedValueOnce(null)
    const job = buildJob({
      type: TASK_TYPE.LIP_SYNC,
      payload: { voiceLineId: 'line-1' },
      targetId: 'panel-missing',
    })

    await expect(processor!(job)).rejects.toThrow('Lip-sync panel not found')
  })

  it('LIP_SYNC: 正常路径写回 lipSyncVideoUrl 并清理 lipSyncTaskId', async () => {
    const processor = workerState.processor
    expect(processor).toBeTruthy()

    const job = buildJob({
      type: TASK_TYPE.LIP_SYNC,
      payload: {
        voiceLineId: 'line-1',
        lipSyncModel: 'fal::lipsync-model',
      },
      targetId: 'panel-1',
    })

    const result = await processor!(job) as { panelId: string; voiceLineId: string; lipSyncVideoUrl: string }
    expect(result).toEqual({
      panelId: 'panel-1',
      voiceLineId: 'line-1',
      lipSyncVideoUrl: 'cos/lip-sync/video.mp4',
      lipSyncVideoMediaId: 'media:cos/lip-sync/video.mp4',
    })

    expect(utilsMock.resolveLipSyncVideoSource).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: 'user-1',
        modelKey: 'fal::lipsync-model',
        audioDurationMs: 1200,
        videoDurationMs: 5000,
      }),
    )

    expect(utilsMock.uploadVideoSourceToCos).toHaveBeenCalledWith(
      'https://provider.example/lipsync.mp4',
      'lip-sync',
      'panel-1-task-1',
    )
    expect(prismaMock.novelPromotionPanel.update).toHaveBeenCalledWith({
      where: { id: 'panel-1' },
      data: {
        lipSyncVideoUrl: 'cos/lip-sync/video.mp4',
        lipSyncVideoMediaId: 'media:cos/lip-sync/video.mp4',
        lipSyncTaskId: null,
      },
    })
  })

  it('LIP_SYNC: drops narration output when narration is disabled after provider completion', async () => {
    prismaMock.novelPromotionVoiceLine.findUnique
      .mockResolvedValueOnce({
        id: 'line-1',
        audioUrl: 'cos/line-1.mp3',
        audioDuration: 1200,
        enabled: true,
        lineType: 'narration',
        matchedPanelId: 'panel-1',
      })
      .mockResolvedValueOnce({
        id: 'line-1',
        audioUrl: 'cos/line-1.mp3',
        enabled: false,
        lineType: 'narration',
        matchedPanelId: 'panel-1',
      })

    await expect(workerState.processor!(buildJob({
      type: TASK_TYPE.LIP_SYNC,
      payload: { voiceLineId: 'line-1' },
    }))).rejects.toThrow('LIP_SYNC_INPUT_STALE')

    expect(utilsMock.resolveLipSyncVideoSource).toHaveBeenCalledTimes(1)
    expect(utilsMock.uploadVideoSourceToCos).not.toHaveBeenCalled()
    expect(prismaMock.novelPromotionPanel.updateMany).not.toHaveBeenCalled()
  })

  it('LIP_SYNC: drops narration output when its audio snapshot changes after provider completion', async () => {
    prismaMock.novelPromotionVoiceLine.findUnique
      .mockResolvedValueOnce({
        id: 'line-1',
        audioUrl: 'cos/line-1.mp3',
        audioDuration: 1200,
        enabled: true,
        lineType: 'narration',
        matchedPanelId: 'panel-1',
      })
      .mockResolvedValueOnce({
        id: 'line-1',
        audioUrl: 'cos/new-line-1.mp3',
        enabled: true,
        lineType: 'narration',
        matchedPanelId: 'panel-1',
      })

    await expect(workerState.processor!(buildJob({
      type: TASK_TYPE.LIP_SYNC,
      payload: { voiceLineId: 'line-1' },
    }))).rejects.toThrow('LIP_SYNC_INPUT_STALE')

    expect(utilsMock.uploadVideoSourceToCos).not.toHaveBeenCalled()
    expect(prismaMock.novelPromotionPanel.updateMany).not.toHaveBeenCalled()
  })

  it('LIP_SYNC: cleans the unique upload when narration publish CAS loses a race', async () => {
    prismaMock.novelPromotionVoiceLine.findUnique.mockResolvedValue({
      id: 'line-1',
      audioUrl: 'cos/line-1.mp3',
      audioDuration: 1200,
      enabled: true,
      lineType: 'narration',
      matchedPanelId: 'panel-1',
    })
    prismaMock.novelPromotionPanel.updateMany.mockResolvedValueOnce({ count: 0 })

    await expect(workerState.processor!(buildJob({
      type: TASK_TYPE.LIP_SYNC,
      payload: { voiceLineId: 'line-1' },
    }))).rejects.toThrow('LIP_SYNC_INPUT_STALE')

    expect(prismaMock.mediaObject.deleteMany).toHaveBeenCalledWith({
      where: { id: 'media:cos/lip-sync/video.mp4' },
    })
    expect(deleteObjectMock).toHaveBeenCalledWith('cos/lip-sync/video.mp4')
  })

  it('未知任务类型: 显式报错', async () => {
    const processor = workerState.processor
    expect(processor).toBeTruthy()

    const unsupportedJob = buildJob({
      type: TASK_TYPE.AI_CREATE_CHARACTER,
    })

    await expect(processor!(unsupportedJob)).rejects.toThrow('Unsupported video task type')
  })
})
