import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

type PanelRow = {
  id: string
  updatedAt: Date
  hasDialogue: boolean
  dialogueSpeaker: string | null
  dialogueText: string | null
  dialogueEmotion: string | null
  includeDialogueInVideoPrompt: boolean
  videoPrompt: string
  firstLastFramePrompt: string | null
  estimatedDuration: number
  durationOverride: number | null
  duration: number
  firstFrameSourceMeta?: string | null
  lastFrameSourceMeta?: string | null
  storyboard?: { episodeId: string }
}

type SubmittedTaskInput = {
  targetId: string
  payload: Record<string, unknown>
}

const capabilityMock = vi.hoisted(() => vi.fn())
const submitTaskMock = vi.hoisted(() => vi.fn<(input: SubmittedTaskInput) => Promise<{ id: string }>>(async (input) => {
  void input
  return { id: 'task-1' }
}))
const panelFindFirstMock = vi.hoisted(() => vi.fn())
const panelFindManyMock = vi.hoisted(() => vi.fn<() => Promise<PanelRow[]>>(async () => []))
const storyboardFindManyMock = vi.hoisted(() => (
  vi.fn<() => Promise<Array<Record<string, unknown>>>>(async () => [])
))
const panelUpdateManyMock = vi.hoisted(() => vi.fn(async (args: unknown) => {
  void args
  return { count: 1 }
}))
const getProjectModelConfigMock = vi.hoisted(() => vi.fn())
const comfyVersionFindFirstMock = vi.hoisted(() => vi.fn())
const userPreferenceFindUniqueMock = vi.hoisted(() => vi.fn())
const buildBillingInfoMock = vi.hoisted(() => vi.fn(() => null))

vi.mock('@/lib/model-capabilities/lookup', () => ({
  resolveBuiltinCapabilitiesByModelKey: capabilityMock,
}))
vi.mock('@/lib/api-auth', () => ({
  requireProjectAuthLight: vi.fn(async () => ({ session: { user: { id: 'user-1' } } })),
  isErrorResponse: vi.fn(() => false),
}))
vi.mock('@/lib/task/submitter', () => ({ submitTask: submitTaskMock }))
vi.mock('@/lib/billing', () => ({ buildDefaultTaskBillingInfo: buildBillingInfoMock }))
vi.mock('@/lib/task/has-output', () => ({ hasPanelVideoOutput: vi.fn(async () => false) }))
vi.mock('@/lib/task/resolve-locale', () => ({ resolveRequiredTaskLocale: vi.fn(() => 'zh') }))
vi.mock('@/lib/config-service', () => ({
  applyTrustedComfyVersionSnapshot: vi.fn((payload: Record<string, unknown>, versionId?: string | null) => {
    delete payload.comfyWorkflowVersionId
    if (versionId) payload.comfyWorkflowVersionId = versionId
    return payload
  }),
  getProjectModelConfig: getProjectModelConfigMock,
  resolveProjectComfyWorkflowVersion: vi.fn((config: {
    comfyImageWorkflowVersionId?: string | null
    comfyVideoWorkflowVersionId?: string | null
  }, _modelKey: string, mediaType: 'image' | 'video') => (
    mediaType === 'image'
      ? config.comfyImageWorkflowVersionId ?? null
      : config.comfyVideoWorkflowVersionId ?? null
  )),
  resolveTrustedComfyWorkflowVersion: vi.fn(async (_userId: string, model: string | null) => (
    model?.startsWith('comfyui::') ? 'video-version-1' : null
  )),
  resolveProjectModelCapabilityGenerationOptions: vi.fn(async () => ({})),
}))
vi.mock('@/lib/model-pricing/lookup', () => ({
  resolveBuiltinPricing: vi.fn(() => ({ status: 'resolved' })),
}))
vi.mock('@/lib/prisma', () => ({
  prisma: {
    novelPromotionPanel: {
      findMany: panelFindManyMock,
      findFirst: panelFindFirstMock,
      updateMany: panelUpdateManyMock,
    },
    novelPromotionStoryboard: { findMany: storyboardFindManyMock },
    comfyWorkflowVersion: { findFirst: comfyVersionFindFirstMock },
    userPreference: { findUnique: userPreferenceFindUniqueMock },
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
    panelFindFirstMock.mockReset()
    panelFindManyMock.mockReset()
    storyboardFindManyMock.mockReset()
    capabilityMock.mockReturnValue(undefined)
    panelFindFirstMock.mockResolvedValue({
      id: 'panel-1', updatedAt: new Date('2026-07-13T01:02:03.000Z'),
      hasDialogue: false, dialogueSpeaker: null, dialogueText: null, dialogueEmotion: null,
      includeDialogueInVideoPrompt: true, videoPrompt: 'server visual prompt', firstLastFramePrompt: null,
      estimatedDuration: 5, durationOverride: null, duration: 5,
      firstFrameSourceMeta: null, lastFrameSourceMeta: null,
      storyboard: { episodeId: 'episode-1' },
    })
    panelFindManyMock.mockResolvedValue([])
    storyboardFindManyMock.mockResolvedValue([])
    panelUpdateManyMock.mockResolvedValue({ count: 1 })
    comfyVersionFindFirstMock.mockResolvedValue({
      id: 'video-version-1',
      contentHash: 'video-content-hash',
      variableDefinitions: [
        { name: 'duration', type: 'number', required: true, options: [5, 10] },
        { name: 'firstFrame', type: 'image_ref', required: true },
        { name: 'lastFrame', type: 'image_ref', required: true },
      ],
      bindingSpec: [
        { nodeId: '1', inputPath: 'image', variable: 'firstFrame', valueType: 'image_ref' },
        { nodeId: '2', inputPath: 'image', variable: 'lastFrame', valueType: 'image_ref' },
      ],
    })
    userPreferenceFindUniqueMock.mockResolvedValue({
      customModels: JSON.stringify([
        { provider: 'cloud', modelId: 'normal', type: 'video' },
        { provider: 'cloud', modelId: 'dialogue', type: 'video' },
        { provider: 'cloud', modelId: 'unsupported', type: 'video' },
      ]),
      customProviders: JSON.stringify([{ id: 'cloud', apiKey: 'secret' }]),
    })
    getProjectModelConfigMock.mockImplementation(async (_projectId: string, _userId: string, overrides?: { videoModel?: string }) => ({
      videoModel: overrides?.videoModel ?? 'cloud::normal',
      dialogueVideoModel: null,
      comfyVideoWorkflowVersionId: overrides?.videoModel?.startsWith('comfyui::') ? 'video-version-1' : null,
    }))
  })

  it('uses the persisted manual last frame instead of forged client coordinates', async () => {
    panelFindFirstMock
      .mockResolvedValueOnce({
        id: 'panel-1', updatedAt: new Date('2026-07-13T01:02:03.000Z'),
        hasDialogue: false, dialogueSpeaker: null, dialogueText: null, dialogueEmotion: null,
        includeDialogueInVideoPrompt: true, videoPrompt: 'normal prompt', firstLastFramePrompt: 'first-last prompt',
        estimatedDuration: 5, durationOverride: null, duration: 5,
        firstFrameSourceMeta: null,
        lastFrameSourceMeta: JSON.stringify({ mode: 'manual', sourcePanelId: 'persisted-last-panel' }),
        storyboard: { episodeId: 'episode-1' },
      })
      .mockResolvedValueOnce({ id: 'persisted-last-panel' })
    const response = await POST(request({
      videoModel: 'cloud::normal',
      firstLastFrame: {
        flModel: 'comfyui::wf-video',
        lastFrameStoryboardId: 'forged-storyboard',
        lastFramePanelIndex: 999,
        customPrompt: 'FORGED',
        sourcePanelId: 'foreign-client-id',
      },
    }), { params: Promise.resolve({ projectId: 'project-1' }) })
    expect(response.status).toBe(200)
    expect(capabilityMock).not.toHaveBeenCalledWith('video', 'comfyui::wf-video')
    expect(submitTaskMock).toHaveBeenCalledTimes(1)
    expect(submitTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        videoModel: 'comfyui::wf-video',
        videoPrompt: 'first-last prompt',
        firstLastFrame: {
          flModel: 'comfyui::wf-video',
          firstFrameSourcePanelId: 'panel-1',
          sourcePanelId: 'persisted-last-panel',
        },
        comfyWorkflowVersionId: 'video-version-1',
        comfyModelSnapshotVersion: 1,
      }),
    }))
  })

  it('resolves a persisted manual first-frame source through owner scope before task submission', async () => {
    panelFindFirstMock
      .mockResolvedValueOnce({
        id: 'panel-1', updatedAt: new Date('2026-07-13T01:02:03.000Z'),
        hasDialogue: false, dialogueSpeaker: null, dialogueText: null, dialogueEmotion: null,
        includeDialogueInVideoPrompt: true, videoPrompt: 'normal prompt', firstLastFramePrompt: 'first-last prompt',
        estimatedDuration: 5, durationOverride: null, duration: 5,
        firstFrameSourceMeta: JSON.stringify({ mode: 'manual', sourcePanelId: 'manual-first-panel' }),
        lastFrameSourceMeta: JSON.stringify({ mode: 'manual', sourcePanelId: 'last-panel' }),
      })
      .mockResolvedValueOnce({ id: 'manual-first-panel' })
      .mockResolvedValueOnce({ id: 'last-panel' })

    const response = await POST(request({
      firstLastFrame: {
        flModel: 'comfyui::wf-video',
        lastFrameStoryboardId: 'storyboard-2',
        lastFramePanelIndex: 0,
        firstFrameSourcePanelId: 'forged-client-first',
      },
    }), { params: Promise.resolve({ projectId: 'project-1' }) })

    expect(response.status).toBe(200)
    expect(panelFindFirstMock).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: 'manual-first-panel',
        storyboard: { episode: { novelPromotionProject: {
          projectId: 'project-1', project: { userId: 'user-1' },
        } } },
      },
    }))
    expect(submitTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        firstLastFrame: {
          flModel: 'comfyui::wf-video',
          firstFrameSourcePanelId: 'manual-first-panel',
          sourcePanelId: 'last-panel',
        },
      }),
    }))
  })

  it('rejects a persisted last frame outside the authorized project before billing or submission', async () => {
    panelFindFirstMock
      .mockResolvedValueOnce({
        id: 'panel-1', updatedAt: new Date('2026-07-13T01:02:03.000Z'),
        hasDialogue: false, dialogueSpeaker: null, dialogueText: null, dialogueEmotion: null,
        includeDialogueInVideoPrompt: true, videoPrompt: 'normal prompt', firstLastFramePrompt: 'first-last prompt',
        estimatedDuration: 5, durationOverride: null, duration: 5,
        firstFrameSourceMeta: null,
        lastFrameSourceMeta: JSON.stringify({ mode: 'manual', sourcePanelId: 'foreign-panel' }),
        storyboard: { episodeId: 'episode-1' },
      })
      .mockResolvedValueOnce(null)

    const response = await POST(request({
      firstLastFrame: {
        flModel: 'comfyui::wf-video',
        lastFrameStoryboardId: 'forged-but-owned-storyboard',
        lastFramePanelIndex: 0,
      },
    }), { params: Promise.resolve({ projectId: 'project-1' }) })

    expect(response.status).toBe(400)
    expect(panelFindFirstMock).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: 'foreign-panel',
        storyboard: { episode: { novelPromotionProject: {
          projectId: 'project-1', project: { userId: 'user-1' },
        } } },
      }),
    }))
    expect(buildBillingInfoMock).not.toHaveBeenCalled()
    expect(submitTaskMock).not.toHaveBeenCalled()
  })

  it('rejects a persisted explicit last-frame clear before model lookup or submission', async () => {
    panelFindFirstMock.mockResolvedValueOnce({
      id: 'panel-1', updatedAt: new Date('2026-07-13T01:02:03.000Z'),
      hasDialogue: false, dialogueSpeaker: null, dialogueText: null, dialogueEmotion: null,
      includeDialogueInVideoPrompt: true, videoPrompt: 'normal prompt', firstLastFramePrompt: 'first-last prompt',
      estimatedDuration: 5, durationOverride: null, duration: 5,
      firstFrameSourceMeta: null, lastFrameSourceMeta: 'null',
      storyboard: { episodeId: 'episode-1' },
    })

    const response = await POST(request({
      firstLastFrame: {
        flModel: 'comfyui::wf-video',
        lastFrameStoryboardId: 'forged-storyboard',
        lastFramePanelIndex: 1,
      },
    }), { params: Promise.resolve({ projectId: 'project-1' }) })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'FIRSTLASTFRAME_SOURCE_INVALID' })
    expect(panelFindFirstMock).toHaveBeenCalledTimes(1)
    expect(storyboardFindManyMock).not.toHaveBeenCalled()
    expect(getProjectModelConfigMock).not.toHaveBeenCalled()
    expect(buildBillingInfoMock).not.toHaveBeenCalled()
    expect(submitTaskMock).not.toHaveBeenCalled()
  })

  it.each([null, '', '{invalid'])('resolves legacy last-frame metadata %j from the owner-scoped episode snapshot', async (lastFrameSourceMeta) => {
    panelFindFirstMock.mockResolvedValueOnce({
      id: 'panel-1', updatedAt: new Date('2026-07-13T01:02:03.000Z'),
      hasDialogue: false, dialogueSpeaker: null, dialogueText: null, dialogueEmotion: null,
      includeDialogueInVideoPrompt: true, videoPrompt: 'normal prompt', firstLastFramePrompt: 'first-last prompt',
      estimatedDuration: 5, durationOverride: null, duration: 5,
      firstFrameSourceMeta: null, lastFrameSourceMeta,
      storyboard: { episodeId: 'episode-1' },
    })
    storyboardFindManyMock.mockResolvedValueOnce([{
      id: 'storyboard-1', createdAt: new Date('2026-07-13T01:00:00Z'),
      clip: { createdAt: new Date('2026-07-13T01:00:00Z') },
      layoutMode: 'six_grid', groupSequence: 1,
      continuityAnchor: JSON.stringify({ sceneKey: 'office' }),
      panels: [
        {
          id: 'panel-1', storyboardId: 'storyboard-1', panelIndex: 0, gridCellIndex: 0,
          firstFrameSourceMeta: null, lastFrameSourceMeta, linkedToNextPanel: false,
        },
        {
          id: 'server-next-panel', storyboardId: 'storyboard-1', panelIndex: 1, gridCellIndex: 1,
          firstFrameSourceMeta: null, lastFrameSourceMeta: null, linkedToNextPanel: false,
        },
      ],
    }])

    const response = await POST(request({
      firstLastFrame: {
        flModel: 'comfyui::wf-video',
        lastFrameStoryboardId: 'forged-storyboard',
        lastFramePanelIndex: 99,
      },
    }), { params: Promise.resolve({ projectId: 'project-1' }) })

    expect(response.status).toBe(200)
    expect(storyboardFindManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        episodeId: 'episode-1',
        episode: { novelPromotionProject: {
          projectId: 'project-1', project: { userId: 'user-1' },
        } },
      }),
    }))
    expect(submitTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        firstLastFrame: {
          flModel: 'comfyui::wf-video',
          firstFrameSourcePanelId: 'panel-1',
          sourcePanelId: 'server-next-panel',
        },
      }),
    }))
  })

  it('uses firstLastFramePrompt for first-last-frame tasks and videoPrompt for normal tasks', async () => {
    const panel = {
      id: 'panel-1', updatedAt: new Date('2026-07-13T01:02:03.000Z'),
      hasDialogue: false, dialogueSpeaker: null, dialogueText: null, dialogueEmotion: null,
      includeDialogueInVideoPrompt: true, videoPrompt: 'NORMAL VISUAL PROMPT', firstLastFramePrompt: 'FIRST LAST VISUAL PROMPT',
      estimatedDuration: 5, durationOverride: null, duration: 5,
      lastFrameSourceMeta: JSON.stringify({ mode: 'manual', sourcePanelId: 'last-panel-1' }),
    }
    panelFindFirstMock
      .mockResolvedValueOnce(panel)
      .mockResolvedValueOnce({ id: 'last-panel-1' })
      .mockResolvedValueOnce(panel)

    const firstLastResponse = await POST(request({
      firstLastFrame: {
        flModel: 'comfyui::wf-video',
        lastFrameStoryboardId: 'storyboard-1',
        lastFramePanelIndex: 1,
      },
    }), { params: Promise.resolve({ projectId: 'project-1' }) })
    const normalResponse = await POST(request({ useProjectRouting: true }), {
      params: Promise.resolve({ projectId: 'project-1' }),
    })

    expect(firstLastResponse.status).toBe(200)
    expect(normalResponse.status).toBe(200)
    expect(submitTaskMock.mock.calls.map(([input]) => input.payload.videoPrompt)).toEqual([
      'FIRST LAST VISUAL PROMPT',
      'NORMAL VISUAL PROMPT',
    ])
  })

  it('continues rejecting unsupported cloud first-last-frame models', async () => {
    const response = await POST(request({
      videoModel: 'cloud::normal',
      firstLastFrame: { flModel: 'cloud::unsupported' },
    }), { params: Promise.resolve({ projectId: 'project-1' }) })
    expect(response.status).toBe(400)
    expect(submitTaskMock).not.toHaveBeenCalled()
  })

  it('rejects a ComfyUI first-last-frame model whose published contract lacks frame bindings', async () => {
    panelFindFirstMock
      .mockResolvedValueOnce({
        id: 'panel-1', updatedAt: new Date('2026-07-13T01:02:03.000Z'),
        hasDialogue: false, dialogueSpeaker: null, dialogueText: null, dialogueEmotion: null,
        includeDialogueInVideoPrompt: true, videoPrompt: 'first prompt', firstLastFramePrompt: null,
        estimatedDuration: 5, durationOverride: null, duration: 5,
        firstFrameSourceMeta: null,
        lastFrameSourceMeta: JSON.stringify({ mode: 'manual', sourcePanelId: 'last-panel' }),
        storyboard: { episodeId: 'episode-1' },
      })
      .mockResolvedValueOnce({ id: 'last-panel', videoPrompt: 'last prompt' })
    comfyVersionFindFirstMock.mockResolvedValueOnce({
      id: 'video-version-1', contentHash: 'video-content-hash',
      variableDefinitions: [
        { name: 'duration', type: 'number', required: true, options: [5, 10] },
        { name: 'firstFrame', type: 'image_ref', required: true },
      ],
      bindingSpec: [
        { nodeId: '1', inputPath: 'image', variable: 'firstFrame', valueType: 'image_ref' },
      ],
    })

    const response = await POST(request({
      firstLastFrame: {
        flModel: 'comfyui::wf-video',
        lastFrameStoryboardId: 'storyboard-1',
        lastFramePanelIndex: 1,
      },
    }), { params: Promise.resolve({ projectId: 'project-1' }) })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'FIRSTLASTFRAME_MODEL_UNSUPPORTED' })
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

  it('ignores forged client prompt and effective duration and snapshots server resolution', async () => {
    capabilityMock.mockReturnValue({ video: { durationOptions: [5, 10] } })
    panelFindFirstMock.mockResolvedValue({
      id: 'panel-1', updatedAt: new Date('2026-07-13T01:02:03.000Z'),
      hasDialogue: true, dialogueSpeaker: '阿青', dialogueText: '跟我走。', dialogueEmotion: '急切',
      includeDialogueInVideoPrompt: true, videoPrompt: '人物推开门',
      estimatedDuration: 7.2, durationOverride: null, duration: 7.2,
    })
    getProjectModelConfigMock.mockResolvedValue({
      videoModel: 'cloud::normal', dialogueVideoModel: 'cloud::dialogue', comfyVideoWorkflowVersionId: null,
    })

    const response = await POST(request({
      submittedPrompt: 'FORGED', effectiveDuration: 1, requestedDuration: 1,
    }), { params: Promise.resolve({ projectId: 'project-1' }) })

    expect(response.status).toBe(200)
    expect(submitTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        videoModel: 'cloud::dialogue',
        videoPrompt: expect.stringContaining('跟我走。'),
        requestedDuration: 7.2,
        effectiveDuration: 10,
        videoModelReason: 'dialogue_project_model',
      }),
    }))
  })

  it('builds an authoritative first-last-frame prompt and removes forged client prompts', async () => {
    panelFindFirstMock
      .mockResolvedValueOnce({
        id: 'panel-1', updatedAt: new Date('2026-07-13T01:02:03.000Z'),
        hasDialogue: false, dialogueSpeaker: null, dialogueText: null, dialogueEmotion: null,
        includeDialogueInVideoPrompt: true, videoPrompt: 'server visual prompt', firstLastFramePrompt: null,
        estimatedDuration: 5, durationOverride: null, duration: 5,
        firstFrameSourceMeta: null,
        lastFrameSourceMeta: JSON.stringify({ mode: 'manual', sourcePanelId: 'panel-2' }),
        storyboard: { episodeId: 'episode-1' },
      })
      .mockResolvedValueOnce({ id: 'panel-2', videoPrompt: 'last frame visual prompt' })
    const response = await POST(request({
      customPrompt: 'FORGED ROOT PROMPT',
      firstLastFrame: {
        flModel: 'comfyui::wf-video',
        customPrompt: 'FORGED FIRST LAST PROMPT',
      },
    }), { params: Promise.resolve({ projectId: 'project-1' }) })

    expect(response.status).toBe(200)
    const submitted = submitTaskMock.mock.calls[0]?.[0] as { payload: Record<string, unknown> }
    expect(submitted.payload.videoPrompt).toBe(
      'server visual prompt\n\n然后自然过渡到：last frame visual prompt',
    )
    expect(submitted.payload).not.toHaveProperty('customPrompt')
    expect(submitted.payload.firstLastFrame).toEqual({
      flModel: 'comfyui::wf-video', firstFrameSourcePanelId: 'panel-1', sourcePanelId: 'panel-2',
    })
  })

  it('routes each batch panel through dialogue-aware project models', async () => {
    panelFindManyMock.mockResolvedValue([
      {
        id: 'panel-dialogue', updatedAt: new Date('2026-07-13T01:02:03.000Z'),
        hasDialogue: true, dialogueSpeaker: '阿青', dialogueText: '跟我走。', dialogueEmotion: '急切',
        includeDialogueInVideoPrompt: true, videoPrompt: '人物推开门', firstLastFramePrompt: null,
        estimatedDuration: 5, durationOverride: null, duration: 5,
      },
      {
        id: 'panel-normal', updatedAt: new Date('2026-07-13T01:02:03.000Z'),
        hasDialogue: false, dialogueSpeaker: null, dialogueText: null, dialogueEmotion: null,
        includeDialogueInVideoPrompt: true, videoPrompt: '空镜扫过街道', firstLastFramePrompt: null,
        estimatedDuration: 5, durationOverride: null, duration: 5,
      },
    ])
    getProjectModelConfigMock.mockResolvedValue({
      videoModel: 'cloud::normal', dialogueVideoModel: 'cloud::dialogue', comfyVideoWorkflowVersionId: null,
    })

    const response = await POST(request({
      all: true,
      episodeId: 'episode-1',
      videoModel: 'cloud::normal',
      useProjectRouting: true,
    }), { params: Promise.resolve({ projectId: 'project-1' }) })

    expect(response.status).toBe(200)
    expect(submitTaskMock.mock.calls.map(([input]) => ({
      targetId: input.targetId,
      videoModel: input.payload.videoModel,
      reason: input.payload.videoModelReason,
    }))).toEqual([
      { targetId: 'panel-dialogue', videoModel: 'cloud::dialogue', reason: 'dialogue_project_model' },
      { targetId: 'panel-normal', videoModel: 'cloud::normal', reason: 'normal_project_model' },
    ])
  })

  it('ignores an injected explicitVideoModel for batch project routing', async () => {
    panelFindManyMock.mockResolvedValue([
      {
        id: 'panel-dialogue', updatedAt: new Date('2026-07-13T01:02:03.000Z'),
        hasDialogue: true, dialogueSpeaker: '阿青', dialogueText: '走。', dialogueEmotion: '急切',
        includeDialogueInVideoPrompt: true, videoPrompt: '人物转身', firstLastFramePrompt: '不应使用',
        estimatedDuration: 5, durationOverride: null, duration: 5,
      },
    ])
    getProjectModelConfigMock.mockResolvedValue({
      videoModel: 'cloud::normal', dialogueVideoModel: 'cloud::dialogue', comfyVideoWorkflowVersionId: null,
    })

    const response = await POST(request({
      all: true, episodeId: 'episode-1', useProjectRouting: true,
      videoModel: 'cloud::normal', explicitVideoModel: 'cloud::unsupported',
    }), { params: Promise.resolve({ projectId: 'project-1' }) })

    expect(response.status).toBe(200)
    const payload = submitTaskMock.mock.calls[0]?.[0].payload
    expect(payload).toMatchObject({ videoModel: 'cloud::dialogue', videoModelReason: 'dialogue_project_model' })
    expect(payload).not.toHaveProperty('explicitVideoModel')
  })

  it('ignores an injected firstLastFrame model for batch project routing', async () => {
    panelFindManyMock.mockResolvedValue([
      {
        id: 'panel-normal', updatedAt: new Date('2026-07-13T01:02:03.000Z'),
        hasDialogue: false, dialogueSpeaker: null, dialogueText: null, dialogueEmotion: null,
        includeDialogueInVideoPrompt: true, videoPrompt: '空镜', firstLastFramePrompt: '不应使用',
        estimatedDuration: 5, durationOverride: null, duration: 5,
      },
    ])
    getProjectModelConfigMock.mockResolvedValue({
      videoModel: 'cloud::normal', dialogueVideoModel: 'cloud::dialogue', comfyVideoWorkflowVersionId: null,
    })

    const response = await POST(request({
      all: true, episodeId: 'episode-1', useProjectRouting: true, videoModel: 'cloud::normal',
      firstLastFrame: { flModel: 'comfyui::wf-video', sourcePanelId: 'foreign-client-id' },
    }), { params: Promise.resolve({ projectId: 'project-1' }) })

    expect(response.status).toBe(200)
    const payload = submitTaskMock.mock.calls[0]?.[0].payload
    expect(payload).toMatchObject({ videoModel: 'cloud::normal', videoModelReason: 'normal_project_model' })
    expect(payload).not.toHaveProperty('firstLastFrame')
  })

  it('rejects stale duration override before submission and never mutates the estimate', async () => {
    panelUpdateManyMock.mockResolvedValue({ count: 0 })
    const response = await POST(request({
      durationOverride: 8,
      expectedPanelUpdatedAt: '2026-07-13T01:02:03.000Z',
    }), { params: Promise.resolve({ projectId: 'project-1' }) })

    expect(response.status).toBe(409)
    expect(panelUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      data: { durationOverride: 8 },
    }))
    expect((panelUpdateManyMock.mock.calls[0]?.[0] as { data: object }).data).not.toHaveProperty('estimatedDuration')
    expect(submitTaskMock).not.toHaveBeenCalled()
  })

  it('clears an override with null while preserving estimated duration', async () => {
    const response = await POST(request({
      durationOverride: null,
      expectedPanelUpdatedAt: '2026-07-13T01:02:03.000Z',
    }), { params: Promise.resolve({ projectId: 'project-1' }) })

    expect(response.status).toBe(200)
    expect(panelUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      data: { durationOverride: null },
    }))
    expect((panelUpdateManyMock.mock.calls[0]?.[0] as { data: object }).data).not.toHaveProperty('estimatedDuration')
  })

  it('does not let forged Comfy generationOptions define the duration contract', async () => {
    panelFindFirstMock.mockResolvedValue({
      id: 'panel-1', updatedAt: new Date('2026-07-13T01:02:03.000Z'),
      hasDialogue: false, dialogueSpeaker: null, dialogueText: null, dialogueEmotion: null,
      includeDialogueInVideoPrompt: true, videoPrompt: 'server prompt',
      estimatedDuration: 7.2, durationOverride: null, duration: 7.2,
    })
    const response = await POST(request({
      videoModel: 'comfyui::wf-video',
      generationOptions: { duration: 999 },
      effectiveDuration: 999,
    }), { params: Promise.resolve({ projectId: 'project-1' }) })

    expect(response.status).toBe(200)
    expect(submitTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        requestedDuration: 7.2,
        effectiveDuration: 10,
        generationOptions: expect.objectContaining({ duration: 10 }),
        comfyWorkflowVersionId: 'video-version-1',
      }),
    }))
  })

  it('uses the pinned native frame contract instead of legacy canonical options', async () => {
    comfyVersionFindFirstMock.mockResolvedValue({
      id: 'video-version-1',
      contentHash: 'video-content-hash',
      variableDefinitions: [{ name: 'duration', type: 'number', options: [10] }],
      bindingSpec: [{
        nodeId: 'timing', inputPath: 'length', variable: 'duration', valueType: 'number',
        numericTransform: {
          sourceUnit: 'seconds', targetUnit: 'frames', output: 'number',
          fps: { source: 'runtime_then_fallback', variable: 'fps', fallback: 16 },
          rounding: 'round', frameOffset: 1, allowedTargetValues: [81, 161],
        },
      }],
    })

    const response = await POST(request({ videoModel: 'comfyui::wf-video' }), {
      params: Promise.resolve({ projectId: 'project-1' }),
    })

    expect(response.status).toBe(200)
    expect(submitTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        requestedDuration: 5,
        effectiveDuration: 5,
        generationOptions: expect.objectContaining({ duration: 5 }),
      }),
    }))
  })

  it('normalizes a decimal-equal Comfy duration to the pinned canonical choice', async () => {
    panelFindFirstMock.mockResolvedValue({
      id: 'panel-1', updatedAt: new Date('2026-07-13T01:02:03.000Z'),
      hasDialogue: false, dialogueSpeaker: null, dialogueText: null, dialogueEmotion: null,
      includeDialogueInVideoPrompt: true, videoPrompt: 'server prompt',
      estimatedDuration: 5.000000000000001, durationOverride: null, duration: 5.000000000000001,
    })
    comfyVersionFindFirstMock.mockResolvedValue({
      id: 'video-version-1',
      contentHash: 'video-content-hash',
      variableDefinitions: [{ name: 'duration', type: 'number', options: [5, 10] }],
      bindingSpec: [{
        nodeId: 'timing', inputPath: 'length', variable: 'duration', valueType: 'number',
        numericTransform: {
          sourceUnit: 'seconds', targetUnit: 'frames', output: 'number',
          fps: { source: 'runtime_then_fallback', variable: 'fps', fallback: 16 },
          rounding: 'round', frameOffset: 1, allowedTargetValues: [81, 161],
        },
      }],
    })

    const response = await POST(request({ videoModel: 'comfyui::wf-video' }), {
      params: Promise.resolve({ projectId: 'project-1' }),
    })

    expect(response.status).toBe(200)
    expect(submitTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        requestedDuration: 5,
        effectiveDuration: 5,
        generationOptions: expect.objectContaining({ duration: 5 }),
      }),
    }))
  })

  it('rejects an unsupported Comfy duration exactly instead of snapping before billing', async () => {
    panelFindFirstMock.mockResolvedValue({
      id: 'panel-1', updatedAt: new Date('2026-07-13T01:02:03.000Z'),
      hasDialogue: false, dialogueSpeaker: null, dialogueText: null, dialogueEmotion: null,
      includeDialogueInVideoPrompt: true, videoPrompt: 'server prompt',
      estimatedDuration: 7.2, durationOverride: null, duration: 7.2,
    })
    comfyVersionFindFirstMock.mockResolvedValue({
      id: 'video-version-1',
      contentHash: 'video-content-hash',
      variableDefinitions: [{ name: 'duration', type: 'number', options: [5, 10] }],
      bindingSpec: [{
        nodeId: 'timing', inputPath: 'length', variable: 'duration', valueType: 'number',
        numericTransform: {
          sourceUnit: 'seconds', targetUnit: 'frames', output: 'number',
          fps: { source: 'runtime_then_fallback', variable: 'fps', fallback: 16 },
          rounding: 'round', frameOffset: 1, allowedTargetValues: [81, 161],
        },
      }],
    })

    const response = await POST(request({ videoModel: 'comfyui::wf-video' }), {
      params: Promise.resolve({ projectId: 'project-1' }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'VIDEO_DURATION_INVALID' })
    expect(buildBillingInfoMock).not.toHaveBeenCalled()
    expect(submitTaskMock).not.toHaveBeenCalled()
  })

  it.each(['duration_seconds', 'seconds'])(
    'rejects unsupported native %s duration aliases before billing or submission',
    async (durationVariable) => {
      panelFindFirstMock.mockResolvedValue({
        id: 'panel-1', updatedAt: new Date('2026-07-13T01:02:03.000Z'),
        hasDialogue: false, dialogueSpeaker: null, dialogueText: null, dialogueEmotion: null,
        includeDialogueInVideoPrompt: true, videoPrompt: 'server prompt',
        estimatedDuration: 7.2, durationOverride: null, duration: 7.2,
      })
      comfyVersionFindFirstMock.mockResolvedValue({
        id: 'video-version-1',
        contentHash: 'video-content-hash',
        variableDefinitions: [{ name: durationVariable, type: 'number', options: [5, 10] }],
        bindingSpec: [{
          nodeId: 'timing', inputPath: 'duration', variable: durationVariable, valueType: 'number',
          numericTransform: {
            sourceUnit: 'seconds', targetUnit: 'seconds', output: 'number',
            allowedTargetValues: [5, 10],
          },
        }],
      })

      const response = await POST(request({ videoModel: 'comfyui::wf-video' }), {
        params: Promise.resolve({ projectId: 'project-1' }),
      })

      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ code: 'VIDEO_DURATION_INVALID' })
      expect(buildBillingInfoMock).not.toHaveBeenCalled()
      expect(submitTaskMock).not.toHaveBeenCalled()
    },
  )

  it.each(['duration_seconds', 'seconds'])(
    'normalizes decimal-equal native %s duration aliases to the canonical choice',
    async (durationVariable) => {
      panelFindFirstMock.mockResolvedValue({
        id: 'panel-1', updatedAt: new Date('2026-07-13T01:02:03.000Z'),
        hasDialogue: false, dialogueSpeaker: null, dialogueText: null, dialogueEmotion: null,
        includeDialogueInVideoPrompt: true, videoPrompt: 'server prompt',
        estimatedDuration: 5.000000000000001, durationOverride: null, duration: 5.000000000000001,
      })
      comfyVersionFindFirstMock.mockResolvedValue({
        id: 'video-version-1',
        contentHash: 'video-content-hash',
        variableDefinitions: [{ name: durationVariable, type: 'number', options: [5, 10] }],
        bindingSpec: [{
          nodeId: 'timing', inputPath: 'duration', variable: durationVariable, valueType: 'number',
          numericTransform: {
            sourceUnit: 'seconds', targetUnit: 'seconds', output: 'number',
            allowedTargetValues: [5, 10],
          },
        }],
      })

      const response = await POST(request({ videoModel: 'comfyui::wf-video' }), {
        params: Promise.resolve({ projectId: 'project-1' }),
      })

      expect(response.status).toBe(200)
      expect(submitTaskMock).toHaveBeenCalledWith(expect.objectContaining({
        payload: expect.objectContaining({
          requestedDuration: 5,
          effectiveDuration: 5,
          generationOptions: expect.objectContaining({ duration: 5 }),
        }),
      }))
    },
  )

  it.each(['duration_seconds', 'seconds'])(
    'preserves ceiling behavior for legacy %s aliases without native choices',
    async (durationVariable) => {
      panelFindFirstMock.mockResolvedValue({
        id: 'panel-1', updatedAt: new Date('2026-07-13T01:02:03.000Z'),
        hasDialogue: false, dialogueSpeaker: null, dialogueText: null, dialogueEmotion: null,
        includeDialogueInVideoPrompt: true, videoPrompt: 'server prompt',
        estimatedDuration: 7.2, durationOverride: null, duration: 7.2,
      })
      comfyVersionFindFirstMock.mockResolvedValue({
        id: 'video-version-1',
        contentHash: 'video-content-hash',
        variableDefinitions: [{ name: durationVariable, type: 'number', options: [5, 10] }],
        bindingSpec: [],
      })

      const response = await POST(request({ videoModel: 'comfyui::wf-video' }), {
        params: Promise.resolve({ projectId: 'project-1' }),
      })

      expect(response.status).toBe(200)
      expect(submitTaskMock).toHaveBeenCalledWith(expect.objectContaining({
        payload: expect.objectContaining({
          requestedDuration: 7.2,
          effectiveDuration: 10,
          generationOptions: expect.objectContaining({ duration: 10 }),
        }),
      }))
    },
  )

  it('uses runtime FPS to expose the pinned native duration choice', async () => {
    comfyVersionFindFirstMock.mockResolvedValue({
      id: 'video-version-1',
      contentHash: 'video-content-hash',
      variableDefinitions: [{ name: 'duration', type: 'number', options: [7.5] }],
      bindingSpec: [{
        nodeId: 'timing', inputPath: 'length', variable: 'duration', valueType: 'number',
        numericTransform: {
          sourceUnit: 'seconds', targetUnit: 'frames', output: 'number',
          fps: { source: 'runtime_then_fallback', variable: 'fps', fallback: 16 },
          rounding: 'round', frameOffset: 1, allowedTargetValues: [121],
        },
      }],
    })

    const response = await POST(request({
      videoModel: 'comfyui::wf-video',
      generationOptions: { fps: 24 },
    }), { params: Promise.resolve({ projectId: 'project-1' }) })

    expect(response.status).toBe(200)
    expect(submitTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        effectiveDuration: 5,
        generationOptions: expect.objectContaining({ fps: 24, duration: 5 }),
      }),
    }))
  })

  it('blocks an unavailable configured dialogue model before billing submission', async () => {
    panelFindFirstMock.mockResolvedValue({
      id: 'panel-1', updatedAt: new Date('2026-07-13T01:02:03.000Z'),
      hasDialogue: true, dialogueSpeaker: '阿青', dialogueText: '走。', dialogueEmotion: '急切',
      includeDialogueInVideoPrompt: true, videoPrompt: '人物转身',
      estimatedDuration: 5, durationOverride: null, duration: 5,
    })
    getProjectModelConfigMock.mockResolvedValue({
      videoModel: 'cloud::normal', dialogueVideoModel: 'cloud::forbidden', comfyVideoWorkflowVersionId: null,
    })

    const response = await POST(request({ useProjectRouting: true, videoModel: 'cloud::normal' }), {
      params: Promise.resolve({ projectId: 'project-1' }),
    })

    expect(response.status).toBe(400)
    expect(submitTaskMock).not.toHaveBeenCalled()
  })
})
